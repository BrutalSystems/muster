/**
 * Process identity on macOS.
 *
 * A launched process is identified by `(pid, start time)`. That pair is the
 * ceiling of what this platform offers a supervisor, not a shortcut taken to
 * avoid something better: there is no cgroup to own a tree, the kernel's unique
 * process identifier is absent from the public SDK, and `audit_token` requires
 * a message from the target that arbitrary children never send.
 *
 * Two rules follow, and both look like wasted work if the reason is not stated:
 *
 * 1. Revalidate at the moment of use, never at discovery. The gap between
 *    learning a pid and acting on it is where reuse happens, so `isSame()` is
 *    called immediately before each signal rather than once per operation.
 * 2. Revalidation survives our own restart. The registry re-checks generations
 *    on every transaction, so a process that died while Muster was not running
 *    is reported as dead rather than trusted from what was recorded.
 *
 * Membership is the union of the parent chain and the process group the root
 * leads, because a reparented child leaves the chain but keeps its group.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export type ProcessRef = { pid: number; start: string };
export const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function command(
  file: string,
  args: string[],
  timeout = 1000,
): Promise<string> {
  return (await exec(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }))
    .stdout;
}
export async function processRef(pid: number): Promise<ProcessRef | undefined> {
  try {
    const out = (
      await command("ps", ["-p", String(pid), "-o", "lstart=,stat="])
    ).trim();
    if (!out || /\bZ\S*$/.test(out)) return;
    return { pid, start: out.slice(0, 24) };
  } catch {
    return;
  }
}
export async function isSame(ref: ProcessRef): Promise<boolean> {
  return (await processRef(ref.pid))?.start === ref.start;
}
/**
 * The process group a pid leads, or undefined if it leads none.
 *
 * Only a leader's group is safe to treat as membership: the group then exists
 * because this process was started, so everything in it descends from that
 * start. A process that merely belongs to someone else's group shares it with
 * whatever else is there — a shell, a tmux pane, the terminal — and sweeping
 * that would reach far outside the session.
 *
 * Both terminal hosts start their root in a new session, so in practice the
 * launched root does lead its own group.
 */
export async function ownedGroup(pid: number): Promise<number | undefined> {
  try {
    const pgid = Number(
      (await command("ps", ["-p", String(pid), "-o", "pgid="])).trim(),
    );
    return pgid === pid ? pgid : undefined;
  } catch {
    return undefined;
  }
}
/**
 * Membership by two signals, because neither is sufficient alone.
 *
 * The parent chain is exact while it holds, and it stops holding the moment an
 * intermediate process exits: the children reparent to launchd and are no
 * longer reachable from the root, though they are still running the session's
 * work. The process group survives that — reparenting changes no pid's group —
 * but is only meaningful for a group the root leads, and is escapable by a
 * process that calls setsid() for itself.
 *
 * So: union them. What the chain loses to reparenting, the group usually keeps.
 */
export async function descendants(
  root: number,
  deadline = Date.now() + 1000,
  group?: number,
): Promise<number[]> {
  const rows = (
    await command(
      "ps",
      ["-axo", "pid=,ppid=,pgid="],
      Math.max(1, Math.min(1000, deadline - Date.now())),
    )
  )
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number));
  const found = new Set<number>([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, parent] of rows)
      if (pid && parent && found.has(parent) && !found.has(pid)) {
        found.add(pid);
        changed = true;
      }
  }
  if (group)
    for (const [pid, , pgid] of rows)
      if (pid && pid > 1 && pgid === group) found.add(pid);
  return [...found];
}
/** Whether anything still runs in a group we started. */
export async function groupAlive(
  group: number,
  deadline = Date.now() + 1000,
): Promise<boolean> {
  try {
    const rows = (
      await command(
        "ps",
        ["-axo", "pid=,pgid="],
        Math.max(1, Math.min(1000, deadline - Date.now())),
      )
    )
      .split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number));
    return rows.some(([pid, pgid]) => pid && pid > 1 && pgid === group);
  } catch {
    return false;
  }
}
async function liveTree(root: number, group?: number): Promise<ProcessRef[]> {
  return (
    await Promise.all(
      (await descendants(root, Date.now() + 1000, group)).map(processRef),
    )
  ).filter((r): r is ProcessRef => !!r);
}

function signal(ref: ProcessRef, name: "SIGTERM" | "SIGKILL") {
  try {
    process.kill(ref.pid, name);
  } catch {}
}

/**
 * A tree enumerated once, before the wait between SIGTERM and SIGKILL, cannot
 * contain anything the tree forked during that wait — and a process asked to
 * terminate is exactly the kind that spawns a last child. So the membership is
 * re-read after the wait and unioned with what was already known, and only then
 * is the kill pass run. Each entry is still revalidated immediately before
 * every signal, because a pid that exits between discovery and the signal may
 * already belong to something else.
 *
 * Reparented descendants are reachable only through the process group, so pass
 * one when the caller has recorded it; the parent chain alone cannot see them.
 */
/**
 * Signals a process tree dead: SIGTERM deepest-first, a grace period, a second
 * pass for anything forked during it, then SIGKILL.
 *
 * Resolves once the signals are SENT, not once the processes are gone. SIGKILL
 * is asynchronous, so a pid may still be in the process table when this returns
 * — callers that need the stronger guarantee have to poll. Nothing does today:
 * `stop` marks the entry stopped, and `refreshed` re-probes only entries still
 * marked running, so the window cannot flip a stopped session back to alive.
 */
export async function stopTree(ref: ProcessRef, group?: number): Promise<void> {
  if (!(await isSame(ref))) return;
  const known = new Map<string, ProcessRef>();
  const remember = (refs: ProcessRef[]) => {
    const added: ProcessRef[] = [];
    for (const r of refs) {
      const key = `${r.pid}:${r.start}`;
      if (!known.has(key)) {
        known.set(key, r);
        added.push(r);
      }
    }
    return added;
  };
  const deepestFirst = () => [...known.values()].reverse();

  remember(await liveTree(ref.pid, group));
  for (const r of deepestFirst()) if (await isSame(r)) signal(r, "SIGTERM");
  await delay(150);

  const late = remember(
    (await isSame(ref)) || group ? await liveTree(ref.pid, group) : [],
  );
  if (late.length) {
    for (const r of late.reverse()) if (await isSame(r)) signal(r, "SIGTERM");
    await delay(50);
  }

  for (const r of deepestFirst()) if (await isSame(r)) signal(r, "SIGKILL");
}

// Called only by a terminal/task supervisor that is the leader of its own group.
// Keeping the supervisor alive until this point prevents process-group ID reuse.
export async function finishOwnedGroup(code: number): Promise<never> {
  const group = Number(
    (await command("ps", ["-p", String(process.pid), "-o", "pgid="])).trim(),
  );
  if (group === process.pid) {
    process.kill(-group, "SIGKILL");
  }
  const ref = await processRef(process.pid);
  if (ref)
    for (const pid of (await descendants(ref.pid)).filter(
      (p) => p !== ref.pid,
    )) {
      const child = await processRef(pid);
      if (child) await stopTree(child);
    }
  process.exit(code);
}
