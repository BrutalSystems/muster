/**
 * `--help`, in two levels: a synopsis and a command table at the top, and each
 * command's own flags under `muster <command> --help`.
 *
 * It lives here rather than in muster.ts because that module runs `main()` at
 * import, so nothing can import it to check what it prints. The shape is data
 * rather than a template string for the same reason: a test can ask whether
 * every command the CLI dispatches has an entry, which a paragraph cannot
 * answer, and a command shipped without documentation fails nothing else.
 */
export type Command = {
  name: string;
  summary: string;
  /** Rendered after "Usage: ", so it must fit 80 columns with that prefix. */
  synopsis: string;
  options: [string, string][];
  examples: string[];
  /** The few rules a flag list cannot carry. Kept short; detail is the README. */
  notes?: string[];
};
const WIDTH = 80;
const INDENT = "  ";
const GUTTER = 2;
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}
/** Two columns, with a label too wide for its column taking a line of its own
 *  rather than pushing every description of that row out past the margin. */
function table(rows: [string, string][]): string[] {
  const width = Math.min(
    26,
    Math.max(...rows.map(([label]) => label.length), 0),
  );
  const lead = INDENT.length + width + GUTTER;
  return rows.flatMap(([label, description]) => {
    const body = wrap(description, WIDTH - lead);
    if (label.length > width)
      return [INDENT + label, ...body.map((l) => " ".repeat(lead) + l)];
    return body.map((line, i) =>
      i === 0
        ? INDENT + label.padEnd(width) + " ".repeat(GUTTER) + line
        : " ".repeat(lead) + line,
    );
  });
}
export const COMMANDS: Command[] = [
  {
    name: "run",
    summary: "launch an agent session or task",
    synopsis: "muster run <codex|claude|opencode> --prompt TEXT [options]",
    options: [
      ["--prompt TEXT", "the instruction to launch with"],
      ["--cwd DIR", "the directory to launch in"],
      ["--project NAME", "a directory named under [projects]; not with --cwd"],
      ["--kind KIND", "session (default) or task"],
      ["--host ID", "tmux, pty, or auto (default: tmux, then pty)"],
      ["--identity NAME", "run as a configured identity"],
      [
        "--open [APP]",
        'display the tmux session in a terminal; APP is terminal, iterm2, ghostty (macOS) or a name from [open.apps] in config.toml, defaulting to the configured terminal. An app is an argv template, e.g. [open.apps.kitty] command = ["kitty", "-e", "{tmux}", "-L", "{server}", "attach-session", "-t", "{target}"]',
      ],
      [
        "--terminal APP",
        "deprecated, removed in v2: pass the app to --open instead",
      ],
      [
        "--read-only",
        "sealed: muster's own settings replace the profile's, and the agent can change nothing",
      ],
      [
        "--write-here",
        "sealed: muster's own settings replace the profile's, and the agent can write only inside the launch folder, never muster's own home",
      ],
      [
        "--unrestricted",
        "no sandbox and no permission checks; needs allow_dangerous_flags in config.toml",
      ],
      [
        "--level LEVEL",
        "older spelling: read, work or open are the three flags above; normal is the claude default",
      ],
      ["--permissions MODE", "auto, deny, or bypass (sealed)"],
      ["--sandbox MODE", "read-only, workspace-write, or full-access (sealed)"],
      ["--mcp NAME", "repeatable; replaces configured defaults"],
      [
        "--options NAME",
        "repeatable; muster-side launch options — auto-approve-path records the launch directory as trusted so its one-time dialog does not block the launch (claude and codex only, and refused if the directory ships hooks or MCP servers); accept-bypass-warning accepts Claude's one-time Bypass Permissions warning so an --unrestricted launch can start (claude with bypass permissions only)",
      ],
      ["--no-mcp", "launch with no MCP servers"],
      ["--plugin NAME", "repeatable; replaces configured defaults (OpenCode)"],
      ["--no-plugin", "launch with no plugins"],
      [
        "--model MODEL",
        "model for the launch: a bare id for claude and codex, PROVIDER/MODEL for opencode",
      ],
      [
        "--resume SESSION_ID",
        "claude only: reopen that session instead of starting a new one; the prompt is its next message (also accepted after --)",
      ],
      [
        "--fork-session",
        "with --resume: continue it under a new session id, leaving the original untouched",
      ],
      [
        "--idle-timeout DURATION",
        "stop a tmux session after this much inactivity (off by default)",
      ],
      [
        "--ttl DURATION",
        "stop a tmux session this long after launch, whatever its state",
      ],
      [
        "--title TEXT",
        "the terminal title of a tmux session; defaults to its name and runtime",
      ],
      [
        "--request-key KEY",
        "name the request; sending it again returns the same launch",
      ],
      [
        "--on-exit COMMAND",
        "run COMMAND with /bin/sh once the agent exits, however it ends; muster runs it, outside any sandbox, with MUSTER_ID, MUSTER_RUNTIME, MUSTER_KIND, MUSTER_STATE, MUSTER_EXIT_CODE, MUSTER_SIGNAL, MUSTER_OUTPUT, MUSTER_ERROR and MUSTER_RECORD set",
      ],
      ["--format FORMAT", "json (default) or human"],
      ["-- RUNTIME_OPTIONS", "everything after -- is passed to the runtime"],
      [
        "-- --plugin-dir DIR",
        "claude only: load that plugin folder for this session; a sealed launch refuses it",
      ],
    ],
    notes: [
      "With none of --read-only, --write-here or --unrestricted, claude opens exactly as you would open it by hand in that folder: your profile's rules, CLAUDE.md, permissions, hooks, plugins, MCP servers and env. Muster refuses only a profile whose default mode is bypass. codex and opencode stay read-only by default.",
      "A sealed launch does not read your profile's or the project's settings, so it also loads no rules or CLAUDE.md.",
      "Use one of the three flags, --level, or --permissions/--sandbox; naming two is an error rather than a precedence rule.",
      "A pty launch keeps this process running and Ctrl-C stops it; a tmux launch survives this process exiting.",
      "--on-exit: MUSTER_EXIT_CODE and MUSTER_SIGNAL are empty for a session, whose terminal keeps no exit status, and MUSTER_OUTPUT (the captured output's path) is empty for one too. The command's own output goes to ~/.muster/on-exit/<launch id>.log. A launch that fails at readiness runs it too, with MUSTER_STATE=failed and MUSTER_ERROR. wait and list show it as on_exit: {claimed_at, result}. It is not run if the machine restarts first.",
    ],
    examples: [
      "muster run claude --prompt 'Review this project' --cwd .",
      "muster run claude --read-only --prompt 'Audit this' --cwd .",
      "muster run codex --identity work --write-here --prompt 'Ship it'",
      "muster run codex --kind task --prompt 'Review' --on-exit 'notify.sh'",
    ],
  },
  {
    name: "wait",
    summary: "block until a session or task has ended",
    synopsis: "muster wait <id> [--timeout SECONDS] [--format json|human]",
    options: [
      [
        "--timeout SECONDS",
        "give up after this long: seconds, or 90s, 30m, 4h",
      ],
      ["--format FORMAT", "json (default) or human"],
    ],
    notes: [
      "Prints the final record, with state, exit_code and signal (null for a session, whose terminal keeps no exit status). Exits 0 when it has ended, 2 for an id that names nothing, 124 on timeout, printing the record as it stands, and 75 when the registry is locked (as every command does): retry.",
    ],
    examples: [
      "muster wait 6fae755b-8f5d-4425-8ed7-69e84bfac8c5",
      "muster wait simple-cms-46 --timeout 30m",
    ],
  },
  {
    name: "list",
    summary: "show sessions and tasks",
    synopsis: "muster list [--kind session|task] [--format json|human]",
    options: [
      ["--kind KIND", "show only session or only task entries"],
      ["--format FORMAT", "json (default) or human"],
    ],
    notes: [
      "Refreshes live metadata, and removes the per-launch identity copy of any entry that has ended.",
    ],
    examples: ["muster list --format human"],
  },
  {
    name: "stop",
    summary: "stop a session or task",
    synopsis: "muster stop <id> [--format json|human]",
    options: [["--format FORMAT", "json (default) or human"]],
    examples: ["muster stop 6fae755b-8f5d-4425-8ed7-69e84bfac8c5"],
  },
  {
    name: "output",
    summary: "print a task's captured output",
    synopsis: "muster output <id>",
    options: [],
    notes: ["Prints raw text; --format does not apply."],
    examples: ["muster output 6fae755b-8f5d-4425-8ed7-69e84bfac8c5"],
  },
  {
    name: "title",
    summary: "retitle a running tmux session",
    synopsis: "muster title <id> TEXT [--format json|human]",
    options: [["--format FORMAT", "json (default) or human"]],
    notes: [
      "Sets the title any attached terminal shows, without involving the agent. Refused for tasks, pty sessions and ended sessions.",
    ],
    examples: ["muster title simple-cms-46 'reviewing #48'"],
  },
  {
    name: "identities",
    summary: "show configured identities",
    synopsis: "muster identities [--format json|human]",
    options: [["--format FORMAT", "json (default) or human"]],
    examples: ["muster identities --format human"],
  },
  {
    name: "setup-identity",
    summary: "create or configure an identity",
    synopsis: "muster setup-identity --identity NAME --agent AGENT [options]",
    options: [
      ["--identity NAME", "the identity to create or configure"],
      ["--agent AGENT", "codex, claude, or opencode"],
      ["--interactive", "run the login here and store what it returns"],
      [
        "--token-env VAR",
        "read the token from that variable instead (Claude only)",
      ],
    ],
    notes: [
      "--interactive and --token-env are the two credential routes and cannot be combined; an identity holds one at a time.",
      "Without --interactive the command prints the login for you to run yourself.",
    ],
    examples: [
      "muster setup-identity --identity work --agent claude --interactive",
      "muster setup-identity --identity ci --agent claude --token-env CLAUDE_TOKEN",
    ],
  },
  {
    name: "doctor",
    summary: "check path-configured plugins for staleness",
    synopsis: "muster doctor [--format json|human]",
    options: [["--format FORMAT", "json (default) or human"]],
    notes: [
      "Compares each copy's mtime against the package it came from, and exits 1 when any is stale. Plugins named by npm are not checked.",
    ],
    examples: ["muster doctor --format human"],
  },
  {
    name: "mcp",
    summary: "serve MCP on stdio, or register it with Claude Code",
    synopsis: "muster mcp [--allow-launch] | mcp install|uninstall|status",
    options: [
      ["--allow-launch", "also expose run, stop and title (launch authority)"],
      ["--force", "install: replace a different existing registration"],
    ],
    notes: [
      "Read-only by default: exposes list and output only. --allow-launch is the deliberate grant. No arguments starts the read-only server when stdin is not a terminal, which is what an MCP client provides.",
      "install registers the server with Claude Code at user scope for the current profile (CLAUDE_CONFIG_DIR) via `claude mcp add`. Without --allow-launch it asks at a terminal, defaulting to no; without a terminal it does not grant. Restart Claude Code afterwards.",
    ],
    examples: [
      "muster mcp",
      "muster mcp install",
      "muster mcp install --allow-launch --force",
      "muster mcp status",
    ],
  },
];
export function topLevelHelp(): string {
  const lines = [
    "Usage: muster <command> [options]",
    "",
    "Commands:",
    ...table(COMMANDS.map((c) => [c.name, c.summary] as [string, string])),
    "",
    "Options:",
    ...table([
      ["--format FORMAT", "json (default) or human, where a command takes it"],
      ["--version", "print the version"],
      ["--help", "print this, or a command's own help"],
    ]),
    "",
    "See `muster <command> --help` for a command's options.",
    "",
    // Kept here rather than moved to the README: this is a safety statement
    // about who gets launch authority, not reference detail, and it is only
    // load-bearing where someone is about to install.
    ...wrap(
      "MCP: `muster mcp install` registers a read-only server with Claude Code. Launch authority is granted only by --allow-launch.",
      WIDTH,
    ),
  ];
  return lines.join("\n") + "\n";
}
export function commandHelp(name: string): string | undefined {
  const command = COMMANDS.find((c) => c.name === name);
  if (!command) return undefined;
  const lines = [
    `Usage: ${command.synopsis}`,
    "",
    ...wrap(command.summary, WIDTH),
  ];
  if (command.options.length)
    lines.push("", "Options:", ...table(command.options));
  for (const note of command.notes ?? []) lines.push("", ...wrap(note, WIDTH));
  if (command.examples.length) {
    lines.push("", "Examples:");
    for (const example of command.examples) lines.push(INDENT + example);
  }
  return lines.join("\n") + "\n";
}
