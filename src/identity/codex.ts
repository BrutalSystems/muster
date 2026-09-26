/** Lock-reading mechanics vendored from Tin Can src/codex/cli.ts at
 * fbaaea5842fd4a5c86849d7f51c8e16b8683b058 (MIT); descendant traversal replaces
 * ancestor lookup from src/codex/self.ts at that commit. */
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { command, descendants } from "./processes.js";
export async function resolveCodex(
  root: number,
  env: NodeJS.ProcessEnv,
  deadline: number,
  rejectionOf?: (id: string) => Promise<string | null>,
): Promise<{ id: string; pid: number } | undefined> {
  let dir = join(
    env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex"),
    "thread-writer-locks",
  );
  try {
    dir = await realpath(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  let names: string[];
  try {
    names = (await readdir(dir)).filter((s) => /^[a-zA-Z0-9-]+\.lock$/.test(s));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (!names.length) return;
  // One lsof invocation, rather than one invocation for every historical lock.
  let out: string;
  try {
    out = await command(
      "lsof",
      ["-Fpn", ...names.map((s) => join(dir, s))],
      Math.max(1, Math.min(1000, deadline - Date.now())),
    );
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? "";
  }
  // Snapshot the family after lsof, not before: a lock holder that spawns
  // during discovery is absent from an earlier snapshot, costing a whole pass.
  const family = new Set(await descendants(root, deadline));
  let pid = 0;
  const matches = new Map<string, number>();
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    if (line.startsWith("n") && family.has(pid)) {
      const path = line.slice(1);
      if (path.startsWith(dir + "/") && path.endsWith(".lock"))
        matches.set(path.slice(dir.length + 1, -5), pid);
    }
  }
  let candidates = [...matches];
  if (candidates.length && rejectionOf) {
    // Auto-review owns internal threads in the same process. Inspect only
    // identities already tied to our descendants; never diff global sessions.
    // Screening the sole candidate too costs one extra round trip, and buys the
    // reason a lock cannot be messaged: returning the thread and letting
    // readiness reject it puts that reason after the launch deadline, where the
    // loop discards it (#20). Raised here it becomes the diagnostic, and a
    // later pass can still find a messageable thread.
    const selected: typeof candidates = [];
    let rejection: string | undefined;
    for (const candidate of candidates) {
      const reason = await rejectionOf(candidate[0]);
      if (reason === null) selected.push(candidate);
      else rejection ??= reason;
    }
    if (!selected.length) throw new Error(rejection!);
    candidates = selected;
  }
  if (candidates.length > 1)
    throw new Error(
      "Multiple Codex CLI writer locks held by launched descendants",
    );
  const first = candidates[0];
  return first ? { id: first[0], pid: first[1] } : undefined;
}
