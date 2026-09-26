import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, realpath } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fixture } from "./helpers.js";
import { asSession } from "./narrow.js";
import { reap } from "./global-setup.js";
import { Muster } from "../src/run.js";
const execFileAsync = promisify(execFile);

/**
 * #57. The suite's own launches must not land on the tmux server real launches
 * use. `hosts()` defaults the server name to "muster" and `close()` deliberately
 * leaves tmux sessions running, so a fixture that does not override the drivers
 * puts a live session on the developer's production socket where nothing will
 * ever reap it. This asserts the isolation at the one place it is observable
 * from outside: the attach hint names the server the session is actually on.
 */
test("a fixture launch never lands on the production tmux server", async () => {
  const f = await fixture();
  const m = await Muster.create({ home: f.home, env: f.env });
  const peer = asSession(
    await m.run({
      runtime: "codex",
      prompt: "suite isolation",
      cwd: f.root,
      host: "tmux",
    }),
  );
  try {
    expect(peer.kind).toBe("session");
    expect(peer.host).toBe("tmux");
    expect(peer.attach_hint).not.toMatch(/^tmux -L muster attach-session/);
  } finally {
    await m.stop(peer.canonical_id);
    await m.close();
  }
}, 15000);

/**
 * The other half of #57: a per-run server is only an improvement if something
 * reaps it. `reap` is what the global setup returns as its teardown, exercised
 * here against throwaway servers and a throwaway root so the assertion is real
 * rather than a claim about code that only ever runs after the suite finished.
 *
 * It must reach every server the run named, not just the shared one — the tests
 * that need a server to themselves derive the name from the run id — and it
 * must unlink the sockets, because `kill-server` leaves the file behind. That
 * is measurable: 789 dead sockets had accumulated on this machine, 737 of them
 * from three `tmux.test.ts` servers that name themselves with a fresh UUID
 * every run, two of which already called `kill-server` and leaked anyway.
 */
test("the run's teardown reaps every server the run named, their sockets and its root", async () => {
  const id = "muster-test-reap-" + process.pid;
  const derived = id + "-derived";
  const root = await mkdtemp(join(tmpdir(), "mu-reap-"));
  for (const server of [id, derived])
    await execFileAsync("tmux", [
      "-L",
      server,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "victim",
      "sleep 60",
    ]);
  await mkdtemp(join(root, "mu-"));
  expect(await serverRunning(id)).toBe(true);
  expect(await serverRunning(derived)).toBe(true);

  await reap(id, root);

  expect(await serverRunning(id)).toBe(false);
  expect(await serverRunning(derived)).toBe(false);
  expect(await sockets(id)).toEqual([]);
  expect(existsSync(root)).toBe(false);
}, 20000);

async function sockets(prefix: string) {
  const dir = join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${userInfo().uid}`);
  try {
    return (await readdir(dir)).filter((name) => name.startsWith(prefix));
  } catch {
    return [];
  }
}
async function serverRunning(server: string) {
  try {
    await execFileAsync("tmux", [
      "-L",
      server,
      "-f",
      "/dev/null",
      "list-sessions",
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The fixtures are not the only thing that writes to the temp directory: some
 * ninety `mkdtemp(join(tmpdir(), …))` calls are scattered across two dozen test
 * files, and one gate run left 124 of those directories behind. Rewriting every
 * call site would work and would rot — the next test to call `tmpdir()` leaks
 * again. `os.tmpdir()` reads TMPDIR on each call, so redirecting it once for the
 * run puts every such directory, written by any test or by the production code
 * under test, inside the root teardown removes wholesale (#57).
 */
test("a temp directory made the ordinary way lands inside the run's root", async () => {
  const root = process.env.MUSTER_TEST_ROOT;
  expect(root).toBeTruthy();

  const made = await mkdtemp(join(tmpdir(), "mu-probe-"));

  expect(await realpath(made)).toMatch(
    new RegExp(
      "^" + (await realpath(root!)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
  );
});
