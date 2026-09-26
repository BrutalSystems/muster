import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
/**
 * Remove everything one run of the suite created: the tmux server its launches
 * landed on, and the root its fixtures built their workspaces under.
 *
 * Killing the server is what reclaims the processes. `close()` stops only `pty`
 * entries — a tmux launch is documented to survive its parent exiting — so the
 * host bootstrap, the fake runtime and the `flock` holder in every fixture
 * session are alive when the suite ends and nothing else will ever reap them
 * (#57). Because the server is this run's alone, killing it wholesale cannot
 * reach a developer's real sessions, which is what made cleanup unsafe before.
 */
/**
 * The tmux server every fixture launch lands on. Never "muster": that is the
 * server real launches use, and `close()` deliberately leaves tmux sessions
 * running, so anything the suite starts there stays there (#57). The fallback
 * keeps a directly-invoked file isolated too, though then nothing reaps it.
 */
export const TMUX_SERVER =
  process.env.MUSTER_TEST_TMUX_SERVER ?? `muster-test-${process.pid}`;
/**
 * A server of its own for a test that cannot share one — it asserts on what a
 * server contains, or it kills it. Derived from the run's name so `reap` finds
 * it: a name of its own invention would be reaped by nothing, which is how 737
 * dead sockets accumulated under three UUID-named servers in `tmux.test.ts`.
 */
export const testServer = (suffix: string) => `${TMUX_SERVER}-${suffix}`;
export async function reap(id: string, root: string) {
  const dir = join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${userInfo().uid}`);
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter(
      (name) => name === id || name.startsWith(id + "-"),
    );
  } catch {
    // No socket directory means tmux never ran. Nothing to reap.
  }
  for (const name of names) {
    try {
      await run("tmux", ["-L", name, "-f", "/dev/null", "kill-server"]);
    } catch {
      // Already gone, or never had a server. Either is success.
    }
    // `kill-server` does not unlink the socket, which is why a suite that
    // names a server per run accumulates dead files even when it cleans up.
    await rm(join(dir, name), { force: true });
  }
  await rm(root, { recursive: true, force: true });
}
/**
 * Runs in the main process before any worker exists, so the names it chooses
 * reach every worker through the environment and teardown still knows them
 * after the workers are gone. A per-run name also bounds the damage when
 * teardown does not run at all — one stale server, not hundreds of sessions on
 * the developer's.
 */
export default async function setup() {
  const id = `muster-test-${process.pid}-${randomBytes(3).toString("hex")}`,
    root = join(tmpdir(), id);
  await mkdir(root, { recursive: true });
  process.env.MUSTER_TEST_TMUX_SERVER = id;
  process.env.MUSTER_TEST_ROOT = root;
  // `os.tmpdir()` reads this on every call, so redirecting it here catches the
  // ninety-odd `mkdtemp(join(tmpdir(), …))` calls scattered through the suite
  // and the ones the production code under test makes, without touching a
  // single call site or leaving the next one to remember. tmux is unaffected:
  // it locates its sockets through TMUX_TMPDIR, not TMPDIR.
  const inherited = process.env.TMPDIR;
  process.env.TMPDIR = root;
  return async () => {
    // Put TMPDIR back before the root goes away: whatever the runner does after
    // teardown should not be pointed at a directory that no longer exists.
    if (inherited === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = inherited;
    await reap(id, root);
  };
}
