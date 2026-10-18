import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertResumable,
  launchArgs,
  resolveResume,
  runSchema,
  runtimeArgs,
} from "../src/guard.js";
import { configSchema } from "../src/config.js";
import { Muster } from "../src/run.js";
import { PtyHost } from "../src/hosts/pty.js";
import { Registry } from "../src/registry.js";
import { fixture } from "./helpers.js";
import { asSession, asTask } from "./narrow.js";

const ID = "a130ac07-7eab-4803-8661-1517c75812a4";
const empty = configSchema.parse({});
const req = (over: Record<string, unknown>) =>
  runSchema.parse({ runtime: "claude", prompt: "ping", ...over });

test("--resume is resolved from the flag or from after --, one way only", () => {
  expect(resolveResume(req({ resume: ID }))).toEqual({ id: ID, fork: false });
  expect(resolveResume(req({ args: ["--resume", ID] }))).toEqual({
    id: ID,
    fork: false,
  });
  expect(resolveResume(req({ args: ["-r", ID, "--fork-session"] }))).toEqual({
    id: ID,
    fork: true,
  });
  expect(resolveResume(req({ args: [`--resume=${ID}`] }))?.id).toBe(ID);
  expect(resolveResume(req({}))).toBeNull();
  expect(() =>
    resolveResume(req({ resume: ID, args: ["--resume", ID] })),
  ).toThrow(/twice/);
});

test("--resume takes a session id, never a search term or nothing", () => {
  // A bare --resume, or a search term, opens Claude's picker, which a muster
  // launch has no one to answer.
  expect(() => resolveResume(req({ resume: "my session" }))).toThrow(/UUID/);
  expect(() => resolveResume(req({ args: ["--resume"] }))).toThrow(
    /Missing value/,
  );
  expect(() =>
    resolveResume(req({ args: ["--resume", "--fork-session"] })),
  ).toThrow(/Missing value/);
  expect(() => resolveResume(req({ forkSession: true }))).toThrow(
    /only with --resume/,
  );
  expect(() => resolveResume(req({ args: ["--fork-session"] }))).toThrow(
    /only with --resume/,
  );
});

test("--resume is claude's alone", () => {
  for (const runtime of ["codex", "opencode"])
    expect(() => resolveResume(req({ runtime, resume: ID }))).toThrow(
      /claude only/,
    );
  // After --, the allowlist refuses it for the others as before.
  expect(() =>
    runtimeArgs(req({ runtime: "codex", args: ["--resume", ID] })),
  ).toThrow(/refused/);
});

test("the resume flags are consumed, then delivered once by muster", () => {
  expect(
    runtimeArgs(req({ args: ["--resume", ID, "--fork-session"] })),
  ).toEqual([]);
  expect(() =>
    runtimeArgs(req({ args: ["--fork-session=yes", "-r", ID] })),
  ).toThrow(/takes no value/);
  for (const level of ["normal", "work"]) {
    const argv = launchArgs(
      req({ level, args: ["--resume", ID, "--name", "n"] }),
      empty,
    );
    const at = argv.indexOf("--resume");
    expect(argv.filter((a) => a === "--resume")).toHaveLength(1);
    expect(argv[at + 1]).toBe(ID);
    expect(argv).not.toContain("--fork-session");
    // Before the prompt separator, so the prompt is the resumed session's
    // next message rather than a value.
    expect(at).toBeLessThan(argv.indexOf("--"));
    expect(argv.at(-1)).toBe("ping");
  }
  expect(launchArgs(req({ resume: ID, forkSession: true }), empty)).toContain(
    "--fork-session",
  );
});

async function profile(root: string) {
  const configDir = join(root, "profile");
  await mkdir(join(configDir, "projects", "-some-project"), {
    recursive: true,
  });
  await mkdir(join(configDir, "sessions"), { recursive: true });
  return { configDir, env: { CLAUDE_CONFIG_DIR: configDir } };
}

test("a resume needs the conversation in the profile the launch opens", async () => {
  const f = await fixture();
  const { configDir, env } = await profile(f.root);
  expect(() => assertResumable({ id: ID, fork: false }, env, f.root)).toThrow(
    /No Claude conversation/,
  );
  await writeFile(
    join(configDir, "projects", "-some-project", ID + ".jsonl"),
    "",
  );
  expect(() =>
    assertResumable({ id: ID, fork: false }, env, f.root),
  ).not.toThrow();
});

test("a conversation recorded in another directory is not resumed here", async () => {
  const f = await fixture();
  const { configDir, env } = await profile(f.root);
  const other = join(f.root, "elsewhere");
  await mkdir(other);
  await writeFile(
    join(configDir, "projects", "-some-project", ID + ".jsonl"),
    JSON.stringify({ type: "queue-operation", sessionId: ID }) +
      "\n" +
      JSON.stringify({ sessionId: ID, cwd: other }) +
      "\n",
  );
  expect(() => assertResumable({ id: ID, fork: false }, env, f.root)).toThrow(
    /was recorded in .*elsewhere.*--cwd/,
  );
  expect(() =>
    assertResumable({ id: ID, fork: false }, env, other),
  ).not.toThrow();
});

test("a running session is not resumed twice, but may be forked", async () => {
  const f = await fixture();
  const { configDir, env } = await profile(f.root);
  await writeFile(
    join(configDir, "projects", "-some-project", ID + ".jsonl"),
    "",
  );
  await writeFile(
    join(configDir, "sessions", "4242.json"),
    JSON.stringify({ pid: 4242, sessionId: ID }),
  );
  expect(() =>
    assertResumable({ id: ID, fork: false }, env, f.root, () => true),
  ).toThrow(/is running \(pid 4242\)/);
  // A record left by a process that has exited does not hold the session.
  expect(() =>
    assertResumable({ id: ID, fork: false }, env, f.root, () => false),
  ).not.toThrow();
  expect(() =>
    assertResumable({ id: ID, fork: true }, env, f.root, () => true),
  ).not.toThrow();
});

async function launcher(extra: Record<string, string> = {}) {
  const f = await fixture(extra);
  const { configDir } = await profile(f.root);
  await writeFile(
    join(configDir, "projects", "-some-project", ID + ".jsonl"),
    JSON.stringify({ sessionId: ID, cwd: f.root }) + "\n",
  );
  const env = { ...f.env, CLAUDE_CONFIG_DIR: configDir };
  const m = await Muster.create({
    home: f.home,
    env,
    drivers: [new PtyHost()],
  });
  const starts = async () =>
    (await readFile(join(f.root, "starts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  return { f, m, starts };
}

test("a resumed session reports the resumed session id, not a new one", async () => {
  const { f, m, starts } = await launcher();
  try {
    const peer = asSession(
      await m.run({
        runtime: "claude",
        prompt: "carry on",
        cwd: f.root,
        host: "pty",
        resume: ID,
      }),
    );
    expect(peer.session_id).toBe(ID);
    expect(peer.canonical_id.endsWith("." + ID)).toBe(true);
    const listed: any = (await m.list("session")).find(
      (r: any) => r.session_id === ID,
    );
    expect(listed).toBeDefined();
    const [start] = await starts();
    expect(start.argv).toContain("--resume");
    expect(start.prompt).toBe("carry on");
  } finally {
    await m.close();
  }
}, 15000);

test("a forked session reports its new id", async () => {
  const { f, m } = await launcher();
  try {
    const peer = asSession(
      await m.run({
        runtime: "claude",
        prompt: "carry on",
        cwd: f.root,
        host: "pty",
        args: ["--resume", ID, "--fork-session"],
      }),
    );
    expect(peer.session_id).not.toBe(ID);
  } finally {
    await m.close();
  }
}, 15000);

test("a task can resume too", async () => {
  const { f, m, starts } = await launcher();
  try {
    const task = asTask(
      await m.run({
        runtime: "claude",
        kind: "task",
        prompt: "carry on",
        cwd: f.root,
        resume: ID,
      }),
    );
    for (let i = 0; i < 50; i++) {
      if ((await m.list("task"))[0]?.state === "exited") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await m.output(task.id)).toContain("TASK_OUTPUT:carry on");
    const [start] = await starts();
    expect(start.argv).toEqual(expect.arrayContaining(["-p", "--resume", ID]));
  } finally {
    await m.close();
  }
}, 15000);

test("a refused resume leaves nothing reserved", async () => {
  const { f, m } = await launcher();
  try {
    await expect(
      m.run({
        runtime: "claude",
        prompt: "carry on",
        cwd: f.root,
        host: "pty",
        resume: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toThrow(/No Claude conversation/);
    expect(await m.list()).toEqual([]);
  } finally {
    await m.close();
  }
}, 15000);

test("a resume that registers some other session fails, never reports a new one", async () => {
  const { f, m } = await launcher({ MUSTER_FAKE_IGNORE_RESUME: "1" });
  await writeFile(join(f.home, "config.toml"), "launch_timeout_sec = 2\n");
  const m2 = await Muster.create({
    home: f.home,
    env: { ...f.env, CLAUDE_CONFIG_DIR: join(f.root, "profile") },
    drivers: [new PtyHost()],
  });
  await m.close();
  try {
    await expect(
      m2.run({
        runtime: "claude",
        prompt: "carry on",
        cwd: f.root,
        host: "pty",
        resume: ID,
      }),
    ).rejects.toThrow(/instead of resuming/);
    expect(
      (await m2.list("session")).some((r: any) => r.state === "running"),
    ).toBe(false);
  } finally {
    await m2.close();
  }
}, 15000);

test("a session muster ran before can be resumed, and its id names the new launch", async () => {
  const { f, m } = await launcher();
  try {
    const first = asSession(
      await m.run({
        runtime: "claude",
        prompt: "first",
        cwd: f.root,
        host: "pty",
        resume: ID,
      }),
    );
    await m.stop(first.session_id!);
    const again = asSession(
      await m.run({
        runtime: "claude",
        prompt: "again",
        cwd: f.root,
        host: "pty",
        resume: ID,
      }),
    );
    expect(again.session_id).toBe(ID);
    expect(again.pid).not.toBe(first.pid);
    // The reaper stops by launch id: the old launch's id must not reach the
    // launch running the session now.
    const [old] = (await new Registry(f.home).all()).filter(
      (e) => e.id === ID && e.status === "stopped",
    );
    await m.stop(old!.launchId);
    expect(
      (await m.list("session")).some(
        (r: any) =>
          r.session_id === ID && r.pid === again.pid && r.state !== "stopped",
      ),
    ).toBe(true);
    // By durable id, stop reaches the launch running it now, not the old one.
    await m.stop(ID);
    const entries = (await m.list("session")).filter(
      (r: any) => r.session_id === ID,
    );
    expect(entries.every((r: any) => r.state !== "running")).toBe(true);
    expect(entries.length).toBe(2);
  } finally {
    await m.close();
  }
}, 20000);
