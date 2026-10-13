/**
 * `muster mcp install | uninstall | status` — registering Muster's own MCP
 * server with Claude Code at user scope, for the profile `CLAUDE_CONFIG_DIR`
 * names (or the default one).
 *
 * Every write goes through `claude mcp add` / `claude mcp remove`, so Muster
 * never edits Claude's configuration itself. Reading is different: the current
 * definition is read straight from the profile's `.claude.json`, because
 * `claude mcp get` health-checks a server by starting it and reports whichever
 * scope wins, where this needs the user-scope entry exactly as written.
 */
import { execFile } from "node:child_process";
import { access, constants, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { parseArgs } from "node:util";
import { LAUNCH_TOOLS, mcpToolNames } from "./mcp-tools.js";

export const SERVER_NAME = "muster";
export const ALLOW_LAUNCH = "--allow-launch";
export const LAUNCH_QUESTION =
  "Let this Claude launch and stop sessions? [y/N] ";
export const MCP_SUBCOMMANDS = ["install", "uninstall", "status"] as const;

/** A stdio server definition, as Claude stores and Muster compares it. */
export type Definition = { command: string; args: string[] };
export type ClaudeResult = { code: number; stdout: string; stderr: string };
export type McpCommandDeps = {
  env: NodeJS.ProcessEnv;
  write: (text: string) => void;
  /** Present only when a person is at a terminal to answer. */
  ask?: (question: string) => Promise<string>;
  /** How this muster is invoked, without the `mcp` argument. */
  self: () => Promise<Definition>;
  /** Runs Claude Code's CLI. Injected so tests never touch a real profile. */
  runClaude?: (
    binary: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => Promise<ClaudeResult>;
};

/** The first executable called `name` on PATH, as PATH spells it. */
export async function onPath(
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

/**
 * The command a client should run to reach this muster. The installed `muster`
 * bin when the one on PATH is this very script — its PATH spelling, not its
 * resolved target, so a package-manager link survives an upgrade. Otherwise
 * (a source checkout, or a different install first on PATH) this node and this
 * script, absolutely, so the registration runs what the person just ran.
 */
export async function selfInvocation(
  env: NodeJS.ProcessEnv,
  script = process.argv[1]!,
  node = process.execPath,
): Promise<Definition> {
  const resolved = await realpath(script);
  const found = await onPath("muster", env);
  if (found && (await realpath(found).catch(() => undefined)) === resolved)
    return { command: found, args: [] };
  return { command: node, args: [resolved] };
}

export function claudeConfigFile(env: NodeJS.ProcessEnv): string {
  return join(env.CLAUDE_CONFIG_DIR || env.HOME || homedir(), ".claude.json");
}

/** The user-scope `muster` entry, or undefined when there is none. */
export async function registered(
  env: NodeJS.ProcessEnv,
): Promise<Definition | undefined> {
  const file = claudeConfigFile(env);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Cannot read ${file}: it is not valid JSON`);
  }
  const entry = parsed?.mcpServers?.[SERVER_NAME];
  if (!entry || typeof entry !== "object") return undefined;
  return {
    command: typeof entry.command === "string" ? entry.command : "",
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
  };
}

export function desired(self: Definition, allowLaunch: boolean): Definition {
  return {
    command: self.command,
    args: [...self.args, "mcp", ...(allowLaunch ? [ALLOW_LAUNCH] : [])],
  };
}
const same = (a: Definition, b: Definition) =>
  a.command === b.command &&
  a.args.length === b.args.length &&
  a.args.every((arg, i) => arg === b.args[i]);
const quote = (s: string) =>
  /^[\w@%+=:,./-]+$/.test(s) ? s : JSON.stringify(s);
export const render = (d: Definition) =>
  [d.command, ...d.args].map(quote).join(" ");
const launchAllowed = (d: Definition) => d.args.includes(ALLOW_LAUNCH);
function toolsLine(allowLaunch: boolean) {
  return allowLaunch
    ? `Tools: ${mcpToolNames(true).join(", ")} — this Claude can launch and stop sessions.`
    : `Tools: ${mcpToolNames(false).join(", ")} — read-only; it cannot launch or stop anything.`;
}

async function defaultRunClaude(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    execFile(binary, args, { env, timeout: 60_000 }, (error, stdout, stderr) =>
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      }),
    );
  });
}

async function claude(deps: McpCommandDeps) {
  const binary = await onPath("claude", deps.env);
  if (!binary)
    throw new Error(
      "`claude` is not on PATH. Install Claude Code, or put it on PATH, and run this again.",
    );
  const run = deps.runClaude ?? defaultRunClaude;
  return async (args: string[], what: string) => {
    const result = await run(binary, args, deps.env);
    if (result.code !== 0)
      throw new Error(
        `\`claude ${args.join(" ")}\` failed while ${what}: ${
          (result.stderr || result.stdout).trim() || `exit ${result.code}`
        }`,
      );
    return result;
  };
}

async function install(
  opts: { allowLaunch: boolean; force: boolean },
  deps: McpCommandDeps,
) {
  const run = await claude(deps);
  let allowLaunch = opts.allowLaunch;
  // Default no, and no question at all without a terminal: the grant is made
  // by a person typing the flag or answering yes, never by a script's silence.
  if (!allowLaunch && deps.ask)
    allowLaunch = /^y(es)?$/i.test((await deps.ask(LAUNCH_QUESTION)).trim());
  const want = desired(await deps.self(), allowLaunch);
  const file = claudeConfigFile(deps.env);
  const have = await registered(deps.env);
  if (have && same(have, want)) {
    deps.write(
      `Already registered at user scope in ${file}; nothing changed.\n  ${render(want)}\n${toolsLine(allowLaunch)}\n`,
    );
    return;
  }
  if (have && !opts.force)
    throw new Error(
      `A different "${SERVER_NAME}" MCP server is already registered at user scope in ${file}:\n` +
        `  have: ${render(have)}\n  want: ${render(want)}\n` +
        `Run again with --force to replace it, or \`muster mcp uninstall\` first.`,
    );
  if (have)
    await run(
      ["mcp", "remove", "--scope", "user", SERVER_NAME],
      "removing the existing definition",
    );
  await run(
    [
      "mcp",
      "add",
      "--scope",
      "user",
      SERVER_NAME,
      "--",
      want.command,
      ...want.args,
    ],
    "registering the server",
  );
  deps.write(
    `${have ? "Replaced" : "Registered"} the "${SERVER_NAME}" MCP server at user scope in ${file}.\n` +
      `  ${render(want)}\n${toolsLine(allowLaunch)}\n` +
      "Restart Claude Code (or start a new session) to load it.\n",
  );
}

async function uninstall(deps: McpCommandDeps) {
  const run = await claude(deps);
  const file = claudeConfigFile(deps.env);
  if (!(await registered(deps.env))) {
    deps.write(
      `No "${SERVER_NAME}" MCP server at user scope in ${file}; nothing to remove.\n`,
    );
    return;
  }
  await run(
    ["mcp", "remove", "--scope", "user", SERVER_NAME],
    "removing the server",
  );
  deps.write(
    `Removed the "${SERVER_NAME}" MCP server from user scope in ${file}.\n` +
      "Restart Claude Code (or start a new session) to drop it.\n",
  );
}

async function status(deps: McpCommandDeps) {
  const file = claudeConfigFile(deps.env);
  const have = await registered(deps.env);
  if (!have) {
    deps.write(
      `Not registered: no "${SERVER_NAME}" MCP server at user scope in ${file}.\n` +
        "Run `muster mcp install` to add it.\n",
    );
    return;
  }
  const allowed = launchAllowed(have);
  deps.write(
    `Registered at user scope in ${file}.\n  ${render(have)}\n` +
      `Launch allowed: ${allowed ? "yes" : "no"}\n${toolsLine(allowed)}\n`,
  );
}

/** `muster mcp <subcommand> ...`, already known to name a subcommand. */
export async function mcpCommand(argv: string[], deps: McpCommandDeps) {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options: {
      "allow-launch": { type: "boolean" },
      force: { type: "boolean" },
    },
  });
  if (positionals.length)
    throw new Error(`mcp ${sub} takes no positional arguments`);
  if (sub !== "install" && (values["allow-launch"] || values.force))
    throw new Error(`--allow-launch and --force apply only to mcp install`);
  if (sub === "install")
    return install(
      {
        allowLaunch: Boolean(values["allow-launch"]),
        force: Boolean(values.force),
      },
      deps,
    );
  if (sub === "uninstall") return uninstall(deps);
  if (sub === "status") return status(deps);
  throw new Error(`Unknown mcp subcommand: ${sub}`);
}

/** The refusal for a tool the running server does not expose. */
export function notEnabled(name: string): string {
  return (LAUNCH_TOOLS as readonly string[]).includes(name)
    ? `Tool ${name} is not enabled: this Muster MCP server is read-only. Start it with \`muster mcp --allow-launch\` (or register it with \`muster mcp install --allow-launch\`) to expose ${LAUNCH_TOOLS.join(", ")}.`
    : `Unknown tool ${name}`;
}
