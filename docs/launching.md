# How a launch runs

Hosts, terminals, repeated requests, and what happens when an outcome is not known.

[← back to the README](../README.md)

## Session lifetime

A tmux session is stopped after 30 minutes with no pane activity. Set
`--idle-timeout 2h` to lengthen it, `--idle-timeout off` to disable it for one
launch, or `[session] idle_timeout` in `config.toml` to change the default for
every launch. `--ttl` adds a hard ceiling regardless of activity, for a session
that looks busy only because something is looping inside it. A session with a
client attached is never stopped. The limit applies to tmux sessions only: pty
and macos-terminal sessions die with the process that launched them, and a task
ends when its prompt does.

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
to an existing personal OpenCode server. `list` refreshes the session through
that endpoint; `stop` aborts it best-effort and still performs authoritative
process-tree cleanup. The URL is local control metadata, not a public address.
OpenCode sessions otherwise use the same tmux/pty, viewer, list, stop, and human
output behavior described above; OpenCode tasks use the same detached output
and exit-status lifecycle as other tasks.

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

| First attempt                     | A repeat gets                              |
| --------------------------------- | ------------------------------------------ |
| Reachable session or running task | That session or task, unchanged            |
| Still launching                   | Refused — ask for its status instead       |
| Failed, exited or stopped         | Refused, naming the recorded outcome       |
| Outcome unknown                   | Refused, and told to inspect first          |

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
