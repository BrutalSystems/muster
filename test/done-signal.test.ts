import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fixture, lines } from "./helpers.js";
import { asSession, asTask } from "./narrow.js";
import { testServer } from "./global-setup.js";
import { Muster, UnknownRun } from "../src/run.js";
import { Registry } from "../src/registry.js";
import { PtyHost } from "../src/hosts/pty.js";
import { TmuxHost } from "../src/hosts/tmux.js";
import { delay } from "../src/identity/processes.js";
import { onExitEnv } from "../src/on-exit.js";
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
      expect(await new Registry(f.home).claimOnExit(task.id)).toBe(false);
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
