import { test, expect } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, unknownConfigKeys } from "../src/config.js";
import { launchArgs, runSchema } from "../src/guard.js";
import { LaunchLog } from "../src/log.js";
import { runtimeName } from "../src/naming.js";
import { Registry } from "../src/registry.js";

test.each([
  ["codex", "codex"],
  ["claude", "claude-code"],
  ["opencode", "opencode"],
] as const)("maps the %s runtime to the %s peer namespace", (runtime, name) => {
  expect(runtimeName(runtime)).toBe(name);
});

test("run schema accepts OpenCode sessions and tasks", () => {
  expect(
    runSchema.parse({ runtime: "opencode", prompt: "review" }).runtime,
  ).toBe("opencode");
  expect(
    runSchema.parse({
      runtime: "opencode",
      kind: "task",
      prompt: "summarize",
    }).kind,
  ).toBe("task");
});

test("config is read-only, refuses invalid values, and ignores unknown keys", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-policy-"));
  const path = join(home, "config.toml");
  const config = await loadConfig(home);
  expect(config.max_concurrent).toBe(4);
  await expect(readFile(path)).rejects.toThrow();
  const original = 'max_concurrent = 2\nhost = "pty"\n';
  await writeFile(path, original);
  expect((await loadConfig(home)).host).toBe("pty");
  expect(await readFile(path, "utf8")).toBe(original);
  for (const contents of [
    "max_concurrent = 0",
    "launch_timeout_sec = -1",
    'sandbox = "workspce-write"',
  ]) {
    await writeFile(path, contents);
    await expect(loadConfig(home)).rejects.toThrow();
  }
  // An unknown KEY is tolerated, where an invalid VALUE above is not. A config
  // written for a newer Muster must not brick an older one — a strict top level
  // is what made every 0.10.0 command fail once `terminal` was added — while a
  // silently dropped `sandbox` value would launch under the default instead of
  // what the operator wrote.
  await writeFile(path, "max_concurrent = 2\nsurprise = true\n");
  expect((await loadConfig(home)).max_concurrent).toBe(2);
  expect(unknownConfigKeys({ max_concurrent: 2, surprise: true })).toEqual([
    "surprise",
  ]);
});
for (const flag of [
  "--dangerously-skip-permissions",
  "--dangerously-skip-permissions=true",
  "--dangerously-bypass-approvals-and-sandbox",
  "--approve-for-me",
  "--yolo",
  "-y",
  "-ay",
  "--permission-mode=bypassPermissions",
  '--config=sandbox_mode="danger-full-access"',
  "-cfoo",
  "--settings={}",
]) {
  test(`refuses untrusted runtime option ${flag}`, async () => {
    const config = await loadConfig(
      await mkdtemp(join(tmpdir(), "muster-policy-")),
    );
    expect(() =>
      launchArgs(
        runSchema.parse({ runtime: "codex", prompt: "hello", args: [flag] }),
        config,
      ),
    ).toThrow();
  });
}
test("prompt is mandatory and cannot be interpreted as a flag or shell program", async () => {
  for (const prompt of ["", "  ", "\n"])
    expect(() => runSchema.parse({ runtime: "codex", prompt })).toThrow();
  const config = await loadConfig(
    await mkdtemp(join(tmpdir(), "muster-policy-")),
  );
  const prompt = "--yolo $(touch /tmp/muster-should-not-exist)";
  const args = launchArgs(
    runSchema.parse({ runtime: "codex", prompt, kind: "task" }),
    config,
  );
  expect(args.slice(-2)).toEqual(["--", prompt]);
  expect(args).toContain("read-only");
  const claude = launchArgs(
    runSchema.parse({ runtime: "claude", prompt: "hi" }),
    config,
  );
  expect(claude).not.toContain("--dangerously-skip-permissions");
  expect(claude[claude.indexOf("--tools") + 1]).toBe("default");
  const settings = JSON.parse(claude[claude.indexOf("--settings") + 1]!);
  expect(settings.sandbox).toMatchObject({
    enabled: true,
    allowUnsandboxedCommands: false,
    failIfUnavailable: true,
  });
});
test("log records survive a new reader and include requester", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-log-"));
  await new LaunchLog(home).write({
    event: "intent",
    requester: "cli",
    prompt: "hello",
    host: "pty",
  });
  expect(
    JSON.parse((await readFile(join(home, "launches.jsonl"), "utf8")).trim()),
  ).toMatchObject({ event: "intent", requester: "cli", prompt: "hello" });
});
test("registry counts pending launches atomically and retains durable identity", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-registry-"));
  const a = new Registry(home),
    b = new Registry(home);
  const request = {
    runtime: "codex" as const,
    kind: "session" as const,
    cwd: process.cwd(),
  };
  const results = await Promise.allSettled([
    a.reserve(request, 1),
    b.reserve(request, 1),
  ]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  const winner = results.find((x) => x.status === "fulfilled")!;
  if (winner.status !== "fulfilled") throw new Error("no reservation");
  await a.update(winner.value.entry.id, { status: "stopped" });
  const { entry: next } = await b.reserve(request, 1);
  await b.update(next.id, { id: "durable-123", status: "running" });
  expect((await a.all()).some((x) => x.id === "durable-123")).toBe(true);
});

test("Codex inherited MCP entries are disabled explicitly and checked before launch", async () => {
  const { fixture } = await import("./helpers.js");
  const { codexPolicyArgs } = await import("../src/codex-policy.js");
  const f = await fixture({ MUSTER_FAKE_MCP: "muster,tincan" });
  const args = await codexPolicyArgs(f.env, f.root);
  expect(args).toContain("mcp_servers.muster.enabled=false");
  expect(args).toContain("mcp_servers.tincan.enabled=false");
  expect(args).toContain("hooks");
  f.env.MUSTER_FAKE_IGNORE_MCP_DISABLE = "1";
  await expect(codexPolicyArgs(f.env, f.root)).rejects.toThrow(
    /remain enabled/,
  );
});

test("Codex does not disable inherited servers a task launch never loads", async () => {
  const { fixture } = await import("./helpers.js");
  const { codexPolicyArgs } = await import("../src/codex-policy.js");
  const f = await fixture({ MUSTER_FAKE_MCP: "muster,tincan" });

  // A session reads the user config, so inherited servers are real and must be
  // disabled explicitly.
  const session = await codexPolicyArgs(f.env, f.root, undefined, [], false);
  expect(session).toContain("mcp_servers.muster.enabled=false");

  // A task launches with --ignore-user-config, so those servers are not there.
  // Disabling one anyway CREATES the key with neither command nor url, and
  // Codex rejects the whole config with "invalid transport".
  const task = await codexPolicyArgs(f.env, f.root, undefined, [], true);
  expect(task).not.toContain("mcp_servers.muster.enabled=false");
  expect(task).not.toContain("mcp_servers.tincan.enabled=false");
  expect(task.some((a) => a.includes(".enabled=false"))).toBe(false);
  // The rest of the policy is unaffected.
  expect(task).toContain("hooks");
  // And the flag is never passed to `codex mcp list`, which rejects it.
  expect(task).not.toContain("--ignore-user-config");
});

test("Claude refuses detected managed policy that cannot be verified", async () => {
  const { assertClaudePolicy } = await import("../src/claude-policy.js");
  const dir = await mkdtemp(join(tmpdir(), "muster-managed-"));
  await mkdir(join(dir, ".claude"));
  await writeFile(
    join(dir, ".claude", "remote-settings.json"),
    JSON.stringify({ sandbox: { enabled: false } }),
  );
  await expect(assertClaudePolicy({ HOME: dir })).rejects.toThrow(/managed/i);
});

test("registry refuses an ambiguous durable-id update across runtimes", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-namespace-")),
    registry = new Registry(home);
  const { entry: a } = await registry.reserve(
    { runtime: "codex", kind: "session", cwd: home },
    4,
  );
  const { entry: b } = await registry.reserve(
    { runtime: "claude", kind: "session", cwd: home },
    4,
  );
  await registry.update(a.launchId, { id: "same-id" });
  await registry.update(b.launchId, { id: "same-id" });
  await expect(
    registry.update("same-id", { status: "stopped" }),
  ).rejects.toThrow(/ambiguous/i);
});
