# Runtimes, models and accounts

Back to [SKILL.md](SKILL.md).

## Claude Code (`muster run claude`)

- Durable id: `session_id`. Reachable over a Unix socket; Tin Can can deliver
  to it even with no MCP tools, but it needs the Tin Can MCP server to reply.
- `--model` takes a bare id or alias (`sonnet`, `opus`, a full model id). The
  profile's own `model` setting is not read, so a launch without `--model`
  gets the account default.
- A task runs `claude -p`: headless, no trust dialog, no interactive-only
  tools.

## Codex (`muster run codex`)

- Durable id: `thread_id` (not `session_id`). Reachable over JSON-RPC.
- Kernel-sandboxed like Claude. At `work`, Codex's `--approve-for-me` sends a
  write outside the writable roots to Codex's own reviewer, which may approve
  it; `~/.muster` is still read-only to it.
- Inherited MCP servers, hooks, plugins, app connectors and notifications are
  disabled for the child; only muster-selected MCP servers run.

## OpenCode (`muster run opencode`)

- Durable id: `session_id`; each session gets its own HTTP server on
  `127.0.0.1` (`server_url` in the result — local control metadata, not an
  address to share). muster never attaches to an OpenCode server you started.
- **Containment is tool policy, not a kernel sandbox** (`enforcement:
  tool-policy`). A shell command cannot be confined to one folder, so a `work`
  launch whose cwd is `~/.muster`, inside it, or an ancestor of it (such as
  `$HOME`) is **refused**. Launch in the project directory.
- Reachable over Tin Can only when the Tin Can **plugin** is selected
  (`--plugin tincan` or `default_plugins`); the MCP server alone does not
  advertise it.
- `--plugin NAME` (repeatable) replaces configured plugins; `--no-plugin`
  selects none. With no plugins it runs `--pure`. Selecting any plugin also
  loads plugins the target repo ships in `.opencode/plugin(s)/`, so select
  plugins only for repos you trust.
- `--pure` disables plugins only. OpenCode still reads the project's
  `AGENTS.md` (else `CLAUDE.md`), a global `~/.config/opencode/AGENTS.md`
  (else `~/.claude/CLAUDE.md`) and `~/.claude/skills`, so it can carry the
  launching user's personal instructions.
- `--model PROVIDER/MODEL`. `muster doctor` checks path-configured OpenCode
  plugins for stale copies and exits 1 if any is stale.

### OpenCode on a local model

A local OpenAI-compatible server is declared under
`[opencode.provider.<name>]` in `~/.muster/config.toml`, and **every model id
needs its own table**:

```toml
[opencode.provider.local.models."qwen2.5-14b"]
name = "Qwen2.5 14B (local)"
tool_call = true
```

muster refuses a launch naming an undeclared model of a muster-declared
provider and prints the table to add. It does **not** check that the server is
up — check it yourself first (`curl -s <base-url>/models` should list the id).
Provider API keys belong in `api_key_env_var`, read from the launching
environment.

Small local models are cheap and private but weak at tool use: they answer
without reading the file, loop on one read, print tool calls as text, or report
an exit code while hiding the error. Use them for mechanical jobs with a
checkable result, and:

- give **the exact command or file**, not a goal;
- ask for **raw output**, not a summary;
- check the result outside the model: `exit_code` in `muster list` and the
  tool output in `muster output`, never the closing sentence;
- put any "read X first" instruction in the prompt — a small model often
  ignores pointers inside `AGENTS.md`/`CLAUDE.md`.

Keep judgement, debugging, multi-step work and anything hard to undo on a
frontier model.

## Running under a different account

Two mechanisms; pick one.

**A different Claude config dir (profile).** muster passes
`CLAUDE_CONFIG_DIR` through from the caller's environment, so the child runs
as whatever account that directory is logged in as, and anything it creates is
owned by that account:

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude-work" muster run claude --cwd ~/src/api \
  --level work --prompt "…"
```

Codex uses `CODEX_HOME` the same way. Under `work`, the launched session may
write that config dir (its memory lives there). Remember what is dropped from
that profile's settings ([containment.md](containment.md)).

**A muster identity** (`--identity NAME`). A named, pre-authenticated template
under `~/.muster/identities/<name>`; each launch runs from a fresh per-launch
copy, so one launch can never alter another's credentials.

```sh
muster setup-identity --identity work --agent claude --interactive   # runs the login; a person must complete it
muster setup-identity --identity ci --agent claude --token-env CLAUDE_TOKEN
muster identities --format human                                     # what exists, whether a credential is set
muster run claude --identity work --cwd ~/src/api --prompt "…"
```

- A Claude identity needs a token (`--interactive` stores one; `--token-env`
  names a variable holding one). Keychain login cannot work from the copy, and
  `run --identity` refuses an identity with neither.
- Without `--interactive`, `setup-identity` only prints the login command for a
  person to run. It is an interactive OAuth flow: don't run it unattended.
- The per-launch copy, **including the session transcript**, is deleted by
  `muster stop` or the first `muster list` after the launch ends. Capture
  anything you need from it while it runs.

Don't set up an identity when the caller already has a working config dir for
that account; the environment variable is enough.
