---
name: muster
description: "Use when asked to launch, start, spin up or muster an agent session or one-shot task (Claude Code, Codex or OpenCode) with the `muster` CLI, or to list, read output from or stop one: \"start a Claude session in ../api to review the PR\", \"run this as a one-shot Codex task\", \"spin up an OpenCode session on the local model\", \"stop that muster session\". Also for choosing --level read/work/open, or a launch that timed out or was refused."
---

# muster — launching agent sessions and tasks

`muster run` starts a Claude Code, Codex or OpenCode agent under containment
you choose, waits until it is actually reachable, and returns JSON describing
it. Use it instead of assembling `claude …` in a terminal yourself: the
launch is tracked (`list`), stoppable (`stop`) and recorded.

This skill matches **muster 1.2.2**. Check `muster --version`; if it differs,
trust `muster <command> --help` over this file.

**Not for:**
- **Messaging a running session.** That is Tin Can (`send_peer`); muster only
  hands you the address.
- **Watching sessions** for stalls or questions. That is birddog.
- **A session a person will sit in and use as their own.** muster replaces the
  profile's settings (see *What a launch keeps*), so it has no status line,
  hooks or settings `env`. Start `claude` normally for that.
- **Getting round a refusal in your own session.** Launching a `--level open`
  task to run what your own permissions refused is evasion, not a fix. Report
  the refusal instead.

## Choose the launch

| Choice | Default | Change it when |
|---|---|---|
| Runtime | `claude` | the request names `codex` or `opencode` |
| `--kind` | `session` | `task` for one job that runs headless, exits and leaves output. A task has no peer address and no MCP servers unless you pass `--mcp` |
| `--level` | config default (`deny` + `read-only` unless the operator changed it) | `read` to look, `work` to edit the working tree, `open` only when explicitly asked. Always pass one |
| `--cwd` | the caller's cwd | the repo the work is in. It is all a Claude session can see |
| `--prompt` | required, non-blank | always the actual instruction, so the agent self-starts |

Levels are named pairs of `--permissions` and `--sandbox`:

| Level | Asks before acting | May write | Notes |
|---|---|---|---|
| `read` | yes (`deny`) | nothing | Bash works, writes refused |
| `work` | no (`auto`) | its cwd, `$TMPDIR`, its own config dir — never `~/.muster` | Bash is fenced to the tree; Claude's Write tool is not |
| `open` | no (`bypass`) | everything | needs `allow_dangerous_flags = true` in config; Claude also needs `--options accept-bypass-warning` |

Details, and what each level does not stop: [containment.md](containment.md).

## Commands

```sh
# A session you will drive (Claude needs the dir trusted, or the option below)
muster run claude --cwd ~/src/api --level work \
  --options auto-approve-path --prompt "Review the open PR and report findings"

# A one-shot task: runs headless, exits, keeps its output
muster run codex --kind task --cwd ~/src/api --level read \
  --prompt "Run the test suite and paste the raw failures"
muster list --kind task            # state running -> exited, with exit_code
muster output <task-id>            # the captured output: the only way back from a task

muster list --format human         # everything, readable
muster title <id> "reviewing #48"  # retitle a running tmux session
muster stop <id>                   # id, durable session/thread id, name or canonical address
```

Useful `run` flags: `--model` (bare id for claude/codex, `PROVIDER/MODEL` for
opencode), `--mcp NAME` (repeatable, replaces `default_mcp`), `--no-mcp`,
`--idle-timeout 30m`, `--ttl 4h`, `--title TEXT`, `--project NAME` (instead of
`--cwd`), `--identity NAME`, `--request-key KEY`, `--open [terminal|iterm2|ghostty]`,
`--format human`. Runtime flags go after `--`, and only an allowlist passes
(`--model`/`-m`; Claude's `--effort`; OpenCode's `--agent`, `--variant`).

Refused rather than resolved: `--level` with `--permissions` or `--sandbox`;
`--project` with `--cwd`; `--mcp` with `--no-mcp`; a model given both as
`--model` and after `--`; a bare-number duration (`30` — write `30s`/`30m`/`4h`).

## What `run` returns

JSON on stdout, exit 0. On any error: `[muster] <reason>` on stderr, exit 1,
and nothing left running. A **session** result carries `name`,
`canonical_id`, `cwd`, `host`, `attach_hint` (e.g.
`tmux -L muster attach-session -t <target>`), `permissions`, `sandbox`,
`enforcement` (`kernel`, `tool-policy` or `none`), `mcp`, and a durable id:
`session_id` for Claude and OpenCode, `thread_id` for Codex. A **task** result
carries `id` and `state: "running"`.

**Keep the durable id.** Names change (a runtime retitles itself, a session can
be renamed), and `canonical_id` embeds the name, so it changes with it.
`muster stop` accepts the durable id whatever the name has become.

## Reaching and stopping a session

- **Message it over Tin Can** when the session has the Tin Can MCP server
  (from `default_mcp` or `--mcp tincan`): address it by its current name from
  `peers`, pinned to the durable id (`expect_id`), or by `canonical_id`.
  Without the tool a Claude or Codex session still *receives* but cannot reply.
  An OpenCode session is a Tin Can peer only with the Tin Can **plugin**
  selected (`--plugin` or `default_plugins`).
- **Read its screen** (tmux host): `tmux -L muster capture-pane -p -t <target>`,
  where `<target>` is the last word of `attach_hint`.
- **Type into it**: `send-keys -t <target> C-u` to clear suggested-prompt
  ghost text, then `send-keys -t <target> "text"`, then `Enter` in a
  **separate** `send-keys` call — `Enter` in the same call can leave the text
  unsubmitted.
- **Stop it** when done: `muster stop <durable-id>`. Sessions have **no idle
  timeout by default** and each holds a `max_concurrent` slot (default 4)
  until stopped. Pass `--idle-timeout 30m` if it should go away on its own.

To let a person look, give them `attach_hint` to run in a terminal they
already have, or launch with `--open`. Closing that window leaves the session
running.

## Traps (the short list)

- **Untrusted directory → a Claude session times out** (~30 s,
  `launch_timeout_sec`) at the workspace-trust dialog. Fix: the operator opens
  `claude` there once, or pass `--options auto-approve-path`, which trusts the
  **whole repository** and is refused if the directory ships hooks or an
  `.mcp.json`. A `--kind task` never meets the dialog.
- **The profile's settings are replaced.** Plugins and layout come across; the
  profile's `model`, hooks, status line, `env`, permissions and extra
  directories do not. Pass `--model` if the model matters.
- **A task is headless.** Tools that exist only in an interactive session are
  missing; a task asked to use one can report it missing and still exit 0. Read
  `muster output`, not just `exit_code`.
- **`work` does not mean network.** Don't expect a sandboxed Claude to `git
  push`, `git fetch` over ssh or use `gh`; tell it to commit and hand the push
  back. And `read` is not a network block either.
- **Write vs Bash at `work`:** Claude's Write tool can create files outside the
  tree that its Bash then cannot delete. `Operation not permitted` / `Errno 1`
  is the sandbox, not a path bug.
- **`unknown` state** means a session may be running that muster never
  recorded. Look before relaunching, or you get two agents in one directory.

More, with fixes: [troubleshooting.md](troubleshooting.md). Codex, OpenCode,
local models, identities and running under another Claude config dir:
[runtimes.md](runtimes.md).

## Don't

- Install `muster mcp` at user scope, or put a `muster mcp` server in
  `default_mcp`. That hands launch authority to every session. If one agent
  must orchestrate, give that one session `--mcp muster`.
- Edit `~/.muster/config.toml` from an agent. muster never writes it, and a
  `work` launch cannot; config changes (allowed roots, providers,
  `allow_dangerous_flags`) are the operator's to make.
- Use `--ttl` on a session a person is attached to: it is a hard ceiling and
  stops the session whatever its state.
