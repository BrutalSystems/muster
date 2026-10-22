import { expect, test } from "vitest";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectExecutable } from "../src/executable.js";
import { launchEnv } from "../src/guard.js";
import { Muster, durableId } from "../src/run.js";
import { PtyHost } from "../src/hosts/pty.js";
import { fixture, lines } from "./helpers.js";

/**
 * `--executable` runs a named binary instead of the runtime on PATH. The
 * property under test is that EVERY program Muster runs for the launch is that
 * binary — the launch and each probe — so the fixtures break the PATH copy:
 * any spawn that still finds the runtime by name fails the launch.
 */
async function script(dir: string, name: string, body: string) {
  const file = join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

/** A task returns before its process has written its start record. */
async function firstStart(root: string) {
  await expect
    .poll(async () => (await lines(join(root, "starts.jsonl"))).length)
    .toBeGreaterThan(0);
  return lines(join(root, "starts.jsonl"));
}

/** The fake runtime copied outside PATH, and the PATH copy made to fail. */
async function pinned(runtime: "codex" | "claude", version: string) {
  const f = await fixture({ MUSTER_FAKE_VERSION: version });
  const dir = join(f.root, "pinned");
  await mkdir(dir);
  const exe = join(dir, runtime);
  await copyFile(new URL("./fakes/runtime.cjs", import.meta.url), exe);
  await chmod(exe, 0o755);
  await script(f.bin, runtime, "exit 97");
  return { f, exe };
}

test("a path that is not an absolute executable file is refused", async () => {
  const f = await fixture();
  const plain = join(f.root, "plain");
  await writeFile(plain, "");
  await expect(inspectExecutable("codex", "codex", f.env)).rejects.toThrow(
    /must be an absolute path/,
  );
  await expect(
    inspectExecutable("codex", join(f.root, "missing"), f.env),
  ).rejects.toThrow(/not an executable file/);
  await expect(inspectExecutable("codex", f.root, f.env)).rejects.toThrow(
    /not an executable file/,
  );
  await expect(inspectExecutable("codex", plain, f.env)).rejects.toThrow(
    /not an executable file/,
  );
});

test("a binary whose --version is another runtime's is refused", async () => {
  const f = await fixture();
  const claude = await script(f.root, "claude", 'echo "2.1.400 (Claude Code)"');
  await expect(inspectExecutable("codex", claude, f.env)).rejects.toThrow(
    /is not codex/,
  );
  await expect(inspectExecutable("claude", claude, f.env)).resolves.toEqual({
    path: claude,
    version: "2.1.400",
    noDaemon: false,
  });
  const failing = await script(f.root, "broken", "exit 1");
  await expect(inspectExecutable("opencode", failing, f.env)).rejects.toThrow(
    /did not answer --version/,
  );
});

test("a Codex is kept off the daemon only when it has the flag", async () => {
  const f = await fixture();
  const current = await script(
    f.root,
    "codex-current",
    'case "$1" in --version) echo "codex-cli 0.163.0";; --help) echo "      --no-daemon";; esac',
  );
  const old = await script(
    f.root,
    "codex-old",
    'case "$1" in --version) echo "codex-cli 0.120.0";; --help) echo "Usage: codex";; esac',
  );
  expect(await inspectExecutable("codex", current, f.env)).toMatchObject({
    version: "0.163.0",
    noDaemon: true,
  });
  expect(await inspectExecutable("codex", old, f.env)).toMatchObject({
    version: "0.120.0",
    noDaemon: false,
  });
});

test("CODEX_MANAGED_* never reaches a launch", () => {
  // codex.js sets them to describe its own package; a native binary run
  // directly would otherwise inherit a description of some other install.
  expect(
    launchEnv({
      CODEX_MANAGED_BY_NPM: "1",
      CODEX_MANAGED_PACKAGE_ROOT: "/elsewhere",
      KEEP: "yes",
    }),
  ).toEqual({ KEEP: "yes" });
});

for (const kind of ["session", "task"] as const)
  test(`a Codex ${kind} runs and is probed through the named binary`, async () => {
    const { f, exe } = await pinned("codex", "codex-cli 0.150.0");
    const m = await Muster.create({
      home: f.home,
      env: { ...f.env, MUSTER_FAKE_TASK_MS: "5000" },
      drivers: [new PtyHost()],
    });
    try {
      const result = await m.run({
        runtime: "codex",
        kind,
        cwd: f.root,
        prompt: "hello",
        level: "read",
        executable: exe,
        ...(kind === "session" ? { host: "pty" } : {}),
      });
      const executable = { path: exe, version: "0.150.0" };
      expect(result).toMatchObject({ executable });
      const [start] = await firstStart(f.root);
      expect(start.exe).toBe(exe);
      expect(start.argv.includes("--no-daemon")).toBe(kind === "session");
      // `list` refreshes a Codex session over the app-server; the PATH copy
      // exits 97, so a refresh that reached it would report it unreachable.
      const listed = (await m.list())[0]!;
      expect(listed).toMatchObject({ executable });
      if (kind === "session") expect(listed).toMatchObject({ state: "idle" });
      const id = durableId(result);
      expect((await m.wait(id, { timeoutMs: 0 })).record).toMatchObject({
        executable,
      });
      const entry = (await m.registry.all())[0]!;
      await expect(
        m.registry.update(entry.launchId, { executable } as any),
      ).rejects.toThrow(/cannot be updated/);
      await m.stop(id);
    } finally {
      await m.close();
    }
  });

test("a Claude task runs the named binary", async () => {
  const { f, exe } = await pinned("claude", "2.1.400 (Claude Code)");
  const m = await Muster.create({
    home: f.home,
    env: { ...f.env, MUSTER_FAKE_TASK_MS: "5000" },
  });
  try {
    const result = await m.run({
      runtime: "claude",
      kind: "task",
      cwd: f.root,
      prompt: "hello",
      executable: exe,
    });
    expect(result).toMatchObject({
      executable: { path: exe, version: "2.1.400" },
    });
    const [start] = await firstStart(f.root);
    expect(start.exe).toBe(exe);
    await m.stop(durableId(result));
  } finally {
    await m.close();
  }
});

test("a refused executable leaves nothing reserved", async () => {
  const { f, exe } = await pinned("claude", "2.1.400 (Claude Code)");
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    await expect(
      m.run({
        runtime: "codex",
        kind: "task",
        cwd: f.root,
        prompt: "hello",
        level: "read",
        executable: exe,
      }),
    ).rejects.toThrow(/is not codex/);
    expect(await m.registry.all()).toHaveLength(0);
  } finally {
    await m.close();
  }
});

test("a request key reused with another executable is refused", async () => {
  const { f, exe } = await pinned("codex", "codex-cli 0.150.0");
  const other = join(f.root, "other-codex");
  await copyFile(exe, other);
  await chmod(other, 0o755);
  const m = await Muster.create({
    home: f.home,
    env: { ...f.env, MUSTER_FAKE_TASK_MS: "5000" },
  });
  const req = {
    runtime: "codex",
    kind: "task",
    cwd: f.root,
    prompt: "hello",
    level: "read",
    requestKey: "pinned",
  } as const;
  try {
    const first = await m.run({ ...req, executable: exe });
    expect(await m.run({ ...req, executable: exe })).toMatchObject({
      launch_id: first.launch_id,
    });
    await expect(m.run({ ...req, executable: other })).rejects.toThrow();
    await m.stop(durableId(first));
  } finally {
    await m.close();
  }
});

test("an OpenCode task is probed and run through the named binary", async () => {
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "5000" });
  const dir = join(f.root, "pinned");
  await mkdir(dir);
  const exe = join(dir, "opencode");
  await copyFile(new URL("./fakes/opencode.cjs", import.meta.url), exe);
  await chmod(exe, 0o755);
  // The version check, the config probes and the task all fail on this copy.
  await script(f.bin, "opencode", "exit 97");
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    const result = await m.run({
      runtime: "opencode",
      kind: "task",
      cwd: f.root,
      prompt: "hello",
      executable: exe,
    });
    expect(result).toMatchObject({
      executable: { path: exe, version: "1.18.31" },
    });
    const [start] = await firstStart(f.root);
    expect(start).toMatchObject({ runtime: "opencode", prompt: "hello" });
    await m.stop(durableId(result));
  } finally {
    await m.close();
  }
});
