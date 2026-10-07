# How a launch runs

Hosts, terminals, repeated requests, and what happens when an outcome is not known.

[← back to the README](../README.md)

## Session lifetime

A tmux session has no idle timeout by default. Set `--idle-timeout 30m` or
`--idle-timeout 2h` to arm an inactivity limit, or `[session] idle_timeout` in
`config.toml` to set a default for every launch. `--ttl` adds a hard ceiling
regardless of activity, for a session that looks busy only because something is
looping inside it. A session with a client attached is never stopped. The limit
applies to tmux sessions only: pty and macos-terminal sessions die with the
process that launched them, and a task ends when its prompt does.

## Terminal titles

A tmux session's terminal title is the name `list` and `stop` accept, followed by
the runtime (`simple-cms-46 · claude`), so a window opened with `--open` or
attached by hand says which session it is. Until the agent is reachable and has
a name, the title is the directory and runtime. It is never the prompt.

```sh
muster run claude --title "reviewer" --prompt "Review this project" --open
muster title simple-cms-46 "reviewing #48"   # retitle a running session
```

`--title` (MCP `run`: `title`) sets it at launch. `muster title <id> TEXT` (MCP
`title`) changes it while the session runs, without involving the agent.
Control characters are stripped, since the title reaches the terminal inside an
escape sequence, and it is capped at 100 characters. Both are refused for tasks,
pty and macos-terminal sessions, and sessions that have ended.

Muster's title holds even though agents set their own: Claude Code retitles
itself with a status glyph and its current topic. To show the agent's title
instead, set this in `config.toml`:

```toml
[session]
title_from_agent = true
```

## Opening a terminal

Add `--open` to display the launched session in a new Terminal.app window on macOS:

```sh
muster run codex --open --prompt "Review this project" --format human
muster run claude --open --terminal ghostty --prompt "Review this project" --format human
muster run opencode --open --terminal iterm2 --prompt "Review this project" --format human
muster run codex --open --terminal iterm2 --prompt "Review this project" --format human
```

MCP `run` accepts `open: true`. This requires tmux and selects it when the host
is auto; explicit pty hosts and tasks are rejected. Detached launch remains the
default. `--terminal auto|terminal|iterm2|ghostty` requires `--open`; omitted or
`auto` uses Terminal.app. MCP accepts the same `terminal` values. Explicit
choices never silently fall back. iTerm2 and Ghostty must be installed as
`iTerm.app` or `Ghostty.app` in `/Applications` or `~/Applications`.
The host remains tmux. Successful results include `terminal_opened: true` and
the resolved `terminal` (a launch event, not a live window-status check).
Closing the Terminal window leaves the session running; use `muster stop <id>`
to stop it. Terminal.app and iTerm2 may require macOS Automation permission.
Ghostty opens a separate app instance that exits when its last window closes;
that instance disables saved-window restoration so previous tabs and windows
are not duplicated. It uses the [Ghostty macOS launch interface](https://github.com/ghostty-org/ghostty/discussions/9221).
Terminal.app creates the requested window before activation
to avoid also opening a default shell window on startup.
iTerm2 uses its [documented scripting interface](https://iterm2.com/documentation-scripting.html).
If the launch request to the viewer fails,
Muster stops the launched session and returns an error.

Auto-selection tries tmux, then pty. Every peer includes `host`, `capabilities`
and `attach_hint`. Watchability is separate from the runtime's idle/busy state.

- **tmux:** each agent has its own session on the dedicated `muster` tmux
  server. `MUSTER_TMUX_SERVER` names a different one, for a caller that must not
  share the machine's Muster server — Muster's own test suite sets it, so a gate
  run cannot leave sessions beside yours. Opening or exiting one agent does not
  switch another agent's viewer.
  Watchable and attachable; survives the CLI or MCP server exiting.
  Use the returned attach hint to reconnect to that agent.
  The server reads no tmux config (`-f /dev/null`), so your `~/.tmux.conf`
  never changes how a muster session behaves. Muster sets what an attached
  terminal needs instead: `mouse on`, so the scroll wheel reaches the
  session's history; `history-limit 50000`; and extended keys
  (`extended-keys always`, `extended-keys-format csi-u`, `xterm*:extkeys`), so
  Shift+Enter reaches Claude Code as a new line instead of submitting the
  prompt. A tmux too old for an option launches without it.
- **pty:** not watchable or attachable. The CLI prints the peer record and stays
  running to own the terminal. Ctrl-C stops it. MCP-owned pty sessions stop when
  the MCP server disconnects. There is no persistent pty daemon.
- **task:** a per-run worker captures stdout/stderr and exit status after the
  launching CLI exits. It supervises one task, with no retry or restart behavior.

`list` refreshes live session metadata and shows ended runs distinctly. A timeout
or startup failure cleans the process tree and host window, logs failure, and
returns an error instead of a peer record.

Each OpenCode session owns a separate HTTP server bound to `127.0.0.1` on a
Muster-selected port. Muster verifies that the listener belongs to the launched
process tree, stores its `server_url` and durable `session_id`, and never attaches
to an existing personal OpenCode server. OpenCode keeps every project's sessions
in one shared database, so Muster claims a new session in the launch directory
only when that endpoint reports it busy, or, once it has gone idle, when its
first message is the launch prompt. `list` refreshes the session through
that endpoint; `stop` aborts it best-effort and still performs authoritative
process-tree cleanup. The URL is local control metadata, not a public address.
OpenCode sessions otherwise use the same tmux/pty, viewer, list, stop, and human
output behavior described above; OpenCode tasks use the same detached output
and exit-status lifecycle as other tasks.

## OpenCode on a local model

A local OpenAI-compatible server can back an OpenCode launch: declare it under
`[opencode.provider.<name>]` in `~/.muster/config.toml` and name the model with
`--model <name>/<id>`.

**Every model id needs its own entry**, not just the provider:

```toml
[opencode.provider.local.models."qwen2.5-14b"]
name = "Qwen2.5 14B (local)"
tool_call = true
```

On its own, OpenCode answers a model the server offers but the config does not
list with a bare `Unexpected server error`. Muster now refuses that launch up
front, before anything is reserved, and names the table to add:

```
model qwen2.5-14b is not declared under [opencode.provider.local.models]; add [opencode.provider.local.models."qwen2.5-14b"] to ~/.muster/config.toml
```

The check covers `--model`, a model in the runtime options and `[opencode]
model`. It applies only to providers declared in muster's config: a built-in
OpenCode provider such as `anthropic` or `openai`, or one from your own OpenCode
configuration, is left for OpenCode to resolve. Check the server is up first;
muster does not probe it.

**What an OpenCode launch reads by default.** `--pure` disables plugins only.
OpenCode still loads the project's `AGENTS.md` (or its `CLAUDE.md` when there is
no `AGENTS.md`), a global `~/.config/opencode/AGENTS.md` (or `~/.claude/CLAUDE.md`),
and skills under `~/.claude/skills`. So a session can carry the launching user's
personal instructions; see [#50](https://github.com/BrutalSystems/muster/issues/50).

**Small models and tool use.** In testing with 3B to 30B local models, the
failures were consistent: answering from nothing instead of reading the file
the question named, looping on the same read, printing a tool call as text
instead of making it, and reporting an exit code while hiding the error. What
held up was a prompt naming the exact command or file, and a result checked
outside the model: the task's exit code in `muster list` and the actual tool
output in `muster output`, not the model's closing sentence.

**Watching a session on a particular screen.** `--open` puts the window wherever
the terminal application chooses. To control placement, launch without `--open`
and attach from a terminal you have positioned yourself, using the returned
`attach_hint`.

## Where a launch may run

By default any directory the account can read is a legal target, which is the
behaviour Muster has always had. Two config settings narrow it:

```toml
allowed_roots = ["/Users/you/Source"]

[projects]
muster = "/Users/you/Source/brutalsystems/muster"
```

With either configured, a launch outside all of them is refused. A configured
project is a grant in its own right — naming a directory there permits it
without also permitting its parent.

```sh
muster run codex --project muster --prompt "Review the auth flow"
```

`--project NAME` (MCP: `project`) is used instead of `--cwd`; naming both is an
error rather than a precedence rule. A project name is also portable in a way an
absolute path is not, since the same name can point somewhere different on
another machine.

The check resolves symlinks before comparing, so a link inside an allowed root
that points elsewhere does not escape it, and compares path-relatively, so
`/work/project-other` is not treated as part of `/work/project`.

This constrains **where a session starts, not what it can then reach**. It is
not a sandbox: a launched agent still has whatever access the OS account has.
Permission modes and the sandbox settings below are the controls for that.

## Process ownership

Muster identifies a launched process by its **pid paired with its start time**,
and revalidates that pair whenever the registry is touched — including after
Muster itself restarts.

This is not a compromise chosen for convenience. On macOS it is the strongest
check the public platform offers:

- There is no cgroup. Process groups and sessions are the nearest approximation
  and are escapable by design, so they bound a tree rather than owning it.
- The kernel's unique process identifier is not exposed in the public SDK.
- The audit-token route requires a message from the target process, which a
  supervisor observing arbitrary children never has.

Two consequences worth stating, because both look like redundant work to a
reader who does not know why they are there:

- **Identity is revalidated at the moment of use, not at discovery.** Every
  signal, every status answer and every registry pass re-checks the pair. A pid
  discovered a moment ago may already belong to something else.
- **Revalidation after a Muster restart is deliberate.** Comparable supervisors
  trust what they recorded before they died. Muster does not, which is why a
  session that ended while Muster was not running is reported as ended rather
  than as running.

Process-tree membership uses two signals, because neither is sufficient alone.
The parent chain is exact while it holds, and stops holding the moment an
intermediate process exits — its children reparent to launchd and are no longer
reachable from the root, though they are still doing the session's work. The
process group survives that, since reparenting changes no process's group.

Muster records the group the launched root leads and takes the union. A stop
reaches reparented workers, and a session whose root has died but whose group is
still busy is reported as running rather than ended.

Only a group the root _leads_ is used. A process that merely belongs to someone
else's group shares it with whatever else is there — a shell, a tmux pane, the
terminal — and treating that as membership would reach far outside the session.
Both terminal hosts start their root in a new session, so in practice it does
lead its own group. A process that calls `setsid()` for itself still escapes;
nothing on macOS prevents that.

## Repeating a launch request

`--request-key KEY` (MCP: `requestKey`) names the launch _request_, not the
session it produces. Sending the same key again returns the launch it already
produced instead of starting a second agent:

```sh
muster run codex --prompt "Review the auth flow" --request-key review-auth-7f3a
```

A key is bound to the parameters it was first seen with — runtime, kind,
resolved working directory, the instruction, the effective permissions, the
selected MCP servers and plugins, and the model. Sending the same key with any
of those changed is **refused**, rather than answered with a session that does
something other than what was asked. Launching something genuinely different
means using a different key.

The fingerprint is computed here, after validation, rather than accepted from
the caller: two machines canonicalize a path differently, and a fingerprint
computed before validation would disagree with itself.

What a repeat returns depends on what the first attempt did:

| First attempt                     | A repeat gets                        |
| --------------------------------- | ------------------------------------ |
| Reachable session or running task | That session or task, unchanged      |
| Still launching                   | Refused — ask for its status instead |
| Failed, exited or stopped         | Refused, naming the recorded outcome |
| Outcome unknown                   | Refused, and told to inspect first   |

A repeat never consumes launch capacity, including when the concurrency cap is
full of the very launch being asked about. Omitting the key leaves behaviour
exactly as it was: every request is its own launch.

## When an outcome is unknown

If Muster dies between starting a process and recording it, the entry says
`unknown` rather than `failed`, and `muster list` reports it that way.

The distinction is not cosmetic. `failed` means nothing is running and retrying
is safe; `unknown` means a session may be running that Muster never got to
record, and relaunching would be how a second agent appears in the same
directory. A repeat under the same request key is refused for exactly that
reason.

Only the half of the window that provably never reached a spawn is still called
`failed` — an owner that died before Muster marked itself about to start a
process. Resolving an `unknown` entry is manual today: look for the session,
stop it if it is there, and launch again under a new key.
