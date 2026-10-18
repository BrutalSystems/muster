import { join } from "node:path";
import { Registry, type Entry } from "./registry.js";
import type { SessionState } from "./hosts/tmux.js";

/**
 * Where the reaper's tmux jobs write their output, under muster's home. Not
 * launches.jsonl: that is one JSON event per line, and raw shell output would
 * break every reader of it.
 */
export function reapLog(home: string): string {
  return join(home, "reap.log");
}
export type ReapDecision =
  | { action: "reap" }
  | { action: "rearm"; seconds: number }
  | { action: "stop" };

// The floor is low so a short limit is honoured rather than rounded up: a 45s
// ttl behind a 30s floor fires at up to 75s. A session with a limit that short
// does not live long enough for the extra polls to matter.
const MIN_POLL = 5,
  MAX_POLL = 300;

/**
 * Derived from the SHORTER active expiry: a 4h idle timeout paired with a 2m
 * ttl must not poll on the 4h scale, or the ttl overshoots by minutes.
 */
export function pollInterval(lifecycle: {
  idleTimeout: number | null;
  ttl: number | null;
}): number {
  const limits = [lifecycle.idleTimeout, lifecycle.ttl].filter(
    (v): v is number => typeof v === "number",
  );
  if (!limits.length) return MAX_POLL;
  return Math.min(
    MAX_POLL,
    Math.max(MIN_POLL, Math.floor(Math.min(...limits) / 6)),
  );
}

/**
 * `stop` means stop polling and leave the session alone; `reap` means stop the
 * session. An entry with no recorded lifecycle — one written before the field
 * existed — decides nothing, because absent must never read as zero.
 */
export function decide(
  entry: Pick<Entry, "idleTimeout" | "ttl" | "status">,
  state: SessionState | null,
): ReapDecision {
  // Only TERMINAL statuses stop the chain. `starting` is what every healthy
  // launch is when the job is first armed, and `unknown` is a diagnosis in
  // progress, not a death — treating either as terminal loses the reaper.
  if (["stopped", "exited", "failed"].includes(entry.status))
    return { action: "stop" };
  const idleTimeout = entry.idleTimeout ?? null,
    ttl = entry.ttl ?? null;
  if (idleTimeout === null && ttl === null) return { action: "stop" };
  // The window is gone: something else already ended it, and re-arming would
  // leave a job polling a session that does not exist.
  if (!state) return { action: "stop" };
  const seconds = pollInterval({ idleTimeout, ttl });
  // Checked before either expiry: killing a session someone is looking at is
  // the worst thing this feature could do.
  if (state.attached) return { action: "rearm", seconds };
  if (idleTimeout !== null && state.idle >= idleTimeout)
    return { action: "reap" };
  if (ttl !== null && state.age >= ttl) return { action: "reap" };
  return { action: "rearm", seconds };
}

export type ReapOptions = {
  home: string;
  socket: string;
  launchId: string;
  argv: string[];
  /** Set on the detached child that performs the stop. See `reapCheck`. */
  stopNow?: boolean;
  /** Injected by tests; production reads real tmux and a real registry. */
  state?: SessionState | null;
  readEntries?: () => Promise<Entry[]> | Entry[];
  schedule?: (seconds: number, argv: string[], log: string) => Promise<void>;
  spawn?: (exec: string, args: string[]) => void;
};

/**
 * One poll, run as a detached tmux job.
 *
 * The stop is handed to a SEPARATE detached process rather than performed
 * here, and that is the whole point: this job is a child of the tmux server,
 * and stopping the last session on that server makes the server exit and take
 * this process with it — mid-stop. What is lost is everything after the
 * process-tree teardown: the `status: "stopped"` write, the launch-log event,
 * and the removal of the per-launch identity copy, which holds a copied
 * credential. The row is then swept to `exited` by the registry's own liveness
 * check, so it even looks like a crash rather than a reap.
 */
export async function reapCheck(opts: ReapOptions): Promise<ReapDecision> {
  const rearm = async (seconds: number): Promise<ReapDecision> => {
    const schedule =
      opts.schedule ??
      (async (s: number, argv: string[], log: string) => {
        const { TmuxHost } = await import("./hosts/tmux.js");
        await new TmuxHost(opts.socket).schedule(s, argv, log);
      });
    await schedule(seconds, opts.argv, reapLog(opts.home));
    return { action: "rearm", seconds };
  };
  try {
    if (opts.stopNow) {
      await stopSession(opts.home, opts.socket, opts.launchId);
      return { action: "reap" };
    }
    const entries = await (opts.readEntries
      ? opts.readEntries()
      : new Registry(opts.home).all());
    const entry = entries.find((e) => e.launchId === opts.launchId);
    if (!entry || !entry.hostRef) return { action: "stop" };
    const state =
      opts.state !== undefined
        ? opts.state
        : await (async () => {
            const { TmuxHost } = await import("./hosts/tmux.js");
            return new TmuxHost(opts.socket).sessionState(entry.hostRef!);
          })();
    const decision = decide(entry, state);
    if (decision.action === "rearm") return await rearm(decision.seconds);
    if (decision.action === "reap") {
      const [exec, script] = opts.argv;
      if (!exec || !script) return { action: "stop" };
      const spawnFn =
        opts.spawn ??
        ((e: string, args: string[]) => {
          // Detached and unref'd so it survives the tmux server exiting as the
          // session it is stopping goes away.
          // Its output goes to the reap log too: with stdio ignored, a stop
          // that failed left no trace anywhere.
          void Promise.all([
            import("node:child_process"),
            import("node:fs"),
          ]).then(([{ spawn }, { openSync, closeSync }]) => {
            let out: number | "ignore" = "ignore";
            try {
              out = openSync(reapLog(opts.home), "a", 0o600);
            } catch {}
            spawn(e, args, {
              detached: true,
              stdio: ["ignore", out, out],
            }).unref();
            if (out !== "ignore") closeSync(out);
          });
        });
      spawnFn(exec, [...opts.argv.slice(1), "--stop-now"]);
    }
    return decision;
  } catch {
    // A transient failure — a registry lock collision, a momentarily
    // unreadable config — must not permanently disarm the session. Only a
    // decision that means stop, stops. If even re-arming fails, there is
    // nothing left to try.
    try {
      return await rearm(MAX_POLL);
    } catch {
      return { action: "stop" };
    }
  }
}

async function stopSession(home: string, socket: string, launchId: string) {
  const { TmuxHost } = await import("./hosts/tmux.js");
  const { Muster } = await import("./run.js");
  // The socket is passed explicitly: Muster.create() would otherwise build its
  // drivers from MUSTER_TMUX_SERVER, and a mismatch makes stopEntry find no
  // matching hostRef and fall through to killing the process tree blind. The
  // whole reason --socket exists is that the registry records a window id, not
  // the socket it lives on.
  const muster = await Muster.create({
    home,
    drivers: [new TmuxHost(socket)],
  });
  try {
    const entry = (await new Registry(home).all()).find(
      (e) => e.launchId === launchId,
    );
    // By launch id: since --resume, the durable id may name a newer launch of
    // the same session, which this check was not armed for.
    if (entry) await muster.stop(entry.launchId);
  } finally {
    await muster.close();
  }
}
