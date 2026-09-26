import { expect, test } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, pollInterval, reapCheck } from "../src/reap.js";
import { Registry } from "../src/registry.js";
import { COMMANDS } from "../src/help.js";
import { Muster } from "../src/run.js";
import { PtyHost } from "../src/hosts/pty.js";
import { fixture } from "./helpers.js";
import { TmuxHost } from "../src/hosts/tmux.js";
import { testServer } from "./global-setup.js";
import { asSession } from "./narrow.js";

const live = { idle: 10, age: 100, attached: false };

test("an idle session past its timeout is reaped", () => {
  expect(
    decide(
      { idleTimeout: 60, ttl: null, status: "running" },
      { ...live, idle: 60 },
    ),
  ).toEqual({ action: "reap" });
});

test("a session past its ttl is reaped even while active", () => {
  // The backstop for a session that looks busy only because something loops.
  expect(
    decide(
      { idleTimeout: 3600, ttl: 100, status: "running" },
      { idle: 1, age: 100, attached: false },
    ),
  ).toEqual({ action: "reap" });
});

test("an attached session is never reaped, however idle", () => {
  expect(
    decide(
      { idleTimeout: 60, ttl: 60, status: "running" },
      { idle: 9999, age: 9999, attached: true },
    ),
  ).toMatchObject({ action: "rearm" });
});

test("a live session re-arms", () => {
  expect(
    decide({ idleTimeout: 60, ttl: null, status: "running" }, live),
  ).toMatchObject({
    action: "rearm",
  });
});

test("a vanished session stops polling rather than re-arming forever", () => {
  // Distinct from `starting`: no window means nothing left to reap.
  expect(
    decide({ idleTimeout: 60, ttl: null, status: "running" }, null),
  ).toEqual({
    action: "stop",
  });
});

test("an entry with no lifecycle decides nothing", () => {
  // An entry written before this release. Absent must not read as zero.
  expect(
    decide({ idleTimeout: undefined, ttl: undefined, status: "running" }, live),
  ).toEqual({ action: "stop" });
  expect(
    decide({ idleTimeout: null, ttl: null, status: "running" }, live),
  ).toEqual({ action: "stop" });
});

test("an entry that is no longer running stops polling", () => {
  for (const status of ["stopped", "exited", "failed"] as const)
    expect(decide({ idleTimeout: 60, ttl: null, status }, live)).toEqual({
      action: "stop",
    });
});

test("a session still starting re-arms rather than abandoning the reaper", () => {
  // The job is armed once hostRef exists, while the entry is still `starting`;
  // it only becomes `running` when the peer is recorded. Stopping here would
  // silently lose the reaper for every launch slower than one poll — the exact
  // orphan this feature exists to prevent.
  expect(
    decide({ idleTimeout: 60, ttl: null, status: "starting" }, live),
  ).toMatchObject({ action: "rearm" });
});

test("an unknown-status session keeps polling rather than being abandoned", () => {
  expect(
    decide({ idleTimeout: 60, ttl: null, status: "unknown" }, live),
  ).toMatchObject({ action: "rearm" });
});

test("the poll interval follows the shorter expiry", () => {
  // A 4h idle with a 2m ttl must not poll every 5m and overshoot the ttl:
  // the interval follows the 2m, not the 4h.
  expect(pollInterval({ idleTimeout: 14400, ttl: 120 })).toBe(20);
  expect(pollInterval({ idleTimeout: 1800, ttl: null })).toBe(300);
  expect(pollInterval({ idleTimeout: 180, ttl: null })).toBe(30);
});

test("reap-check on an unknown launch stops rather than throwing", async () => {
  // The registry may have been cleaned between polls. A tmux job that throws
  // writes to a log nobody reads.
  const home = await mkdtemp(join(tmpdir(), "muster-reap-"));
  await expect(
    reapCheck({ home, socket: "nosuch", launchId: "missing", argv: [] }),
  ).resolves.toEqual({ action: "stop" });
});

test("reap-check on an entry with no lifecycle stops", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-reap-none-"));
  const registry = new Registry(home);
  const { entry } = await registry.reserve(
    { runtime: "claude", kind: "session", cwd: home },
    1,
  );
  // hostRef must be set, or reapCheck returns early on the missing-window
  // branch and this passes for a reason unrelated to its name.
  await registry.update(entry.launchId, { hostRef: "@9" });
  await expect(
    reapCheck({ home, socket: "nosuch", launchId: entry.launchId, argv: [] }),
  ).resolves.toEqual({ action: "stop" });
});

test("a command that dispatches but is not for humans is excluded deliberately", () => {
  // test/help.test.ts asserts every dispatched command is documented in
  // COMMANDS. reap-check is armed by muster for tmux and never typed, so it is
  // excluded there rather than documented here.
  expect(COMMANDS.map((c) => c.name)).not.toContain("reap-check");
});

test("a pty session records no lifecycle and is not armed", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  try {
    const peer = asSession(
      await m.run({ runtime: "claude", prompt: "p", cwd: f.root, host: "pty" }),
    );
    try {
      const [entry] = await new Registry(f.home).all();
      expect(entry!.idleTimeout).toBeNull();
    } finally {
      await m.stop(peer.canonical_id);
    }
  } finally {
    await m.close();
  }
}, 20000);

test("naming a lifecycle on a pty launch is refused end to end", async () => {
  // The refusal Task 7's dist check could not reach: it comes from
  // resolveLifecycle, which only run.ts calls.
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  try {
    await expect(
      m.run({
        runtime: "claude",
        prompt: "p",
        cwd: f.root,
        host: "pty",
        idleTimeout: "10m",
      }),
    ).rejects.toThrow(/--idle-timeout applies to tmux sessions/);
  } finally {
    await m.close();
  }
}, 20000);

test("a malformed duration is refused before anything is reserved", async () => {
  const f = await fixture();
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    await expect(
      m.run({
        runtime: "claude",
        kind: "task",
        prompt: "p",
        cwd: f.root,
        idleTimeout: "30",
      }),
    ).rejects.toThrow(/--idle-timeout/);
    expect(await new Registry(f.home).all()).toHaveLength(0);
  } finally {
    await m.close();
  }
}, 20000);

test("a reap hands the stop to a process tmux cannot kill", async () => {
  // C1: reap-check runs as a child of the tmux server. Stopping the last
  // session makes that server exit and kills the job mid-stop, before the
  // registry row is updated and before the per-launch identity copy — which
  // holds a credential — is removed. The stop must outlive the server.
  const home = await mkdtemp(join(tmpdir(), "muster-reap-detach-"));
  const registry = new Registry(home);
  const { entry } = await registry.reserve(
    {
      runtime: "claude",
      kind: "session",
      cwd: home,
      idleTimeout: 1,
      ttl: null,
    },
    1,
  );
  await registry.update(entry.launchId, { hostRef: "@9" });
  const spawned: string[][] = [];
  const decision = await reapCheck({
    home,
    socket: "nosuch",
    launchId: entry.launchId,
    argv: ["/node", "/muster.js", "reap-check", "--home", home, entry.launchId],
    state: { idle: 99, age: 99, attached: false },
    spawn: (exec, args) => spawned.push([exec, ...args]),
  });
  expect(decision).toEqual({ action: "reap" });
  expect(spawned).toHaveLength(1);
  expect(spawned[0]).toContain("--stop-now");
  expect(spawned[0]![0]).toBe("/node");
});

test("--stop-now performs the stop instead of deciding", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-reap-stopnow-"));
  const registry = new Registry(home);
  const { entry } = await registry.reserve(
    {
      runtime: "claude",
      kind: "session",
      cwd: home,
      idleTimeout: 1,
      ttl: null,
    },
    1,
  );
  await registry.update(entry.launchId, { hostRef: "@9" });
  // No tmux, no process: the stop path must still mark the row rather than
  // leaving it running.
  await reapCheck({
    home,
    socket: "nosuch",
    launchId: entry.launchId,
    argv: [],
    stopNow: true,
  });
  const [after] = await new Registry(home).all();
  // Specifically "stopped", not merely "not running": the registry liveness
  // sweep flips a dead row to "exited" on its own, which would make this pass
  // whether the reap bookkeeping ran or not.
  expect(after!.status).toBe("stopped");
});

test("a transient read failure re-arms instead of ending the chain", async () => {
  // I3: a poll colliding with the registry lock, or a bad config.toml, must not
  // permanently disarm a session. Only a decision that means stop, stops.
  const scheduled: number[] = [];
  const decision = await reapCheck({
    home: "/nonexistent-muster-home",
    socket: "nosuch",
    launchId: "whatever",
    argv: ["/node", "/muster.js"],
    readEntries: () => {
      throw new Error("Registry locked; verify no Muster operation is running");
    },
    schedule: async (seconds) => {
      scheduled.push(seconds);
    },
  });
  expect(decision).toMatchObject({ action: "rearm" });
  expect(scheduled).toHaveLength(1);
});

test("a short limit polls often enough to honour it", () => {
  // A 45s ttl must not sit behind a 30s floor and fire at 75s.
  expect(pollInterval({ idleTimeout: null, ttl: 45 })).toBeLessThanOrEqual(15);
  expect(pollInterval({ idleTimeout: 1800, ttl: null })).toBe(300);
  // Still bounded: nothing polls faster than the floor.
  expect(pollInterval({ idleTimeout: 6, ttl: null })).toBeGreaterThanOrEqual(5);
});

test("a session whose reaper could not be armed does not advertise a timeout", async () => {
  // Otherwise `list` promises an expiry nothing will ever honour, and the
  // caller has no way to tell from the outside.
  const f = await fixture();
  class Unschedulable extends TmuxHost {
    override async schedule(): Promise<void> {
      throw new Error("tmux refused");
    }
  }
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new Unschedulable(testServer("arm-fail"))],
  });
  try {
    const peer = asSession(
      await m.run({
        runtime: "claude",
        prompt: "p",
        cwd: f.root,
        host: "tmux",
        idleTimeout: "30m",
      }),
    );
    try {
      expect(peer.idle_timeout).toBeUndefined();
      const [entry] = await new Registry(f.home).all();
      expect(entry!.idleTimeout).toBeNull();
    } finally {
      await m.stop(peer.canonical_id);
    }
  } finally {
    await m.close();
  }
}, 30000);
