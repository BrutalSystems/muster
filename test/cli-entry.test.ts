import { test, expect } from "vitest";
import { existsSync } from "node:fs";
import { spawn } from "node-pty";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { statusText } from "../src/format.js";
import { Registry } from "../src/registry.js";
import { Muster } from "../src/run.js";
import { fixture } from "./helpers.js";
const cli = join(process.cwd(), "dist/muster.js");

/**
 * Bare `muster` starts the MCP server, which from a terminal is indistinguishable
 * from a hang: the process waits for JSON-RPC on stdin and says nothing. At a TTY
 * it now prints the usage text and this status block instead. An MCP client is
 * always a pipe, so the server path is untouched.
 */
test("the status names each identity and the state it is in", () => {
  const text = statusText(
    [
      { name: "codex-personal", agent: "codex", auth: { state: "configured" } },
      {
        name: "claude-personal",
        agent: "claude",
        auth: { state: "not-configured" },
      },
    ],
    0,
  );
  expect(text).toContain("2 identities");
  expect(text).toContain("codex-personal configured");
  expect(text).toContain("claude-personal not-configured");
  expect(text).toContain("muster mcp");
});

test("with no identities the status says how to add one", () => {
  const text = statusText([], 0);
  expect(text).toContain("setup-identity");
  expect(text).toContain("--interactive");
});

/**
 * `list` refreshes every entry and, for a terminal one, removes its identity
 * copy and its MCP config. That is right for `list` and wrong for a status
 * line, so `summary` reads the registry and touches nothing. This is the guard:
 * a later refactor that routes the status through `list` fails here.
 */
test("summary counts only live sessions and removes nothing", async () => {
  const f = await fixture();
  const registry = new Registry(f.home);
  const live = await registry.reserve(
    { runtime: "claude", kind: "session", cwd: f.root },
    10,
  );
  await registry.update(live.entry.launchId, { status: "running" });
  const dead = await registry.reserve(
    { runtime: "claude", kind: "session", cwd: f.root },
    10,
  );
  const copy = join(f.root, "identity-copy");
  await mkdir(copy);
  await registry.update(dead.entry.launchId, {
    status: "exited",
    identityPath: copy,
  });

  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    expect(await m.summary()).toEqual({ sessions: 1 });
    expect(existsSync(copy)).toBe(true);
    expect((await new Registry(f.home).all()).length).toBe(2);
  } finally {
    await m.close();
  }
});

/**
 * The TTY branch, through a real pty rather than a stubbed flag — the point of
 * the change is what a person sees when they type the bare command.
 */
test("bare muster at a terminal prints usage and exits instead of waiting", async () => {
  const f = await fixture();
  const term = spawn(process.execPath, [cli], {
    name: "xterm-256color",
    cols: 100,
    rows: 24,
    cwd: f.root,
    env: f.env,
  });
  let out = "";
  term.onData((d) => (out += d));
  const kill = setTimeout(() => term.kill(), 8000);
  const exit = await new Promise<number>((resolve) =>
    term.onExit(({ exitCode }) => resolve(exitCode)),
  );
  clearTimeout(kill);
  expect(out).toContain("Usage:");
  expect(out).toContain("No identities yet");
  expect(out).toContain("muster mcp");
  expect(exit).toBe(0);
}, 20000);

/**
 * The other half, and the reason the branch is on the TTY rather than on the
 * argument list: `muster` with no arguments is a documented way to start the
 * server, and an MCP client reaches it down a pipe. This pins that.
 */
test("bare muster down a pipe still serves MCP", async () => {
  const f = await fixture();
  const client = new Client({ name: "muster-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli],
      env: f.env,
      stderr: "pipe",
    }),
  );
  try {
    expect((await client.listTools()).tools.map((t) => t.name)).toContain(
      "run",
    );
  } finally {
    await client.close();
  }
}, 20000);

/**
 * `muster setup-identity --help` answered "Unknown option '--help'", because
 * the flag reached a strict parser that had no such option. The help request is
 * now recognised before parsing, so a command can document itself.
 */
test("a command answers --help with its own help", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    cli,
    "setup-identity",
    "--help",
  ]);
  expect(stdout).toContain("muster setup-identity");
  expect(stdout).toContain("--interactive");
  expect(stdout).toContain("Examples:");
  expect(stdout).not.toContain("muster run");
}, 20000);

const waitFor = async (get: () => string, needle: string, ms = 10000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (get().includes(needle)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`never saw ${JSON.stringify(needle)} in: ${get()}`);
};

/**
 * What the flags alone could not express: `--interactive` says the login runs
 * here, and a person typing it naturally supplies nothing else. It used to be
 * answered with "setup-identity requires --identity and --agent".
 */
test("setup-identity --interactive asks for what it was not given", async () => {
  const f = await fixture();
  const term = spawn(
    process.execPath,
    [cli, "setup-identity", "--interactive"],
    { name: "xterm-256color", cols: 100, rows: 24, cwd: f.root, env: f.env },
  );
  let out = "";
  term.onData((d) => (out += d));
  const kill = setTimeout(() => term.kill(), 25000);
  try {
    await waitFor(() => out, "Identity name:");
    term.write("e2e-probe\r");
    await waitFor(() => out, "Agent");
    term.write("codex\r");
    // codex authenticates from a file in the template, so the flow prints the
    // one-time login rather than running a browser anywhere.
    await waitFor(() => out, "CODEX_HOME=");
    expect(out).toContain("e2e-probe");
  } finally {
    clearTimeout(kill);
    term.kill();
  }
}, 40000);

test("--interactive without a terminal says so instead of listing flags", async () => {
  const f = await fixture();
  await expect(
    promisify(execFile)(
      process.execPath,
      [cli, "setup-identity", "--interactive"],
      {
        env: f.env,
      },
    ),
  ).rejects.toThrow(/terminal/i);
}, 20000);

/**
 * #69. The mutual-exclusion refusal described `--interactive` as running a
 * login and storing a token, which is Claude's behaviour. For codex or opencode
 * `--interactive` captures nothing and `--token-env` does not apply at all, so
 * the accurate refusal is the one about the agent, not about the pair.
 */
test("--token-env against a non-Claude agent is refused as a non-Claude flag", async () => {
  const f = await fixture();
  const run = promisify(execFile);
  await expect(
    run(
      process.execPath,
      [
        cli,
        "setup-identity",
        "--identity",
        "cx",
        "--agent",
        "codex",
        "--interactive",
        "--token-env",
        "FOO",
      ],
      { env: f.env },
    ),
  ).rejects.toThrow(/applies only to a claude identity/i);
}, 20000);

test("an empty --token-env is refused rather than silently dropped", async () => {
  const f = await fixture();
  const run = promisify(execFile);
  await expect(
    run(
      process.execPath,
      [
        cli,
        "setup-identity",
        "--identity",
        "e",
        "--agent",
        "claude",
        "--token-env",
        "",
      ],
      { env: f.env },
    ),
  ).rejects.toThrow(/name of an environment variable/i);
}, 20000);
