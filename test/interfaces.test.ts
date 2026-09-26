import { test, expect } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { fixture, lines } from "./helpers.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { processRef, delay } from "../src/identity/processes.js";
const cli = join(process.cwd(), "dist/muster.js");
const exec = promisify(execFile);
test("CLI task returns, output survives, and another CLI process can list it", async () => {
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "300" });
  // Production state always follows HOME/.muster; no hidden test-only runtime switch.
  const env = { ...f.env };
  const task = JSON.parse(
    (
      await exec(
        process.execPath,
        [
          cli,
          "run",
          "claude",
          "--kind",
          "task",
          "--prompt",
          "CLI task",
          "--cwd",
          f.root,
        ],
        { env },
      )
    ).stdout,
  );
  expect(task.kind).toBe("task");
  let listing: any[] = [];
  for (let i = 0; i < 30; i++) {
    listing = JSON.parse(
      (await exec(process.execPath, [cli, "list"], { env })).stdout,
    );
    if (listing[0]?.state === "exited") break;
    await delay(50);
  }
  expect(listing[0]).toMatchObject({
    kind: "task",
    state: "exited",
    exit_code: 0,
  });
  expect(
    (await exec(process.execPath, [cli, "output", task.id], { env })).stdout,
  ).toContain("TASK_OUTPUT:CLI task");
}, 10000);

test("CLI OpenCode tasks use the OpenCode worker path and reject session-only options", async () => {
  const f = await fixture();
  const invoke = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], { env: f.env });
  const task = JSON.parse(
    (
      await invoke(
        "run",
        "opencode",
        "--kind",
        "task",
        "--prompt",
        "OpenCode CLI task",
        "--cwd",
        f.root,
      )
    ).stdout,
  );
  expect(task).toMatchObject({
    kind: "task",
    runtime: "opencode",
    state: "running",
  });
  expect(task).not.toHaveProperty("canonical_id");
  expect(task).not.toHaveProperty("session_id");
  expect(task).not.toHaveProperty("server_url");
  for (let attempt = 0; attempt < 40; attempt++) {
    if (
      JSON.parse((await invoke("list", "--kind", "task")).stdout)[0]?.state ===
      "exited"
    )
      break;
    await delay(25);
  }
  expect((await invoke("output", task.id)).stdout).toContain(
    "TASK_OUTPUT:OpenCode CLI task",
  );
  expect((await lines(join(f.root, "starts.jsonl")))[0]).toMatchObject({
    runtime: "opencode",
    argv: ["run", "--format", "json", "--pure", "--", "OpenCode CLI task"],
  });

  for (const args of [["--host", "pty"], ["--open"]])
    await expect(
      invoke(
        "run",
        "opencode",
        "--kind",
        "task",
        "--prompt",
        "blocked OpenCode task",
        "--cwd",
        f.root,
        ...args,
      ),
    ).rejects.toThrow(args[0] === "--host" ? /host applies only/ : /--open/);
  expect(await lines(join(f.root, "starts.jsonl"))).toHaveLength(1);
}, 10000);
test("MCP uses the same tools, no stdout diagnostics, and closing stops owned pty", async () => {
  const f = await fixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    env: f.env,
    stderr: "pipe",
  });
  const client = new Client({ name: "muster-test", version: "1" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "list",
      "output",
      "run",
      "stop",
    ]);
    expect(
      tools.tools.find((t) => t.name === "run")?.inputSchema.properties
        ?.terminal,
    ).toMatchObject({ enum: ["auto", "terminal", "iterm2", "ghostty"] });
    expect(
      tools.tools.find((t) => t.name === "run")?.inputSchema.properties?.mcp,
    ).toMatchObject({ type: "array" });
    const r = await client.callTool({
      name: "run",
      arguments: {
        runtime: "claude",
        prompt: "MCP peer",
        mcp: [],
        permissions: "auto",
        sandbox: "workspace-write",
        cwd: f.root,
        host: "pty",
      },
    });
    expect(r.isError).not.toBe(true);
    const peer = JSON.parse((r.content as any)[0].text);
    expect(peer.session_id).toBeTruthy();
    expect(peer).toMatchObject({
      permissions: "auto",
      sandbox: "workspace-write",
    });
    const started = (await lines(join(f.root, "starts.jsonl")))[0];
    expect(started.argv[started.argv.indexOf("--permission-mode") + 1]).toBe(
      "auto",
    );
    const denied = await client.callTool({
      name: "run",
      arguments: {
        runtime: "codex",
        prompt: "blocked",
        permissions: "bypass",
        sandbox: "full-access",
      },
    });
    expect(denied.isError).toBe(true);
    const invalid = await client.callTool({
      name: "run",
      arguments: { runtime: "codex", prompt: "   " },
    });
    expect(invalid.isError).toBe(true);
    await client.close();
    for (let i = 0; i < 40 && (await processRef(peer.pid)); i++)
      await delay(50);
    expect(await processRef(peer.pid)).toBeUndefined();
  } finally {
    await client.close();
  }
}, 10000);
test("CLI pty prints a result but stays alive until stopped", async () => {
  const f = await fixture();
  const child = spawn(
    process.execPath,
    [
      cli,
      "run",
      "claude",
      "--prompt",
      "owned pty",
      "--host",
      "pty",
      "--cwd",
      f.root,
    ],
    { env: f.env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let buffer = "";
  const result = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no CLI record")), 5000);
    child.stdout.on("data", (d) => {
      buffer += d;
      if (buffer.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(buffer.split("\n")[0]!));
      }
    });
    child.on("error", reject);
  });
  try {
    const peer = await result;
    expect(child.exitCode).toBeNull();
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    expect(await processRef(peer.pid)).toBeUndefined();
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}, 10000);
test("separate CLI processes share a concurrency cap", async () => {
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "5000" });
  const home = join(f.root, ".muster");
  await import("node:fs/promises").then((fs) => fs.mkdir(home));
  await writeFile(join(home, "config.toml"), "max_concurrent=1\n");
  const args = [
    cli,
    "run",
    "codex",
    "--kind",
    "task",
    "--prompt",
    "capacity",
    "--cwd",
    f.root,
  ];
  const results = await Promise.allSettled([
    exec(process.execPath, args, { env: f.env }),
    exec(process.execPath, args, { env: f.env }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const winner = results.find((r) => r.status === "fulfilled");
  if (winner?.status === "fulfilled") {
    const task = JSON.parse(winner.value.stdout);
    await exec(process.execPath, [cli, "stop", task.id], { env: f.env });
  }
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { stderr: expect.stringContaining("Concurrency cap") },
  });
}, 10000);

test("CLI human run/list/stop works while JSON stays the default", async () => {
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "5000" });
  const invoke = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], { env: f.env });
  let id: string | undefined;
  try {
    const run = await invoke(
      "run",
      "claude",
      "--kind",
      "task",
      "--prompt",
      "human task",
      "--cwd",
      f.root,
      "--format",
      "human",
    );
    id = run.stdout.match(/ID: ([^\n]+)/)?.[1];
    expect(id).toBeTruthy();
    expect(run.stdout).toContain(`Output: muster output ${id}`);
    const standard = JSON.parse((await invoke("list")).stdout);
    const explicit = JSON.parse(
      (await invoke("list", "--format", "json")).stdout,
    );
    expect(explicit).toEqual(standard);
    expect(standard[0].id).toBe(id);
    const human = await invoke("list", "--kind", "task", "--format", "human");
    expect(human.stdout).toContain(`ID: ${id}`);
    expect(human.stdout).toContain("claude · task · running");
    expect((await invoke("stop", id!, "--format", "human")).stdout).toBe(
      `Stopped ${id}.\n`,
    );
    expect((await invoke("stop", id!, "--format", "json")).stdout).toBe(
      JSON.stringify({ stopped: true, id }) + "\n",
    );
  } finally {
    if (id) await invoke("stop", id);
  }
}, 10000);

test("CLI rejects invalid formats before launch and keeps output unformatted", async () => {
  const f = await fixture();
  const invoke = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], { env: f.env });
  await expect(
    invoke("run", "claude", "--prompt", "no launch", "--format", "yaml"),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("format must be json or human"),
  });
  expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
  await expect(
    invoke("output", "some-id", "--format", "human"),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("output prints raw task text"),
  });
  expect((await invoke("list", "--format", "human")).stdout).toBe(
    "No Muster runs.\n",
  );
});

test("CLI normalized permissions reach the runtime, registry and intent log", async () => {
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "5000" });
  const invoke = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], { env: f.env });
  const result = JSON.parse(
    (
      await invoke(
        "run",
        "codex",
        "--kind",
        "task",
        "--prompt",
        "auto task",
        "--cwd",
        f.root,
        "--permissions",
        "auto",
        "--sandbox",
        "workspace-write",
      )
    ).stdout,
  );
  try {
    expect(result).toMatchObject({
      permissions: "auto",
      sandbox: "workspace-write",
    });
    const records = JSON.parse((await invoke("list")).stdout);
    expect(records[0]).toMatchObject({
      permissions: "auto",
      sandbox: "workspace-write",
    });
    const intent = (
      await lines(join(f.root, ".muster", "launches.jsonl"))
    ).find((e) => e.event === "intent");
    expect(intent).toMatchObject({
      permissions: "auto",
      sandbox: "workspace-write",
    });
    let starts: any[] = [];
    for (let i = 0; i < 30; i++) {
      starts = await lines(join(f.root, "starts.jsonl"));
      if (starts.length) break;
      await delay(50);
    }
    expect(starts[0].argv).toContain("--approve-for-me");
    const human = (await invoke("list", "--format", "human")).stdout;
    expect(human).toContain("Permissions: auto");
    expect(human).toContain("Sandbox: workspace-write");
  } finally {
    await invoke("stop", result.id);
  }
  await expect(
    invoke(
      "run",
      "claude",
      "--prompt",
      "blocked",
      "--permissions",
      "bypass",
      "--sandbox",
      "full-access",
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("allow_dangerous_flags"),
  });
  expect(await lines(join(f.root, "starts.jsonl"))).toHaveLength(1);
}, 10000);

test("CLI --level is accepted, reaches the runtime, and refuses the contradiction", async () => {
  // The flag existed in the README and the release notes before it existed on
  // the CLI: parseArgs runs strict, so an unlisted option is "Unknown option"
  // rather than an ignored one. `work` rather than `read` for the launch,
  // because `read` is byte-identical to the shipped defaults and would pass
  // with the option silently dropped.
  const f = await fixture();
  const invoke = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], { env: f.env });
  const worked = JSON.parse(
    (
      await invoke(
        "run",
        "codex",
        "--kind",
        "task",
        "--prompt",
        "level task",
        "--cwd",
        f.root,
        "--level",
        "work",
      )
    ).stdout,
  );
  expect(worked).toMatchObject({
    permissions: "auto",
    sandbox: "workspace-write",
  });
  let starts: any[] = [];
  for (let i = 0; i < 30 && !starts.length; i++) {
    starts = await lines(join(f.root, "starts.jsonl"));
    if (!starts.length) await delay(50);
  }
  expect(starts[0].argv).toContain("--approve-for-me");
  const read = JSON.parse(
    (
      await invoke(
        "run",
        "codex",
        "--kind",
        "task",
        "--prompt",
        "read task",
        "--cwd",
        f.root,
        "--level",
        "read",
      )
    ).stdout,
  );
  expect(read).toMatchObject({ permissions: "deny", sandbox: "read-only" });
  // `assertLevelExclusive` reads the raw argv object, where parseArgs omits an
  // unset option rather than setting it undefined — so the contradiction fires
  // only when both were actually typed, which these three calls prove.
  await expect(
    invoke(
      "run",
      "codex",
      "--kind",
      "task",
      "--prompt",
      "contradiction",
      "--cwd",
      f.root,
      "--level",
      "read",
      "--permissions",
      "deny",
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining(
      "use level or permissions/sandbox, not both",
    ),
  });
  expect(await lines(join(f.root, "starts.jsonl"))).toHaveLength(2);
}, 15000);

test("CLI refuses terminal selection without open before starting a runtime", async () => {
  const f = await fixture();
  await expect(
    exec(
      process.execPath,
      [cli, "run", "claude", "--prompt", "viewer", "--terminal", "ghostty"],
      { env: f.env },
    ),
  ).rejects.toThrow(/--terminal requires --open/);
  expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
});

test("CLI rejects mixed MCP selectors and exposes explicit no-MCP", async () => {
  const f = await fixture();
  await expect(
    exec(
      process.execPath,
      [
        cli,
        "run",
        "claude",
        "--prompt",
        "conflict",
        "--mcp",
        "one",
        "--no-mcp",
      ],
      { env: f.env },
    ),
  ).rejects.toThrow(/cannot be combined/);
  const peer = JSON.parse(
    (
      await exec(
        process.execPath,
        [
          cli,
          "run",
          "claude",
          "--kind",
          "task",
          "--prompt",
          "no mcp",
          "--no-mcp",
        ],
        { env: f.env },
      )
    ).stdout,
  );
  expect(peer.mcp).toEqual([]);
  await expect(
    exec(
      process.execPath,
      [
        cli,
        "run",
        "claude",
        "--prompt",
        "unknown",
        "--mcp",
        "one",
        "--mcp",
        "two",
      ],
      { env: f.env },
    ),
  ).rejects.toThrow(/Unknown MCP server/);
});

test("CLI setup-identity creates an identity and identities lists it", async () => {
  const f = await fixture();
  const invoke = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], { env: f.env });
  const created = JSON.parse(
    (await invoke("setup-identity", "--identity", "cli-cx", "--agent", "codex"))
      .stdout,
  );
  expect(created.created).toBe(true);
  expect(created.path).toContain(join(".muster", "identities", "cli-cx"));
  expect(created.login).toContain("CODEX_HOME=" + created.path);
  expect(created.login).toContain("codex login");

  await expect(
    invoke("setup-identity", "--identity", "cli-cx"),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining(
      "setup-identity requires --identity and --agent",
    ),
  });

  const listed = JSON.parse((await invoke("identities")).stdout);
  expect(listed.identities.map((i: { name: string }) => i.name)).toContain(
    "cli-cx",
  );

  const human = (await invoke("identities", "--format", "human")).stdout;
  expect(human).toContain("cli-cx");
});

test("CLI identities reports a profile grant naming an identity that does not exist", async () => {
  const f = await fixture();
  const invoke = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], { env: f.env });
  await invoke("setup-identity", "--identity", "real-one", "--agent", "codex");
  await writeFile(
    join(f.root, ".muster", "config.toml"),
    [
      "[requester_profiles.p]",
      'allowed_roots = ["/tmp"]',
      'identities = ["real-one", "ghost"]',
    ].join("\n") + "\n",
  );

  const listed = JSON.parse((await invoke("identities")).stdout);
  expect(listed.staleGrants).toEqual([{ profile: "p", identity: "ghost" }]);
});

test("CLI setup-identity rejects positionals and an inapplicable --format", async () => {
  const f = await fixture();
  const invoke = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], { env: f.env });
  await expect(
    invoke("setup-identity", "stray", "--identity", "x", "--agent", "codex"),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining(
      "setup-identity takes no positional arguments",
    ),
  });
  await expect(
    invoke(
      "setup-identity",
      "--identity",
      "x",
      "--agent",
      "codex",
      "--format",
      "human",
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("setup-identity always prints JSON"),
  });
});

test("CLI setup-identity refuses --interactive together with --token-env", async () => {
  // The two mutually exclusive credential routes. The interactive branch is
  // taken before --token-env is read, so silently preferring it would run a
  // browser login and write a year-long token to disk on the machine the
  // operator explicitly asked to keep no credential at rest — and never record
  // the variable they named. Named in the error, not ranked.
  const f = await fixture();
  const invoke = (...args: string[]) =>
    exec(process.execPath, [cli, ...args], { env: f.env });
  await expect(
    invoke(
      "setup-identity",
      "--identity",
      "ci",
      "--agent",
      "claude",
      "--token-env",
      "CI_TOKEN",
      "--interactive",
    ),
  ).rejects.toMatchObject({
    stderr: expect.stringContaining("--interactive and --token-env"),
  });
  // Refused before anything was created: no half-made identity left behind.
  expect(JSON.parse((await invoke("identities")).stdout).identities).toEqual(
    [],
  );
});
