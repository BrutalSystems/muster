import { test, expect } from "vitest";
import { PtyHost } from "../src/hosts/pty.js";
import { resolveCodex } from "../src/identity/codex.js";
import { threadRejection } from "../src/reach/codex.js";
import { CodexRpc } from "../src/codex-rpc.js";
import { resolveClaude } from "../src/identity/claude.js";
import { delay } from "../src/identity/processes.js";
import { fixture } from "./helpers.js";
import { ampleDeadline } from "./deadline.js";
for (const runtime of ["codex", "claude"] as const)
  test(`${runtime} associates concurrent nested descendants without diffing`, async () => {
    const f = await fixture({ MUSTER_FAKE_NEST: "2" }),
      host = new PtyHost();
    const launched = await Promise.all(
      ["one", "two", "unrelated"].map((prompt) =>
        host.launch({
          argv: [f.bin + "/" + runtime, "--", prompt],
          cwd: f.root,
          env: f.env,
          label: prompt,
        }),
      ),
    );
    try {
      const resolve = runtime === "codex" ? resolveCodex : resolveClaude;
      let ids: any[] = [];
      for (let i = 0; i < 30; i++) {
        ids = await Promise.all(
          launched.map((l) => resolve(l.pid, f.env, Date.now() + 2000)),
        );
        if (ids.every(Boolean)) break;
        await delay(100);
      }
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids.map((x) => x.id)).size).toBe(3);
      if (runtime === "claude")
        expect(ids.map((x) => x.rawName)).toEqual(["one", "two", "unrelated"]);
      expect(ids.every((x, i) => x.pid !== launched[i]!.pid)).toBe(true);
    } finally {
      await Promise.all(launched.map((l) => host.stop(l.hostRef)));
    }
  }, 15000);

test("Codex fake holds a genuine OS writer lock", async () => {
  const f = await fixture(),
    host = new PtyHost();
  const launched = await host.launch({
    argv: [f.bin + "/codex", "--", "lock check"],
    cwd: f.root,
    env: f.env,
    label: "lock",
  });
  try {
    let id;
    for (let i = 0; i < 40; i++) {
      id = await resolveCodex(launched.pid, f.env, ampleDeadline());
      if (id) break;
      await delay(50);
    }
    expect(id).toBeDefined();
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await expect(
      promisify(execFile)("python3", [
        "-c",
        'import fcntl,sys; f=open(sys.argv[1],"a"); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)',
        f.env.CODEX_HOME + "/thread-writer-locks/" + id!.id + ".lock",
      ]),
    ).rejects.toThrow();
  } finally {
    await host.stop(launched.hostRef);
  }
}, 10000);

test("a lock whose only thread cannot be messaged resolves to the reason", async () => {
  const f = await fixture({ MUSTER_FAKE_SOURCE: "exec" }),
    host = new PtyHost();
  const rpc = new CodexRpc(f.env, f.root);
  const launched = await host.launch({
    argv: [f.bin + "/codex", "--", "exec source"],
    cwd: f.root,
    env: f.env,
    label: "exec source",
  });
  try {
    // Bounded by wall clock, not by a count of attempts. The condition needs
    // five of the forty attempts this loop used to allow, measured over eight
    // runs — ample at rest, and still exhausted when `npm run check` runs 58
    // test files at once and this process gets a fraction of a core. A budget
    // in seconds degrades with the machine; a budget in attempts does not, and
    // a gate that goes red at random teaches people to re-run rather than look.
    // Eight seconds against the test's own 15s, leaving room for the fixture
    // and teardown either side.
    const until = Date.now() + 8000;
    let thrown: unknown;
    do {
      const deadline = ampleDeadline();
      thrown = await resolveCodex(launched.pid, f.env, deadline, async (id) => {
        const { thread } = await rpc.call(
          "thread/read",
          { threadId: id },
          deadline,
        );
        return threadRejection(thread, id);
      }).then(
        (id) => id,
        (e) => e,
      );
      if (thrown instanceof Error) break;
      await delay(50);
    } while (Date.now() < until);
    // Not swallowed into "no identity found": the launch loop stores this as
    // its diagnostic, so the reason survives the deadline rather than being
    // discarded when readiness raises it too late (#20).
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/source is exec/);
  } finally {
    await rpc.close();
    await host.stop(launched.hostRef);
  }
}, 15000);
