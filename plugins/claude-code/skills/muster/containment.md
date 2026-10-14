# Containment, settings and trust

Back to [SKILL.md](SKILL.md).

## Two axes, one spelling

- `--permissions` (`deny` | `auto` | `bypass`) — whether the agent stops to
  ask. The runtime honours it; a refusal arrives as a tool error the agent can
  read.
- `--sandbox` (`read-only` | `workspace-write` | `full-access`) — what it may
  touch. For Claude and Codex the OS enforces it (seatbelt, macOS only); a
  refusal arrives as `EPERM` with no explanation the agent can interpret.

The three sealing flags are shorthand for a legal pair, never a second policy
(`--level read|work|open` is the older spelling):

| Flag | Equivalent |
|---|---|
| `--read-only` | `--permissions deny --sandbox read-only` |
| `--write-here` | `--permissions auto --sandbox workspace-write` |
| `--unrestricted` | `--permissions bypass --sandbox full-access` |

`deny` with `workspace-write` (edit without auto-approving escalations) has no
level; spell it with the two flags. `auto` requires `workspace-write`; `bypass`
requires `full-access`. With none of these, the launch uses `permissions` /
`sandbox` from `~/.muster/config.toml` if either is set there. If neither is
set, a Claude launch is **normal** (below) and Codex or OpenCode get `deny` +
`read-only`.

Every result reports `enforcement`: `kernel` (Claude or Codex, sandbox
active), `tool-policy` (OpenCode — rules the agent is asked to respect, no
kernel fence) or `none` (`full-access`, or a normal launch, where the
profile's own settings decide and muster imposes nothing). Off macOS, `enforcement` reports what
was actually applied.

## What each sealed level allows a Claude session

- **`read`** — reads anything; writes refused everywhere, including its config
  dir and memory. Bash runs and reports honest exit codes.
- **`work`** — Bash may write the cwd, `$TMPDIR` and the session's own
  `CLAUDE_CONFIG_DIR` (so memory writes work). `~/.muster` is denied even when
  the cwd contains it. Two holes:
  - **Claude's Write/Edit tools are not fenced by the sandbox**, only Bash is.
    A Write outside the tree succeeds; a Bash `rm` of that file then fails.
    Treat `work` as "Bash is confined", not "writes are".
  - **`$CLAUDE_CONFIG_DIR/projects/`** (project-scoped memory, transcripts) is
    refused to sandboxed Bash by Claude Code itself. Tell the agent to save
    project memory with Write/Edit, since `auto` mode nudges it toward shell
    edits.
- **`open`** — no sandbox. Needs `allow_dangerous_flags = true` at the **top
  level** of `~/.muster/config.toml`; placed under a `[section]` it makes the
  config invalid and every muster command fails. Claude additionally needs
  `--options accept-bypass-warning`, or it stops on the Bypass Permissions
  warning and the launch times out.

**Network:** muster sets no network policy. What a sandboxed Claude can reach
is Claude Code's sandbox default, and in practice `git fetch`/`push` over ssh
and `gh` have failed from `work` sessions. Plan for "commit on a branch, hand
the push back", and `git fetch` before launching so the agent starts from a
current base. Conversely, `read` does not by itself stop a network action.

## What a Claude launch keeps from the profile

**Normal launch (the default): everything.** muster runs `claude [-p]` with the
prompt and nothing else, so the session gets what `claude` typed by hand in
that folder gets:
- user, project and local settings;
- rules and CLAUDE.md;
- the `env` and `autoMode` blocks;
- permissions, including `additionalDirectories`;
- hooks and the status line;
- plugins;
- the profile's MCP servers and connectors.

`default_mcp` is not added, since the profile brings its own; `--mcp NAME`
adds a server beside them. muster refuses the launch only when the profile's or
project's `permissions.defaultMode` is `bypassPermissions`.

**Sealed launch (`--read-only`, `--write-here`, `--unrestricted`):** muster
starts Claude with `--setting-sources ""`, `--strict-mcp-config` and its own
inline settings, so **no rules or CLAUDE.md load**. From the profile's
`settings.json`:

| Kept | Dropped |
|---|---|
| `enabledPlugins`, `extraKnownMarketplaces` (so the profile's plugin skills load) | `model` — pass `--model` |
| `tui` (layout) | hooks (`disableAllHooks` is set) and therefore the status line |
| | `env`, and every `CLAUDE_CODE_*` variable from the caller's environment |
| | `permissions`, `sandbox` (muster's replace them) |
| | `permissions.additionalDirectories` — the session sees only its `--cwd`; launch at a common parent to reach a sibling repo |
| | user/project MCP servers and claude.ai connectors — MCP comes only from muster (`default_mcp` for sessions, `--mcp` for anything) |

`CLAUDE_CONFIG_DIR` **is** inherited, so the session runs under whichever
config dir the caller's environment names (see [runtimes.md](runtimes.md)).

muster refuses a sealed Claude launch when it detects managed policy files
(`managed-settings.json` and friends), because it cannot prove its inline
settings win over them. A normal launch has no inline settings to prove and
obeys managed policy as a hand launch does.

## Workspace trust (Claude, and Codex's equivalent)

An untrusted directory stops a Claude **session** at the trust dialog; muster
times out, cleans up, and says whether trust was the cause. Two ways past:

1. The operator opens `claude` in the directory once and accepts.
2. `--options auto-approve-path` records the trust before launch, in the
   config dir the child will use (the per-launch copy, for `--identity`).

What `auto-approve-path` does:

- It writes the **repository root** as trusted, so trusting a subdirectory
  trusts the whole repo. Decide on that basis.
- It is **refused** when the directory ships hooks in `.claude/settings.json`
  or an `.mcp.json`: trusting would let that configure the session. The
  operator has to trust such a directory by hand.
- It is refused for OpenCode, which has no trust gate.

A `--kind task` runs headless and never consults trust, which makes it a quick
check: if a task in the same directory starts, trust is what blocked the
session.

## Where a launch may run

With `allowed_roots` or `[projects]` configured, a launch outside them is
refused. `--project NAME` launches in a configured project's directory. This
limits where a session **starts**, not what it can reach afterwards. A sealed
level limits that; a normal launch is limited only by the profile's own
settings.
