# Failures, states and fixes

Back to [SKILL.md](SKILL.md).

Every CLI error is one line on stderr, `[muster] <reason>`, with exit code 1;
a refused launch leaves nothing running. `muster doctor` also exits 1 when a
plugin copy is stale. Read the reason before retrying: most refusals are
deliberate and a retry with the same arguments gets the same answer.

## Launch failures

| Symptom | Cause | Fix |
|---|---|---|
| Claude session times out after ~30 s, message names an untrusted directory | workspace-trust dialog | trust it once by hand, or `--options auto-approve-path` |
| Times out, trust ruled out | something else on the session's screen — a login prompt or other one-time confirmation | a person runs the runtime in that directory once; a `--kind task` there shows whether the runtime itself starts |
| `--unrestricted` Claude launch times out | the Bypass Permissions warning | add `--options accept-bypass-warning` |
| `full-access or bypass requires allow_dangerous_flags in config.toml` | `open`/`bypass` not authorised | the operator sets `allow_dangerous_flags = true` at the top level of `~/.muster/config.toml` |
| Every muster command fails after a config edit | a key placed inside a `[section]` that does not accept it (nested tables are strict), or a bad value | move it or fix it; unknown **top-level** keys are only warned about and ignored |
| `--options auto-approve-path refused: … ships hooks …` | the directory configures hooks or MCP servers | trust it by hand after reviewing it, or launch without the option |
| `model … is not declared under [opencode.provider.<p>.models]` | local model id not listed | add the table the message prints |
| OpenCode `work` launch refused at `$HOME` | cwd contains `~/.muster` | launch in the project directory |
| Claude launch refused over managed policy | managed settings files detected | not fixable from muster; use a machine or account without them |
| Refused: outside allowed roots | `allowed_roots` / `[projects]` configured | use a permitted directory or `--project NAME` |
| `Concurrency cap reached (N)` | `max_concurrent` (default 4) counts every starting or running session and task, idle ones included | `muster list`, stop sessions you are done with |
| Refused: same `--request-key` with different parameters | keys are bound to their first request | use a new key for a different launch |

## Inside a running session

| Symptom | Cause |
|---|---|
| `Operation not permitted` / `PermissionError: [Errno 1]` | the OS sandbox (`EPERM`). `Errno 13` would be an ordinary permission problem. At `read` nothing is writable; at `work` only the cwd, `$TMPDIR` and the config dir |
| Bash cannot delete a file the agent just wrote | Write is not sandbox-fenced, Bash is |
| Memory write fails from Bash under `projects/` | Claude Code refuses that path to sandboxed Bash; use Write/Edit |
| `git push`, ssh `git fetch` or `gh` fails | sandboxed network; hand the push back to the caller |
| Session is on a different model than the profile | the profile's `model` is not read; relaunch with `--model` |
| A sibling repo is invisible | the session sees only `--cwd`; launch at a common parent |
| A claude.ai connector or user MCP server is missing | MCP comes only from muster's selection |
| A task "succeeded" but did nothing | it asked for an interactive-only tool and exited 0; read `muster output` |
| Reached over Tin Can but never replies | no Tin Can MCP server in the session (`--mcp tincan`), or OpenCode without the Tin Can plugin |

## States in `muster list`

Session `state`: `idle` or `busy` while running; then `exited`, `stopped`,
`failed` or `unknown`. Task `state`: `running`, then `exited` with
`exit_code` (or `signal`). A failed launch keeps its `error`.

- **`unknown`** — muster died between starting a process and recording it. A
  session may be running unrecorded. Find it (`tmux -L muster ls`), stop it if
  there, and relaunch under a new request key. Do not just relaunch.
- **`failed`** — nothing is running; retrying is safe once the cause is fixed.
- An ended session's per-launch identity copy and MCP config are removed by the
  next `muster list`.

## Lifetime

- No idle timeout by default. `--idle-timeout` counts **pane output**, so a
  thinking agent's spinner keeps it alive, and a session with a terminal
  attached is never idle-stopped. Enforcement is periodic, so a session can
  outlive its limit by about a minute.
- `--ttl` stops a session after that long, whatever it is doing, attached or
  not.
- Only tmux sessions have these limits and survive the launching process. A
  `pty` session lives as long as the `muster` process that launched it
  (Ctrl-C stops it) and cannot be attached or titled.
- `[session] idle_timeout` / `ttl` in config set defaults for every launch.

## Terminals

- `--open [APP]` (`terminal`, `iterm2`, `ghostty`; default from config
  `terminal`) needs tmux and is refused for tasks. `--terminal APP` is
  deprecated; pass the app to `--open`.
- `--open ghostty` starts a **separate Ghostty app instance**. Scripts that
  drive Ghostty by name may then reach that instance instead of the user's
  windows. To control placement or app, launch without `--open` and run the
  `attach_hint` in a terminal you opened yourself.
- The muster tmux server reads no `~/.tmux.conf`; muster turns on mouse
  scrolling, a 50,000-line history and extended keys (so Shift+Enter is a
  newline) itself. `MUSTER_TMUX_SERVER` names a different server.
- Closing a viewer window detaches it; the session keeps running until
  `muster stop`.

## muster's own MCP tools

| Symptom | Cause | Fix |
|---|---|---|
| No `mcp__plugin_muster_muster__*` tools | the plugin's server did not start: no `npx` on PATH, Node older than 22.12, or (on Linux) node-pty could not build | `/mcp` shows the error; install a build toolchain, or use the global install and `muster mcp install` |
| `list` and `output` appear twice | both the plugin's server and a `muster mcp install` registration are loaded | harmless; turn one off in `/mcp` |
| `run` refused, or no `run` tool | the plugin's server is read-only, always | `muster mcp install --allow-launch`, only if the user asked for launch authority |
| The plugin's server reports a different version from `muster --version` | the plugin pins its own release; `npx` uses the global copy only when it is that version | update both: `npm update -g` and `claude plugin update muster@muster` |
