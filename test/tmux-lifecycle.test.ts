import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  parseSessionState,
  SESSION_STATE_FORMAT,
  TmuxHost,
  tmuxCommand,
} from "../src/hosts/tmux.js";
import { Muster } from "../src/run.js";
import { Registry } from "../src/registry.js";
import { delay } from "../src/identity/processes.js";
import { fixture } from "./helpers.js";
import { asSession } from "./narrow.js";
import { testServer } from "./global-setup.js";

test("the format asks tmux for window activity, not session activity", () => {
  // session_activity is frozen at creation for a detached session, and every
  // muster session is detached. Getting this wrong reaps live sessions.
  expect(SESSION_STATE_FORMAT).toContain("#{window_activity}");
  expect(SESSION_STATE_FORMAT).not.toContain("#{session_activity}");
});

test("parses idle, age and attached from a tmux row", () => {
  // window_activity, session_created, session_attached — three fields, matching
  // SESSION_STATE_FORMAT. `now` is the second argument, not a fourth column.
  expect(parseSessionState("940|700|0", 1000)).toEqual({
    idle: 60,
    age: 300,
    attached: false,
  });
});

test("a non-zero attached count reads as attached", () => {
  expect(parseSessionState("940|700|1", 1000)?.attached).toBe(true);
});

test("an unparseable row is null rather than a guess at zero", () => {
  // Zero would read as "idle forever" and reap on the next poll.
  expect(parseSessionState("", 1000)).toBeNull();
  expect(parseSessionState("nonsense", 1000)).toBeNull();
});

test("a tmux session reports its own idleness and can be scheduled against", async () => {
  const host = new TmuxHost(testServer("lifecycle"));
  const { hostRef } = await host.launch({
    argv: ["sleep", "60"],
    cwd: tmpdir(),
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      LANG: "en_US.UTF-8",
    },
    label: "lifecycle-probe",
  });
  try {
    const state = await host.sessionState(hostRef);
    expect(state).not.toBeNull();
    expect(state!.attached).toBe(false);
    expect(state!.idle).toBeGreaterThanOrEqual(0);
    expect(state!.age).toBeGreaterThanOrEqual(0);

    // The scheduled job runs inside the tmux server, with no muster process
    // alive between the call and the job firing.
    const marker = join(
      await mkdtemp(join(tmpdir(), "muster-sched-")),
      "fired",
    );
    await host.schedule(1, ["/bin/sh", "-c", `echo yes > ${marker}`]);
    for (let i = 0; i < 40; i++) {
      if (await readFile(marker, "utf8").catch(() => null)) break;
      await delay(100);
    }
    expect(await readFile(marker, "utf8")).toContain("yes");
  } finally {
    await host.stop(hostRef);
  }
}, 20000);

test("sessionState is null once the window is gone", async () => {
  const host = new TmuxHost(testServer("lifecycle-gone"));
  const { hostRef } = await host.launch({
    argv: ["sleep", "60"],
    cwd: tmpdir(),
    env: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      LANG: "en_US.UTF-8",
    },
    label: "gone-probe",
  });
  await host.stop(hostRef);
  expect(await host.sessionState(hostRef)).toBeNull();
}, 20000);

test("a tmux session is armed at launch and reaped when its ttl expires", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new TmuxHost(testServer("reap-e2e"))],
  });
  try {
    const peer = asSession(
      await m.run({
        runtime: "claude",
        prompt: "reap me",
        cwd: f.root,
        host: "tmux",
        ttl: "1s",
        idleTimeout: "off",
      }),
    );
    expect(peer).toMatchObject({ ttl: 1 });
    // The reaper is armed and re-arms on its own; nothing of ours is running.
    let status = "";
    for (let i = 0; i < 90; i++) {
      const [entry] = await new Registry(f.home).all();
      status = entry?.status ?? "";
      if (status === "stopped") break;
      await delay(1000);
    }
    // Specifically "stopped". "not running" is satisfied by the registry's own
    // liveness sweep, which flips a dead row to "exited" whether the reap
    // bookkeeping ran or not — so the weaker assertion cannot tell a clean reap
    // from the reaper being killed mid-stop by the tmux server it lives in.
    expect(status).toBe("stopped");
  } finally {
    await m.close();
  }
}, 120000);

test("the format also asks when a client last attached", () => {
  // I2: attaching and detaching does not advance window_activity. Without
  // last-attached, a session someone read for ten minutes and detached from is
  // reaped on the very next poll — the person who most clearly still wants it.
  expect(SESSION_STATE_FORMAT).toContain("#{session_last_attached}");
});

test("idleness counts from the later of output and last attach", () => {
  // window_activity, session_created, session_attached, session_last_attached
  expect(parseSessionState("900|700|0|960", 1000)).toMatchObject({ idle: 40 });
  // Never attached: tmux reports 0, which must not read as 1970.
  expect(parseSessionState("900|700|0|0", 1000)).toMatchObject({ idle: 100 });
});

test("a hash in an argument survives tmux format expansion", () => {
  // tmux expands the run-shell command as a FORMAT before the shell sees it,
  // so #{...} in a path is silently eaten. Quoting cannot prevent that.
  expect(tmuxCommand(["/bin/echo", "/tmp/a#{pane_pid}b"])).toContain("##{");
  expect(tmuxCommand(["/bin/echo", "plain"])).toBe("'/bin/echo' 'plain'");
});

test("the tmux host names its own socket", () => {
  // Rather than run.ts reaching in with a structural cast.
  expect(new TmuxHost("review-sock").socketName()).toBe("review-sock");
});
