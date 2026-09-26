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
        "display the tmux session in a terminal (macOS); APP is terminal, iterm2 or ghostty, defaulting to the configured terminal",
      ],
      [
        "--terminal APP",
        "deprecated, removed in v2: pass the app to --open instead",
      ],
      [
        "--level LEVEL",
        "read, work, or open: a legal permissions and sandbox pair",
      ],
      ["--permissions MODE", "auto, deny, or bypass"],
      ["--sandbox MODE", "read-only, workspace-write, or full-access"],
      ["--mcp NAME", "repeatable; replaces configured defaults"],
      [
        "--options NAME",
        "repeatable; muster-side launch options — auto-approve-path records the launch directory as trusted so its one-time dialog does not block the launch (claude and codex only, and refused if the directory ships hooks or MCP servers)",
      ],
      ["--no-mcp", "launch with no MCP servers"],
      ["--plugin NAME", "repeatable; replaces configured defaults (OpenCode)"],
      ["--no-plugin", "launch with no plugins"],
      [
        "--model MODEL",
        "model for the launch: a bare id for claude and codex, PROVIDER/MODEL for opencode",
      ],
      [
        "--idle-timeout DURATION",
        "stop a tmux session after this much inactivity; 30m by default, off to disable",
      ],
      [
        "--ttl DURATION",
        "stop a tmux session this long after launch, whatever its state",
      ],
      [
        "--request-key KEY",
        "name the request; sending it again returns the same launch",
      ],
      ["--format FORMAT", "json (default) or human"],
      ["-- RUNTIME_OPTIONS", "everything after -- is passed to the runtime"],
    ],
    notes: [
      "Naming both --level and --permissions or --sandbox is an error rather than a precedence rule.",
      "A pty launch keeps this process running and Ctrl-C stops it; a tmux launch survives this process exiting.",
    ],
    examples: [
      "muster run claude --prompt 'Review this project' --cwd .",
      "muster run codex --identity work --level work --prompt 'Ship it'",
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
    summary: "start the MCP server on stdio",
    synopsis: "muster mcp",
    options: [],
    notes: [
      "Exposes run, list, stop and output. No arguments does the same when stdin is not a terminal, which is what an MCP client provides.",
    ],
    examples: ["muster mcp"],
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
      "MCP: install deliberately in the one authorized session, never at user scope.",
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
