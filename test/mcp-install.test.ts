import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCH_QUESTION,
  mcpCommand,
  registered,
  selfInvocation,
  type McpCommandDeps,
} from "../src/mcp-install.js";

const cli = join(process.cwd(), "dist/muster.js");
const SELF = { command: "/opt/bin/muster", args: [] as string[] };

/**
 * A temporary profile and a `claude` on PATH that edits only that profile's
 * `.claude.json`. No test here can reach a real Claude configuration.
 */
async function profile(opts: { claude?: boolean } = {}) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "mu-mcp-")));
  const bin = join(root, "bin"),
    config = join(root, "claude-config");
  await mkdir(bin);
  await mkdir(config);
  if (opts.claude !== false) {
    await copyFile(
      new URL("./fakes/claude-mcp.cjs", import.meta.url),
      join(bin, "claude"),
    );
    await chmod(join(bin, "claude"), 0o755);
  }
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    CLAUDE_CONFIG_DIR: config,
  };
  const out: string[] = [];
  const deps = (extra: Partial<McpCommandDeps> = {}): McpCommandDeps => ({
    env,
    write: (s) => out.push(s),
    self: async () => SELF,
    ...extra,
  });
  const calls = async () =>
    (await readFile(join(config, "calls.jsonl"), "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
  return { root, bin, config, env, out, deps, calls };
}

test("install registers a read-only server at user scope when not asked", async () => {
  const p = await profile();
  await mcpCommand(["install"], p.deps());
  expect(await p.calls()).toEqual([
    ["mcp", "add", "--scope", "user", "muster", "--", "/opt/bin/muster", "mcp"],
  ]);
  expect(await registered(p.env)).toEqual({
    command: "/opt/bin/muster",
    args: ["mcp"],
  });
  const said = p.out.join("");
  expect(said).toContain("list, output");
  expect(said).toContain("Restart Claude Code");
});

test("at a terminal install asks, and only yes grants launch", async () => {
  for (const [answer, granted] of [
    ["", false],
    ["n", false],
    ["maybe", false],
    ["y", true],
    ["YES", true],
  ] as const) {
    const p = await profile();
    const asked: string[] = [];
    await mcpCommand(
      ["install"],
      p.deps({
        ask: async (q) => {
          asked.push(q);
          return answer;
        },
      }),
    );
    expect(asked).toEqual([LAUNCH_QUESTION]);
    expect((await registered(p.env))?.args).toEqual(
      granted ? ["mcp", "--allow-launch"] : ["mcp"],
    );
  }
});

test("--allow-launch grants without asking", async () => {
  const p = await profile();
  await mcpCommand(
    ["install", "--allow-launch"],
    p.deps({
      ask: async () => {
        throw new Error("must not ask");
      },
    }),
  );
  expect((await registered(p.env))?.args).toEqual(["mcp", "--allow-launch"]);
  expect(p.out.join("")).toContain("run, stop, title");
});

test("install is idempotent and refuses to replace a different definition without --force", async () => {
  const p = await profile();
  await mcpCommand(["install"], p.deps());
  await mcpCommand(["install"], p.deps());
  expect(p.out.at(-1)).toContain("nothing changed");
  expect(await p.calls()).toHaveLength(1);

  await expect(
    mcpCommand(["install", "--allow-launch"], p.deps()),
  ).rejects.toThrow(/already registered[\s\S]*--force/);
  expect(await p.calls()).toHaveLength(1);
  expect((await registered(p.env))?.args).toEqual(["mcp"]);

  await mcpCommand(["install", "--allow-launch", "--force"], p.deps());
  expect((await p.calls()).slice(1)).toEqual([
    ["mcp", "remove", "--scope", "user", "muster"],
    [
      "mcp",
      "add",
      "--scope",
      "user",
      "muster",
      "--",
      "/opt/bin/muster",
      "mcp",
      "--allow-launch",
    ],
  ]);
  expect(p.out.at(-1)).toContain("Replaced");
});

test("uninstall removes the server, and says so when there is none", async () => {
  const p = await profile();
  await mcpCommand(["uninstall"], p.deps());
  expect(p.out.at(-1)).toContain("nothing to remove");
  expect(await p.calls()).toEqual([]);
  await mcpCommand(["install"], p.deps());
  await mcpCommand(["uninstall"], p.deps());
  expect((await p.calls()).at(-1)).toEqual([
    "mcp",
    "remove",
    "--scope",
    "user",
    "muster",
  ]);
  expect(await registered(p.env)).toBeUndefined();
});

test("status reports registration and whether launch is allowed", async () => {
  const p = await profile();
  await mcpCommand(["status"], p.deps());
  expect(p.out.at(-1)).toContain("Not registered");
  await mcpCommand(["install"], p.deps());
  await mcpCommand(["status"], p.deps());
  expect(p.out.at(-1)).toContain("Launch allowed: no");
  await mcpCommand(["install", "--allow-launch", "--force"], p.deps());
  await mcpCommand(["status"], p.deps());
  expect(p.out.at(-1)).toContain("Launch allowed: yes");
  // Status reads only; it never calls claude.
  expect((await p.calls()).every((c) => c[1] !== "get")).toBe(true);
});

test("status and install read the profile CLAUDE_CONFIG_DIR names", async () => {
  const p = await profile();
  const other = join(p.root, "other-profile");
  await mkdir(other);
  await writeFile(
    join(other, ".claude.json"),
    JSON.stringify({
      mcpServers: { muster: { command: "/opt/bin/muster", args: ["mcp"] } },
    }),
  );
  expect(await registered(p.env)).toBeUndefined();
  expect(await registered({ ...p.env, CLAUDE_CONFIG_DIR: other })).toEqual({
    command: "/opt/bin/muster",
    args: ["mcp"],
  });
});

test("install and uninstall fail clearly when claude is not on PATH", async () => {
  const p = await profile({ claude: false });
  const env = { ...p.env, PATH: p.bin };
  for (const sub of ["install", "uninstall"])
    await expect(mcpCommand([sub], p.deps({ env }))).rejects.toThrow(
      /`claude` is not on PATH/,
    );
});

test("flags that apply only to install are refused elsewhere", async () => {
  const p = await profile();
  await expect(
    mcpCommand(["status", "--allow-launch"], p.deps()),
  ).rejects.toThrow(/apply only to mcp install/);
  await expect(mcpCommand(["install", "extra"], p.deps())).rejects.toThrow(
    /positional/,
  );
});

test("the registered command is the muster on PATH when it is this script", async () => {
  const p = await profile();
  const script = join(p.root, "pkg", "muster.js");
  await mkdir(join(p.root, "pkg"));
  await writeFile(script, "");
  await symlink(script, join(p.bin, "muster"));
  await chmod(script, 0o755);
  expect(await selfInvocation(p.env, script, "/node")).toEqual({
    command: join(p.bin, "muster"),
    args: [],
  });
  // A different muster first on PATH: register exactly what is running.
  const elsewhere = join(p.root, "checkout.js");
  await writeFile(elsewhere, "");
  expect(await selfInvocation(p.env, elsewhere, "/node")).toEqual({
    command: "/node",
    args: [elsewhere],
  });
});

/**
 * Through the real CLI: stdin is not a terminal, so nothing is asked and no
 * launch authority is granted. Bare `muster mcp` with no subcommand is still
 * the server — covered by the MCP tests.
 */
test("muster mcp install from the CLI without a terminal does not grant launch", async () => {
  const p = await profile();
  const run = (...args: string[]) =>
    promisify(execFile)(process.execPath, [cli, "mcp", ...args], {
      env: { ...process.env, ...p.env },
    });
  const { stdout } = await run("install");
  expect(stdout).toContain("Registered");
  const def = await registered(p.env);
  expect(def?.args.slice(-1)).toEqual(["mcp"]);
  expect((await run("status")).stdout).toContain("Launch allowed: no");
  await expect(run("install", "--allow-launch")).rejects.toMatchObject({
    stderr: expect.stringContaining("--force"),
  });
  expect((await run("uninstall")).stdout).toContain("Removed");
  expect((await run("install", "--help")).stdout).toContain(
    "muster mcp install",
  );
}, 20000);
