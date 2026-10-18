#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Muster, UnknownRun, durableId, failedLaunchId } from "./run.js";
import { waitSeconds } from "./duration.js";
import { delay } from "./identity/processes.js";
import { formatHuman, humanColorEnabled, statusText } from "./format.js";
import { checkPlugins, npmRegistry } from "./doctor.js";
import { loadConfig, musterHome } from "./config.js";
import {
  describeIdentities,
  interactiveSetup,
  setupIdentity,
} from "./identity-cli.js";
import { IdentityError } from "./identity-store.js";
import { MCP_TOOLS, mcpToolNames } from "./mcp-tools.js";
import { toolGate } from "./mcp.js";
import {
  ALLOW_LAUNCH,
  MCP_SUBCOMMANDS,
  mcpCommand,
  notEnabled,
  selfInvocation,
} from "./mcp-install.js";
import { normalizeOpenFlag, usesTerminalFlag } from "./guard.js";
import { commandHelp, topLevelHelp } from "./help.js";
import { CLI_OPTIONS, asksForHelp } from "./cli-options.js";
import { promptForMissing, terminalReader } from "./prompt.js";
const listSchema = z
  .object({ kind: z.enum(["session", "task"]).optional() })
  .strict();
const idSchema = z.object({ id: z.string().min(1) }).strict();
const titleSchema = z
  .object({ id: z.string().min(1), title: z.string().min(1) })
  .strict();
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};
const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});
/**
 * Human rendering for `identities`, kept local rather than added to
 * format.ts's RecordView/DoctorView: an identity record shares no field with
 * either of those shapes.
 */
function identitiesHuman(
  view: Awaited<ReturnType<typeof describeIdentities>>,
  color: boolean,
): string {
  const paint = (value: string, code: number) =>
    color ? `[${code}m${value}[0m` : value;
  const lines: string[] = [];
  if (!view.identities.length) lines.push("No identities.");
  for (const identity of view.identities) {
    const code = identity.auth.state === "configured" ? 32 : 31;
    lines.push(
      `${paint(identity.name, 1)} (${identity.agent}) — ${paint(
        identity.auth.state,
        code,
      )}: ${identity.auth.detail}`,
    );
  }
  if (view.staleGrants.length) {
    lines.push("");
    for (const grant of view.staleGrants)
      lines.push(
        paint(
          `stale grant: profile ${grant.profile} names identity ${grant.identity}, which does not exist`,
          33,
        ),
      );
  }
  return lines.join("\n") + "\n";
}
async function main() {
  // A reader that leaves early (`muster list | head -1`) makes the rest of a
  // large write fail with EPIPE. Unhandled, that error exits Node on the spot —
  // inside whatever registry transaction `close()` is running, which strands
  // the lock. Nobody is left to read the output, so dropping it is correct.
  for (const stream of [process.stdout, process.stderr])
    stream.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "EPIPE") throw e;
    });
  const argv = process.argv.slice(2);
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(topLevelHelp());
    return;
  }
  // Recognised before parsing, not during it: the parser is strict and has no
  // `help` option, so `muster setup-identity --help` used to be answered with
  // "Unknown option '--help'". Anywhere among the command's own flags, so
  // `muster run codex --help` is help too; see `asksForHelp` for the `--help`
  // that is some flag's value, which still reaches the command.
  if (commandHelp(argv[0] ?? "") && asksForHelp(argv.slice(1))) {
    process.stdout.write(commandHelp(argv[0]!)!);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${version}\n`);
    return;
  }
  // No arguments starts the MCP server: a documented entry point, and how a
  // client configured with `command: "muster"` and no args reaches it. From a
  // terminal that is indistinguishable from a hang — the process is waiting for
  // JSON-RPC on stdin and has nothing to say. A client always arrives down a
  // pipe and never a TTY, so a person can be answered without changing what any
  // client gets. `muster mcp` stays unconditional, so the server can still be
  // driven by hand in a terminal to debug it.
  const bareAtTerminal = argv.length === 0 && Boolean(process.stdin.isTTY);
  const mcp = !bareAtTerminal && (argv.length === 0 || argv[0] === "mcp");
  // `muster mcp install|uninstall|status` registers the server with Claude
  // Code rather than serving it. Handled before Muster.create(): none of them
  // touches a run.
  if (
    argv[0] === "mcp" &&
    (MCP_SUBCOMMANDS as readonly string[]).includes(argv[1] ?? "")
  ) {
    if (argv.includes("--help") || argv.includes("-h")) {
      process.stdout.write(commandHelp("mcp")!);
      return;
    }
    await mcpCommand(argv.slice(1), {
      env: process.env,
      write: (s) => process.stdout.write(s),
      ...(process.stdin.isTTY ? { ask: terminalReader() } : {}),
      self: () => selfInvocation(process.env),
    });
    return;
  }
  // Read-only unless launching is granted by the flag. Bare `muster` down a
  // pipe is the same server, so it is read-only too.
  const allowLaunch = argv[0] === "mcp" && argv[1] === ALLOW_LAUNCH;
  if (argv[0] === "mcp" && argv.length > (allowLaunch ? 2 : 1))
    throw new Error(
      `mcp takes ${ALLOW_LAUNCH}, or one of ${MCP_SUBCOMMANDS.join(", ")}`,
    );
  const muster = await Muster.create();
  let shutdown: Promise<void> | undefined;
  const close = () =>
    (shutdown ??= (async () => {
      await muster.close();
    })());
  if (bareAtTerminal) {
    try {
      const cfg = await loadConfig();
      const view = await describeIdentities(
        musterHome(),
        process.env,
        Object.fromEntries(
          Object.entries(cfg.requester_profiles).map(([n, p]) => [
            n,
            p.identities,
          ]),
        ),
      );
      process.stdout.write(
        topLevelHelp() +
          "\n" +
          statusText(view.identities, (await muster.summary()).sessions),
      );
    } finally {
      await close();
    }
    return;
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
    process.once(signal, () => {
      void close().then(
        () => process.exit(0),
        (e) => {
          process.stderr.write(String(e) + "\n");
          process.exit(1);
        },
      );
    });
  if (mcp) {
    const server = new Server(
      { name: "muster", version },
      { capabilities: { tools: {} } },
    );
    const gate = toolGate(mcpToolNames(allowLaunch));
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: gate.expose(MCP_TOOLS),
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      if (!gate.allows(params.name))
        return {
          content: [{ type: "text" as const, text: notEnabled(params.name) }],
          isError: true,
        };
      try {
        const args = params.arguments ?? {};
        switch (params.name) {
          case "run":
            return text(
              await muster.run(args, {
                kind: "local",
                // The client's self-reported name was never authentication; it
                // is a label on a local requester, which is what it always was
                // in substance.
                label: `mcp:${server.getClientVersion()?.name ?? "unknown"}`,
              }),
            );
          case "list":
            return text(await muster.list(listSchema.parse(args).kind));
          case "stop":
            return text(await muster.stop(idSchema.parse(args).id));
          case "output":
            return text(await muster.output(idSchema.parse(args).id));
          case "title": {
            const { id, title } = titleSchema.parse(args);
            return text(await muster.title(id, title));
          }
          default:
            throw new Error(`Unknown tool ${params.name}`);
        }
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: (e as Error).message }],
          isError: true,
        };
      }
    });
    server.onclose = () => {
      void close().catch((e) => {
        process.stderr.write(String(e) + "\n");
        process.exitCode = 1;
      });
    };
    server.onerror = (e) => process.stderr.write(`[muster] ${e.message}\n`);
    await server.connect(new StdioServerTransport());
    return;
  }
  try {
    const command = argv.shift();
    // Read before normalisation, which turns `--open <app>` into `--terminal
    // <app>` and would otherwise make the notice fire on the replacement.
    const typedTerminalFlag = usesTerminalFlag(argv);
    const { values: parsed, positionals } = parseArgs({
      // `--open` carries an optional terminal name, which parseArgs has no kind
      // for; the value is lifted onto `--terminal` first. See normalizeOpenFlag.
      args: normalizeOpenFlag(argv),
      allowPositionals: true,
      strict: true,
      options: CLI_OPTIONS,
    });
    const {
      format = "json",
      "no-mcp": noMcp,
      "no-plugin": noPlugin,
      "request-key": requestKey,
      "idle-timeout": idleTimeout,
      socket,
      home: homeFlag,
      "stop-now": stopNow,
      "read-only": readOnly,
      "write-here": writeHere,
      unrestricted,
      "on-exit": onExit,
      "fork-session": forkSession,
      timeout,
      ...values
    } = parsed;
    if (onExit !== undefined && command !== "run")
      throw new Error("--on-exit applies only to run");
    if (timeout !== undefined && command !== "wait")
      throw new Error("--timeout applies only to wait");
    // The plain spellings of the three sealed levels. Each is a level, so the
    // existing exclusivity with --permissions/--sandbox applies unchanged once
    // it is folded into `values.level`.
    const levelFlags = (
      [
        ["--read-only", readOnly, "read"],
        ["--write-here", writeHere, "work"],
        ["--unrestricted", unrestricted, "open"],
      ] as const
    ).filter(([, set]) => set);
    if (levelFlags.length && command !== "run")
      throw new Error(`${levelFlags[0]![0]} applies only to run`);
    if (levelFlags.length > 1)
      throw new Error(
        `use one of ${levelFlags.map(([name]) => name).join(", ")}, not several`,
      );
    if (levelFlags.length && values.level !== undefined)
      throw new Error(`use ${levelFlags[0]![0]} or --level, not both`);
    if (levelFlags.length) values.level = levelFlags[0]![2];
    // Guarded like --request-key and --no-mcp below: a flag that applies to one
    // command and is silently ignored elsewhere misleads, and --home silently
    // reading the real registry is the one that would mislead most.
    for (const [name, value] of [
      ["--idle-timeout", idleTimeout],
      ["--ttl", values.ttl],
      ["--title", values.title],
      ["--resume", values.resume],
      ["--fork-session", forkSession],
    ] as const)
      if (value !== undefined && command !== "run")
        throw new Error(`${name} applies only to run`);
    for (const [name, value] of [
      ["--socket", socket],
      ["--home", homeFlag],
      ["--stop-now", stopNow],
    ] as const)
      if (
        value !== undefined &&
        command !== "reap-check" &&
        !(name === "--home" && command === "on-exit-watch")
      )
        throw new Error(`${name} applies only to reap-check`);
    if (requestKey !== undefined && command !== "run")
      throw new Error("--request-key applies only to run");
    if (noMcp !== undefined && command !== "run")
      throw new Error("--no-mcp applies only to run");
    if (noMcp && values.mcp)
      throw new Error("--mcp and --no-mcp cannot be combined");
    if (noMcp) values.mcp = [];
    if (noPlugin !== undefined && command !== "run")
      throw new Error("--no-plugin applies only to run");
    if (noPlugin && values.plugin)
      throw new Error("--plugin and --no-plugin cannot be combined");
    if (noPlugin) values.plugin = [];
    if (format !== "json" && format !== "human")
      throw new Error("format must be json or human");
    if (command === "output" && parsed.format !== undefined)
      throw new Error(
        "output prints raw task text; --format applies to run, list and stop",
      );
    if (command === "setup-identity" && parsed.format !== undefined)
      throw new Error(
        "setup-identity always prints JSON; --format applies to run, list, stop, doctor and identities",
      );
    const print = (value: Parameters<typeof formatHuman>[0]) =>
      process.stdout.write(
        format === "human"
          ? formatHuman(
              value,
              humanColorEnabled(process.stdout.isTTY, process.env),
            )
          : JSON.stringify(value) + "\n",
      );
    if (command === "run") {
      if (typedTerminalFlag)
        process.stderr.write(
          "[muster] --terminal is deprecated and will be removed in v2; pass the app to --open instead, or set terminal in config.toml\n",
        );
      const runtime = positionals[0];
      const args = positionals.slice(1);
      let record;
      try {
        record = await muster.run({
          runtime,
          ...values,
          ...(requestKey === undefined ? {} : { requestKey }),
          ...(idleTimeout === undefined ? {} : { idleTimeout }),
          ...(forkSession === undefined ? {} : { forkSession }),
          args,
        });
      } catch (e) {
        // A launch that failed still ended, and the caller is waiting on its
        // command to say so: armed on the failed entry, the watcher finds it
        // already over and runs it with MUSTER_STATE=failed and MUSTER_ERROR.
        // The launch's own error is still what this command fails with.
        const launchId = failedLaunchId(e);
        if (onExit !== undefined && launchId)
          await muster
            .armOnExit(launchId, onExit, process.cwd())
            .catch((armError) =>
              process.stderr.write(
                `[muster] --on-exit not run for the failed launch: ${(armError as Error).message}\n`,
              ),
            );
        throw e;
      }
      // Armed after the launch and before the record is printed, so a caller
      // that reads the record knows the watcher exists. A launch that is up
      // but could not be armed still prints its record — the session is real
      // and needs stopping — and then fails, because the caller asked for a
      // signal it will not get.
      if (onExit !== undefined)
        try {
          await muster.armOnExit(durableId(record), onExit, process.cwd());
        } catch (e) {
          print(record);
          throw e;
        }
      print(record);
      if (record.kind === "session" && record.host === "pty") {
        process.stderr.write(
          "[muster] pty: not watchable or attachable; this process owns the session. Ctrl-C stops it.\n",
        );
        while (await muster.hasOwnedPty()) await delay(250);
      }
    } else if (command === "list") {
      if (positionals.length)
        throw new Error("list takes no positional arguments");
      print(await muster.list(listSchema.parse(values).kind));
    } else if (command === "setup-identity") {
      if (positionals.length)
        throw new Error("setup-identity takes no positional arguments");
      const { "token-env": tokenEnv } = values as Record<
        string,
        string | undefined
      >;
      let { identity, agent } = values as Record<string, string | undefined>;
      if (!identity || !agent) {
        // Asking is what `--interactive` already implied. Without it the
        // command is the unattended route and still requires both flags, and
        // with it but no terminal there is nobody to ask — which is a different
        // problem from having forgotten a flag, so it says so.
        if (!values.interactive)
          throw new Error("setup-identity requires --identity and --agent");
        if (!process.stdin.isTTY)
          throw new Error(
            "--interactive needs a terminal to ask for --identity and --agent; pass both as flags for an unattended run",
          );
        ({ identity, agent } = await promptForMissing({
          identity,
          agent,
          ask: terminalReader(),
        }));
      }
      if (values.interactive) {
        // Refused, not ranked. These are the two mutually exclusive credential
        // routes, and the interactive branch is taken before tokenEnv is read:
        // silently preferring it would run a browser login and write a
        // year-long token to disk on the machine the operator explicitly asked
        // to keep no credential at rest, while never recording the variable
        // they named.
        if (tokenEnv !== undefined && agent !== "claude")
          // Not the mutual-exclusion message: for codex and opencode
          // `--interactive` captures nothing and `--token-env` does not apply
          // at all, so describing them as two routes to choose between would
          // be describing Claude's behaviour at a different agent (#69).
          throw new IdentityError(
            identity,
            `--token-env applies only to a claude identity; ${agent} authenticates from an auth file in the template, and a token variable here would only add a way for the launch to fail`,
          );
        if (tokenEnv !== undefined)
          throw new IdentityError(
            identity,
            "--interactive and --token-env are the two mutually exclusive credential routes: --interactive runs the login and stores a token in the identity, --token-env records the name of a variable to read one from instead. Pass one, not both.",
          );
        const result = await interactiveSetup({
          home: musterHome(),
          name: identity,
          agent: agent as "codex" | "claude" | "opencode",
          isTTY: Boolean(process.stdin.isTTY),
          // The one place the operator's real keyboard is named.
          stdin: process.stdin,
        });
        process.stdout.write(`\n${result.note}\n`);
        return;
      }
      // Not routed through print(): its RecordView/DoctorView shapes are for
      // run/list/stop/doctor, and an identity record shares no field with
      // either, so this always prints JSON.
      process.stdout.write(
        JSON.stringify(
          await setupIdentity({
            home: musterHome(),
            name: identity,
            agent: agent as "codex" | "claude" | "opencode",
            ...(tokenEnv !== undefined ? { tokenEnv } : {}),
          }),
        ) + "\n",
      );
    } else if (command === "identities") {
      if (positionals.length)
        throw new Error("identities takes no positional arguments");
      const cfg = await loadConfig();
      const view = await describeIdentities(
        musterHome(),
        process.env,
        Object.fromEntries(
          Object.entries(cfg.requester_profiles).map(([n, p]) => [
            n,
            p.identities,
          ]),
        ),
      );
      process.stdout.write(
        format === "human"
          ? identitiesHuman(
              view,
              humanColorEnabled(process.stdout.isTTY, process.env),
            )
          : JSON.stringify(view) + "\n",
      );
    } else if (command === "doctor") {
      if (positionals.length || Object.keys(values).length)
        throw new Error("doctor takes no arguments");
      const report = await checkPlugins(await loadConfig(), npmRegistry());
      print(report);
      if (report.stale) process.exitCode = 1;
    } else if (command === "stop" || command === "output") {
      if (positionals.length !== 1 || Object.keys(values).length)
        throw new Error(`${command} requires exactly one id`);
      const { id } = idSchema.parse({ id: positionals[0] });
      if (command === "stop") print(await muster.stop(id));
      else process.stdout.write(await muster.output(id));
    } else if (command === "title") {
      // Positional rather than --title: the flag names a launch's title, and
      // reusing it here would make `muster title --title x <id>` a spelling.
      if (positionals.length !== 2 || Object.keys(values).length)
        throw new Error("title requires an id and the title text");
      const { id } = idSchema.parse({ id: positionals[0] });
      print(await muster.title(id, positionals[1]!));
    } else if (command === "wait") {
      if (positionals.length !== 1 || Object.keys(values).length)
        throw new Error("wait requires exactly one id");
      const { id } = idSchema.parse({ id: positionals[0] });
      try {
        const { done, record } = await muster.wait(id, {
          ...(timeout === undefined
            ? {}
            : { timeoutMs: waitSeconds(timeout) * 1000 }),
        });
        print(record as Parameters<typeof print>[0]);
        // 124 is timeout(1)'s status, which a shell caller already tests for.
        if (!done) process.exitCode = 124;
      } catch (e) {
        if (!(e instanceof UnknownRun)) throw e;
        process.stderr.write(`[muster] ${e.message}\n`);
        process.exitCode = 2;
      }
    } else if (command === "on-exit-watch") {
      // Hidden, like reap-check: started detached by `run --on-exit`, never
      // typed. Its own exit status is unread; the command's goes to the log.
      if (positionals.length !== 1 || !homeFlag)
        throw new Error("on-exit-watch requires --home and one launch id");
      const watcher = await Muster.create({ home: homeFlag });
      try {
        await watcher.runOnExit(positionals[0]!);
      } finally {
        await watcher.close();
      }
    } else if (command === "reap-check") {
      // Hidden: armed by muster itself as a tmux job, never typed by a person.
      // NOTE: `Muster.create()` above already ran against the REAL home before
      // this dispatch. Harmless (nothing is owned, so `close()` stops nothing)
      // but it means a broken ~/.muster/config.toml would fail every poll.
      // Left as-is: moving that create changes every command's startup.
      if (positionals.length !== 1 || !socket)
        throw new Error("reap-check requires --socket and one launch id");
      const { reapCheck } = await import("./reap.js");
      await reapCheck({
        home: homeFlag ?? musterHome(),
        socket,
        ...(stopNow ? { stopNow: true } : {}),
        launchId: positionals[0]!,
        // The exact command that was armed, so a re-arm reproduces itself.
        argv: [...process.argv],
      });
    } else throw new Error(topLevelHelp());
  } finally {
    await close();
  }
}
main().catch((e) => {
  const command = process.argv[2] ?? "";
  // parseArgs's own text explains how to pass a positional that starts with a
  // dash, which is never what a mistyped flag meant; the flag list is.
  const hint =
    (e as NodeJS.ErrnoException).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" &&
    commandHelp(command)
      ? `\n[muster] see \`muster ${command} --help\` for its options`
      : "";
  process.stderr.write(`[muster] ${(e as Error).message}${hint}\n`);
  process.exitCode = 1;
});
