import { test, expect } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fixture, lines } from "./helpers.js";
import { asSession, asTask } from "./narrow.js";
import { testServer } from "./global-setup.js";
import { Muster, UnknownRun, durableId } from "../src/run.js";
import { Registry } from "../src/registry.js";
import { PtyHost } from "../src/hosts/pty.js";
import { TmuxHost } from "../src/hosts/tmux.js";
import { delay, groupAlive, processRef } from "../src/identity/processes.js";
import { onExitEnv, prepareOnExit, runOnExitCommand } from "../src/on-exit.js";
import { asksForHelp } from "../src/cli-options.js";
import { waitSeconds } from "../src/duration.js";

const cli = join(process.cwd(), "dist/muster.js");
const run = promisify(execFile);

/** The env file an `--on-exit` command writes, once it has. */
async function hookOutput(path: string, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(path, "utf8");
      if (text.includes("END")) return text;
    } catch {}
    await delay(100);
  }
  throw new Error(`on-exit command never wrote ${path}`);
}
const field = (text: string, key: string) =>
  new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1];
const RECORD_HOOK = (out: string) =>
  `env | grep '^MUSTER_' | grep -v MUSTER_RECORD > ${out}; echo PWD=$PWD >> ${out}; echo END >> ${out}`;

/**
 * The incident this exists for: a caller launched Codex review tasks, polled
 * with a flag muster refused, and reported them running for forty minutes after
 * they had exited. `wait` is the poll muster does for you, identically for
 * every runtime.
 */
for (const runtime of ["claude", "codex", "opencode"] as const)
  test(`wait returns a ${runtime} task's final record once it exits`, async () => {
    const f = await fixture({ MUSTER_FAKE_TASK_MS: "400" });
    const m = await Muster.create({ home: f.home, env: f.env });
    try {
      const task = asTask(
        await m.run({ runtime, kind: "task", prompt: "wait me", cwd: f.root }),
      );
      const { done, record } = await m.wait(task.id, { timeoutMs: 8000 });
      expect(done).toBe(true);
      expect(record).toMatchObject({
        id: task.id,
        kind: "task",
        runtime,
        state: "exited",
        exit_code: 0,
        signal: null,
      });
    } finally {
      await m.close();
    }
  }, 15000);

test("wait reports a task's failing exit code", async () => {
  const f = await fixture({ MUSTER_FAKE_EXIT: "1" });
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    const task = asTask(
      await m.run({
        runtime: "codex",
        kind: "task",
        prompt: "fail",
        cwd: f.root,
      }),
    );
    const { record } = await m.wait(task.id, { timeoutMs: 8000 });
    expect(record).toMatchObject({ state: "exited", exit_code: 7 });
  } finally {
    await m.close();
  }
}, 15000);

test("wait gives up at the timeout and says the run is still going", async () => {
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "10000" });
  const m = await Muster.create({ home: f.home, env: f.env });
  const task = asTask(
    await m.run({
      runtime: "codex",
      kind: "task",
      prompt: "slow",
      cwd: f.root,
    }),
  );
  try {
    const start = Date.now();
    const { done, record } = await m.wait(task.id, { timeoutMs: 300 });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(done).toBe(false);
    expect(record.state).toBe("running");
  } finally {
    await m.stop(task.id);
    await m.close();
  }
}, 15000);

test("wait on an id that names nothing fails at once", async () => {
  const f = await fixture();
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    await expect(m.wait("no-such-run")).rejects.toBeInstanceOf(UnknownRun);
  } finally {
    await m.close();
  }
});

test("wait on a session resolves when it is stopped, by name or id", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  try {
    const peer = asSession(
      await m.run({
        runtime: "claude",
        prompt: "session to wait on",
        cwd: f.root,
        host: "pty",
      }),
    );
    const waiting = m.wait(peer.canonical_id, { timeoutMs: 8000 });
    await delay(300);
    await m.stop(peer.canonical_id);
    const { done, record } = await waiting;
    expect(done).toBe(true);
    // A terminal host keeps no exit status, and the record says so plainly.
    expect(record).toMatchObject({
      kind: "session",
      state: "stopped",
      exit_code: null,
      signal: null,
    });
  } finally {
    await m.close();
  }
}, 15000);

test("wait notices a session whose agent died on its own", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new TmuxHost(testServer("wait-died"))],
  });
  try {
    const peer = asSession(
      await m.run({
        runtime: "codex",
        prompt: "dies by itself",
        cwd: f.root,
        host: "tmux",
      }),
    );
    // Not through muster: the agent's whole tree goes, as when it crashes.
    const entry = (await new Registry(f.home).all())[0]!;
    process.kill(-entry.group!, "SIGKILL");
    const { done, record } = await m.wait(peer.thread_id!, {
      timeoutMs: 8000,
    });
    expect(done).toBe(true);
    expect(record.state).toBe("exited");
  } finally {
    await m.close();
  }
}, 15000);

for (const runtime of ["claude", "codex", "opencode"] as const)
  test(`--on-exit runs once, outside the agent, when a ${runtime} task exits`, async () => {
    const f = await fixture({ MUSTER_FAKE_TASK_MS: "300" });
    const m = await Muster.create({ home: f.home, env: f.env });
    const out = join(f.root, "hook.txt");
    try {
      const task = asTask(
        await m.run({ runtime, kind: "task", prompt: "hooked", cwd: f.root }),
      );
      await m.armOnExit(task.id, RECORD_HOOK(out), f.home);
      const text = await hookOutput(out);
      expect(field(text, "MUSTER_ID")).toBe(task.id);
      expect(field(text, "MUSTER_RUNTIME")).toBe(runtime);
      expect(field(text, "MUSTER_KIND")).toBe("task");
      expect(field(text, "MUSTER_STATE")).toBe("exited");
      expect(field(text, "MUSTER_EXIT_CODE")).toBe("0");
      // The result travels with the signal, not just the status.
      const output = field(text, "MUSTER_OUTPUT")!;
      expect(await readFile(output, "utf8")).toContain("TASK_OUTPUT:hooked");
      // Run from where it was asked, not from the agent's folder.
      expect(field(text, "PWD")).toBe(await realpath(f.home));
      // Claimed exactly once, and recorded in the launch log.
      expect(await new Registry(f.home).claimOnExit(task.id)).toBeUndefined();
      await delay(300);
      expect(
        (await lines(join(f.home, "launches.jsonl"))).filter(
          (e) => e.event === "on_exit",
        ),
      ).toMatchObject([{ launch_id: task.id, state: "exited", exit_code: 0 }]);
    } finally {
      await m.close();
    }
  }, 20000);

test("--on-exit fires for a tmux session that is stopped", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new TmuxHost(testServer("on-exit-session"))],
  });
  const out = join(f.root, "hook.txt");
  try {
    const peer = asSession(
      await m.run({
        runtime: "claude",
        prompt: "session hook",
        cwd: f.root,
        host: "tmux",
      }),
    );
    await m.armOnExit(peer.canonical_id, RECORD_HOOK(out), f.root);
    await m.stop(peer.canonical_id);
    const text = await hookOutput(out);
    expect(field(text, "MUSTER_ID")).toBe(peer.session_id);
    expect(field(text, "MUSTER_KIND")).toBe("session");
    expect(field(text, "MUSTER_STATE")).toBe("stopped");
    expect(field(text, "MUSTER_EXIT_CODE")).toBe("");
    expect(field(text, "MUSTER_OUTPUT")).toBe("");
  } finally {
    await m.close();
  }
}, 20000);

test("a second --on-exit for the same launch is refused, not dropped", async () => {
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "2000" });
  const m = await Muster.create({ home: f.home, env: f.env });
  const task = asTask(
    await m.run({ runtime: "codex", kind: "task", prompt: "x", cwd: f.root }),
  );
  try {
    await m.armOnExit(task.id, "true", f.root);
    await expect(m.armOnExit(task.id, "true", f.root)).rejects.toThrow(
      /already has an --on-exit/,
    );
  } finally {
    await m.stop(task.id);
    await m.close();
  }
}, 15000);

/**
 * Review finding 3: the check and the write were separate, so two callers
 * handed the same launch could both pass the check, and the second command
 * replaced the first while both callers were told they had succeeded.
 */
test("two --on-exit registrations at once: exactly one wins, and it is kept", async () => {
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "3000" });
  const m = await Muster.create({ home: f.home, env: f.env });
  const task = asTask(
    await m.run({ runtime: "codex", kind: "task", prompt: "x", cwd: f.root }),
  );
  try {
    const results = await Promise.allSettled(
      ["echo first", "echo second", "echo third"].map((c) =>
        m.armOnExit(task.id, c, f.root),
      ),
    );
    const won = results.flatMap((r, i) =>
      r.status === "fulfilled"
        ? [["echo first", "echo second", "echo third"][i]]
        : [],
    );
    expect(won).toHaveLength(1);
    for (const r of results)
      if (r.status === "rejected")
        expect(String(r.reason)).toMatch(/already has an --on-exit/);
    const entry = (await new Registry(f.home).all())[0]!;
    expect(entry.onExit?.command).toBe(won[0]);
  } finally {
    await m.stop(task.id);
    await m.close();
  }
}, 15000);

/**
 * Review finding 1: the task worker writes its exit file on the SIGTERM a stop
 * sends, and that file used to win, so a stopped task reported `exited`.
 */
test("a stopped task is reported stopped, to wait and to its --on-exit", async () => {
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "10000" });
  const m = await Muster.create({ home: f.home, env: f.env });
  const out = join(f.root, "hook.txt");
  try {
    const task = asTask(
      await m.run({ runtime: "codex", kind: "task", prompt: "x", cwd: f.root }),
    );
    await m.armOnExit(task.id, RECORD_HOOK(out), f.root);
    await delay(300);
    await m.stop(task.id);
    const { done, record } = await m.wait(task.id, { timeoutMs: 8000 });
    expect(done).toBe(true);
    expect(record.state).toBe("stopped");
    expect(field(await hookOutput(out), "MUSTER_STATE")).toBe("stopped");
    expect((await m.list("task"))[0].state).toBe("stopped");
  } finally {
    await m.close();
  }
}, 20000);

/**
 * Review finding 2: the exit file's existence counted as the end, so a reader
 * that found it created but not yet written returned `done` with a record
 * still saying `running` — and a watcher spent its one claim on that.
 */
test("an exit file that does not parse is not the end", async () => {
  const f = await fixture();
  const registry = new Registry(f.home);
  const { entry } = await registry.reserve(
    { runtime: "codex", kind: "task", cwd: f.root },
    10,
  );
  const exitPath = join(f.root, "exit.json");
  await writeFile(exitPath, "");
  // This test process stands in for a live task worker.
  await registry.update(entry.launchId, {
    status: "running",
    root: (await processRef(process.pid))!,
    exitPath,
    outputPath: join(f.root, "output.txt"),
  });
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    expect(await m.wait(entry.launchId, { timeoutMs: 600 })).toMatchObject({
      done: false,
      record: { state: "running" },
    });
    await writeFile(exitPath, '{"code":0,"signal":null}');
    expect(await m.wait(entry.launchId, { timeoutMs: 3000 })).toMatchObject({
      done: true,
      record: { state: "exited", exit_code: 0 },
    });
  } finally {
    await m.close();
  }
}, 15000);

/**
 * Review finding 4: the CLI armed a session by its name, and a name resolves
 * only among running sessions, so one that ended before arming lost its hook.
 * Armed by its durable id it still gets it, at once.
 */
test("a session that ends before --on-exit is armed still gets its command", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new TmuxHost(testServer("arm-late"))],
  });
  const out = join(f.root, "hook.txt");
  try {
    const peer = asSession(
      await m.run({
        runtime: "codex",
        prompt: "gone before arming",
        cwd: f.root,
        host: "tmux",
      }),
    );
    const entry = (await new Registry(f.home).all())[0]!;
    process.kill(-entry.group!, "SIGKILL");
    expect((await m.wait(peer.thread_id!, { timeoutMs: 8000 })).done).toBe(
      true,
    );
    // What the CLI did before: the address resolves only among running
    // sessions, so arming by it after the end fails.
    await expect(
      m.armOnExit(peer.canonical_id, RECORD_HOOK(out), f.root),
    ).rejects.toBeInstanceOf(UnknownRun);
    // What the CLI arms with now.
    expect(durableId(peer)).toBe(peer.thread_id);
    await m.armOnExit(durableId(peer), RECORD_HOOK(out), f.root);
    const text = await hookOutput(out);
    expect(field(text, "MUSTER_ID")).toBe(peer.thread_id);
    expect(field(text, "MUSTER_STATE")).toBe("exited");
  } finally {
    await m.close();
  }
}, 20000);

/**
 * Review finding 5: a claim is spent whether or not the command then starts,
 * so what can fail is settled first. A directory removed since the launch
 * falls back to HOME rather than costing the signal, and the claim is in the
 * launch log ahead of the result.
 */
test("a removed --on-exit directory falls back to HOME, logged before the claim is spent", async () => {
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "800" });
  const m = await Muster.create({ home: f.home, env: f.env });
  const out = join(f.root, "hook.txt");
  const doomed = join(f.root, "doomed");
  await mkdir(doomed);
  try {
    const task = asTask(
      await m.run({ runtime: "codex", kind: "task", prompt: "x", cwd: f.root }),
    );
    await m.armOnExit(task.id, RECORD_HOOK(out), doomed);
    await rm(doomed, { recursive: true });
    const text = await hookOutput(out);
    expect(field(text, "PWD")).toBe(await realpath(f.root));
    await delay(300);
    const events = (await lines(join(f.home, "launches.jsonl"))).filter(
      (e) => e.launch_id === task.id && String(e.event).startsWith("on_exit"),
    );
    expect(events.map((e) => e.event)).toEqual([
      "on_exit_armed",
      "on_exit_claimed",
      "on_exit",
    ]);
    expect(events[1].warnings[0]).toContain("unusable");
  } finally {
    await m.close();
  }
}, 20000);

/**
 * #68 item 3: a directory that exists but cannot be entered fails the spawn
 * just as surely as one that is gone, after the claim is spent. So both the
 * cwd and the HOME fallback are checked for search access first, and when
 * neither can be entered the command runs in `/`.
 */
test("an --on-exit directory that cannot be entered falls back, and so does an unusable HOME", async () => {
  const f = await fixture();
  const locked = join(f.root, "locked");
  const lockedHome = join(f.root, "locked-home");
  await mkdir(locked);
  await mkdir(lockedHome);
  await chmod(locked, 0o600);
  await chmod(lockedHome, 0o600);
  const logPath = join(f.home, "on-exit", "x.log");
  try {
    const toHome = await prepareOnExit({
      cwd: locked,
      fallbackCwd: f.root,
      logPath,
    });
    expect(toHome.cwd).toBe(f.root);
    expect(toHome.warnings[0]).toContain(`cwd ${locked} unusable`);
    await toHome.log?.close();

    const toRoot = await prepareOnExit({
      cwd: locked,
      fallbackCwd: lockedHome,
      logPath,
    });
    expect(toRoot.cwd).toBe("/");
    expect(toRoot.warnings).toHaveLength(2);
    expect(toRoot.warnings[1]).toContain(`fallback ${lockedHome} unusable`);
    await toRoot.log?.close();
  } finally {
    await chmod(locked, 0o700);
    await chmod(lockedHome, 0o700);
  }
});

/**
 * Review finding 6: `groupAlive` counted zombies, which `processRef` never
 * has, so a group left holding only an unreaped zombie kept `wait` waiting
 * for as long as its parent chose not to reap.
 */
test("a group holding only a zombie is not alive", async () => {
  // A parent outside the group that never reaps: the child becomes a zombie
  // and stays one, the only member of the group it leads.
  const parent = spawn(
    "python3",
    [
      "-c",
      "import subprocess,sys,time\n" +
        "p=subprocess.Popen(['sh','-c','exit 0'],start_new_session=True)\n" +
        "print(p.pid,flush=True)\ntime.sleep(30)",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    const pid = Number(
      await new Promise<string>((resolve) =>
        parent.stdout!.once("data", (d) => resolve(String(d).trim())),
      ),
    );
    await delay(300);
    const { stdout } = await run("ps", ["-p", String(pid), "-o", "stat="]);
    expect(stdout.trim()).toMatch(/^Z/);
    expect(await groupAlive(pid)).toBe(false);
  } finally {
    parent.kill("SIGKILL");
  }
});

test("durableId is a task's id, a Codex thread id, or a Claude/OpenCode session id", () => {
  expect(durableId({ kind: "task", id: "t" } as never)).toBe("t");
  expect(
    durableId({ kind: "session", runtime: "codex", thread_id: "th" } as never),
  ).toBe("th");
  for (const runtime of ["claude-code", "opencode"])
    expect(
      durableId({ kind: "session", runtime, session_id: "se" } as never),
    ).toBe("se");
});

test("the environment is strings, with empty for what was not observed", () => {
  const env = onExitEnv(
    { runtime: "claude", kind: "session" },
    { id: "abc", state: "exited", exit_code: null, signal: null },
  );
  expect(env).toMatchObject({
    MUSTER_ID: "abc",
    MUSTER_RUNTIME: "claude",
    MUSTER_STATE: "exited",
    MUSTER_EXIT_CODE: "",
    MUSTER_SIGNAL: "",
    MUSTER_OUTPUT: "",
  });
  expect(JSON.parse(env.MUSTER_RECORD!)).toMatchObject({ id: "abc" });
});

test("--help is help anywhere among a command's flags, but not as a value", () => {
  expect(asksForHelp(["--help"])).toBe(true);
  expect(asksForHelp(["codex", "--kind", "task", "--help"])).toBe(true);
  expect(asksForHelp(["codex", "-h"])).toBe(true);
  expect(asksForHelp(["codex", "--prompt", "--help"])).toBe(false);
  expect(asksForHelp(["codex", "--", "--help"])).toBe(false);
  expect(asksForHelp(["codex", "--read-only", "--help"])).toBe(true);
});

test("wait --timeout takes seconds or a duration", () => {
  expect(waitSeconds("90")).toBe(90);
  expect(waitSeconds("30m")).toBe(1800);
  for (const bad of ["0", "off", "-1", "soon"])
    expect(() => waitSeconds(bad)).toThrow(/--timeout/);
});

test("the CLI: wait's exit statuses, run --on-exit, and help everywhere", async () => {
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "400" });
  const cliRun = (...args: string[]) =>
    run(process.execPath, [cli, ...args], { env: f.env, cwd: f.root }).then(
      (r) => ({ code: 0, ...r }),
      (e) => ({ code: e.code as number, stdout: e.stdout, stderr: e.stderr }),
    );

  const unknown = await cliRun("wait", "no-such-run");
  expect(unknown.code).toBe(2);
  expect(unknown.stderr).toContain("no session or task matches");

  const out = join(f.root, "hook.txt");
  const launched = await cliRun(
    "run",
    "codex",
    "--kind",
    "task",
    "--prompt",
    "cli hook",
    "--cwd",
    f.root,
    "--on-exit",
    RECORD_HOOK(out),
  );
  expect(launched.code).toBe(0);
  const { id } = JSON.parse(launched.stdout);
  const waited = await cliRun("wait", id, "--timeout", "10");
  expect(waited.code).toBe(0);
  expect(JSON.parse(waited.stdout)).toMatchObject({
    id,
    state: "exited",
    exit_code: 0,
  });
  expect(field(await hookOutput(out), "MUSTER_ID")).toBe(id);

  for (const args of [
    ["list", "--help"],
    ["run", "codex", "--help"],
    ["wait", "--help"],
    ["stop", "-h"],
  ]) {
    const help = await cliRun(...args);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/^Usage: muster /);
  }
  const unknownFlag = await cliRun("list", "--json");
  expect(unknownFlag.code).toBe(1);
  expect(unknownFlag.stderr).toContain("muster list --help");
  const misplaced = await cliRun("list", "--on-exit", "true");
  expect(misplaced.stderr).toContain("--on-exit applies only to run");
}, 30000);

test("wait --timeout exits 124 with the record as it stands", async () => {
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "10000" });
  const launched = await run(
    process.execPath,
    [
      cli,
      "run",
      "codex",
      "--kind",
      "task",
      "--prompt",
      "long",
      "--cwd",
      f.root,
    ],
    { env: f.env },
  );
  const { id } = JSON.parse(launched.stdout);
  try {
    const result = await run(
      process.execPath,
      [cli, "wait", id, "--timeout", "1"],
      { env: f.env },
    ).then(
      () => ({ code: 0, stdout: "" }),
      (e) => ({ code: e.code as number, stdout: e.stdout as string }),
    );
    expect(result.code).toBe(124);
    expect(JSON.parse(result.stdout)).toMatchObject({ id, state: "running" });
  } finally {
    await run(process.execPath, [cli, "stop", id], { env: f.env });
  }
}, 20000);

/**
 * #68 item 1: `stop` wrote `stopping` unconditionally and that flag won, so
 * stopping a task that had already exited relabelled it `stopped` — and a
 * waiter that read it afterwards was told a stop ended it.
 */
test("stop on a task that already exited changes nothing", async () => {
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "200" });
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    const task = asTask(
      await m.run({ runtime: "codex", kind: "task", prompt: "x", cwd: f.root }),
    );
    expect((await m.wait(task.id, { timeoutMs: 8000 })).record.state).toBe(
      "exited",
    );
    expect(await m.stop(task.id)).toEqual({
      stopped: false,
      id: task.id,
      state: "exited",
    });
    const { record } = await m.wait(task.id, { timeoutMs: 1000 });
    expect(record).toMatchObject({ state: "exited", exit_code: 0 });
    expect((await m.list("task"))[0].state).toBe("exited");
    const entry = (await new Registry(f.home).all())[0]!;
    expect(entry.status).toBe("exited");
    expect(entry.stopRequestedAt).toBeUndefined();
  } finally {
    await m.close();
  }
}, 15000);

/**
 * #68 item 1, the race: an exit recorded before the stop was asked is an
 * exit, even when the registry had not yet noticed it.
 */
test("an exit file older than the stop request still reads exited", async () => {
  const f = await fixture();
  const registry = new Registry(f.home);
  const { entry } = await registry.reserve(
    { runtime: "codex", kind: "task", cwd: f.root },
    10,
  );
  const exitPath = join(f.home, "exit.json");
  await writeFile(exitPath, JSON.stringify({ code: 0, signal: null }));
  await registry.update(entry.launchId, {
    exitPath,
    status: "stopped",
    stopRequestedAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    expect((await m.list("task"))[0].state).toBe("exited");
  } finally {
    await m.close();
  }
});

/**
 * #68 item 2: the claim committed, then a launch-log write failed and the
 * command was never spawned — no hook, and nothing anywhere saying so.
 */
test("a claimed --on-exit runs and records its result when the launch log is unwritable", async () => {
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "800" });
  const m = await Muster.create({ home: f.home, env: f.env });
  const out = join(f.root, "hook.txt");
  try {
    const task = asTask(
      await m.run({ runtime: "codex", kind: "task", prompt: "x", cwd: f.root }),
    );
    await m.armOnExit(task.id, `${RECORD_HOOK(out)}; exit 3`, f.root);
    const log = join(f.home, "launches.jsonl");
    await rm(log);
    await mkdir(log);
    expect(field(await hookOutput(out), "MUSTER_STATE")).toBe("exited");
    const registry = new Registry(f.home);
    const deadline = Date.now() + 5000;
    while (!(await registry.peek(task.id))?.onExitResult) {
      if (Date.now() > deadline) throw new Error("no on-exit result recorded");
      await delay(100);
    }
    const { record } = await m.wait(task.id, { timeoutMs: 1000 });
    expect(record.on_exit).toMatchObject({
      claimed_at: expect.any(String),
      result: { exit_code: 3, signal: null },
    });
    expect((await m.list("task"))[0].on_exit.result.exit_code).toBe(3);
  } finally {
    await m.close();
  }
}, 20000);

test("an --on-exit command that cannot start says why", async () => {
  const f = await fixture();
  const result = await runOnExitCommand({
    command: "true",
    cwd: join(f.root, "gone"),
    env: f.env,
    entry: { runtime: "codex", kind: "task" } as never,
    record: { id: "x", state: "exited" },
  });
  expect(result).toMatchObject({ exit_code: null, error: expect.any(String) });
});

/**
 * #68 item 5: hooks were armed only after a launch succeeded, so a launch
 * that failed at readiness left its caller waiting on a signal that never
 * came.
 */
test("a launch that fails still fires --on-exit with MUSTER_STATE=failed", async () => {
  const f = await fixture({ MUSTER_FAKE_EXIT: "1" });
  const out = join(f.root, "hook.txt");
  const hook = RECORD_HOOK(out);
  const failed = await run(
    process.execPath,
    [
      cli,
      "run",
      "claude",
      "--host",
      "pty",
      "--prompt",
      "x",
      "--cwd",
      f.root,
      "--on-exit",
      hook,
    ],
    { env: f.env, cwd: f.root },
  ).then(
    () => ({ code: 0, stderr: "" }),
    (e) => ({ code: e.code as number, stderr: e.stderr as string }),
  );
  expect(failed.code).toBe(1);
  const text = await hookOutput(out);
  expect(field(text, "MUSTER_STATE")).toBe("failed");
  expect(field(text, "MUSTER_ERROR")).toMatch(/exited/);
  const id = field(text, "MUSTER_ID")!;
  const waited = await run(process.execPath, [cli, "wait", id], {
    env: f.env,
  });
  expect(JSON.parse(waited.stdout)).toMatchObject({
    id,
    state: "failed",
    on_exit: { claimed_at: expect.any(String) },
  });
}, 20000);

/**
 * Codex review of #68 item 1: a task's exit file lands while its worker is
 * still tearing down, and a stop in that window answered with the raw
 * registry status, `running`, for a task that had exited.
 */
test("stop between a task's exit and its teardown answers exited", async () => {
  const f = await fixture();
  const registry = new Registry(f.home);
  const { entry } = await registry.reserve(
    { runtime: "codex", kind: "task", cwd: f.root },
    10,
  );
  const exitPath = join(f.root, "exit.json");
  await writeFile(exitPath, '{"code":0,"signal":null}');
  // This test process stands in for a worker still tearing down.
  await registry.update(entry.launchId, {
    status: "running",
    root: (await processRef(process.pid))!,
    exitPath,
    outputPath: join(f.root, "output.txt"),
  });
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    expect(await m.stop(entry.launchId)).toEqual({
      stopped: false,
      id: entry.id,
      state: "exited",
    });
    expect((await registry.peek(entry.launchId))?.stopRequestedAt).toBe(
      undefined,
    );
  } finally {
    await m.close();
  }
});

/**
 * Codex review of #68 item 1: the sweep labelled any vanished launch with a
 * stop request `stopped`, even a task whose exit file was older than it.
 */
test("the registry sweep keeps an exit recorded before the stop request", async () => {
  const f = await fixture();
  const registry = new Registry(f.home);
  const { entry } = await registry.reserve(
    { runtime: "codex", kind: "task", cwd: f.root },
    10,
  );
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},200)"]);
  const root = (await processRef(child.pid!))!;
  await new Promise((r) => child.once("exit", r));
  const exitPath = join(f.root, "exit.json");
  await writeFile(exitPath, '{"code":0,"signal":null}');
  await registry.update(entry.launchId, {
    status: "running",
    root,
    exitPath,
    stopRequestedAt: new Date(Date.now() + 60_000).toISOString(),
  });
  expect(
    (await registry.all()).find((e) => e.launchId === entry.launchId)?.status,
  ).toBe("exited");
});
