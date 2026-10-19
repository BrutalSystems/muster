# Command-line reference

Output formats, runtime pass-through, and the flags `run` accepts.

[← back to the README](../README.md)

## Output formats

For readable terminal output, add `--format human` to `run`, `list`, `stop`, or
`doctor`:

```sh
muster run codex --prompt 'Review this project' --format human
muster list --format human
muster stop THREAD_OR_SESSION_OR_RUN_ID --format human
```

Human output keeps full IDs and shows directory, host, state, and relevant
attach/output/stop commands with actual IDs. pty sessions are labeled as not
watchable or attachable. `--format json` is explicit JSON; omitting the flag
still returns JSON. Put Muster options before any `-- RUNTIME_OPTIONS`.
`output` always prints captured task text and does not accept `--format`.
MCP tools retain their existing JSON responses.

Human output uses subtle colors in interactive terminals: green for idle or
running, yellow for busy or starting, gray for ended states and field labels,
red for failures or nonzero exit codes, and cyan for follow-up commands. IDs
and paths retain the normal text color. Set `NO_COLOR=1` to disable colors;
piped output and `TERM=dumb` are always uncolored. JSON never includes colors.

## Exit status

Every command exits 1 on an error, with these exceptions. `wait` exits 2 for
an id that names nothing and 124 on timeout. Any command exits **75** when the
registry is locked by another muster operation for longer than the lock wait:
retry it. A lock whose owner has died is broken automatically, and so is one
with no owner recorded once it is 15 seconds old.

## Passing options to the runtime

`run` accepts an optional `--` followed by runtime arguments. The normal
allowlist is `--model` / `-m`, plus Claude's `--effort`, `--name` and `--plugin-dir` (not in a sealed launch) and OpenCode's `--agent`
and `--variant`. For Claude and Codex a model named there is _consumed_ rather
than forwarded — it reaches the child through the same path as `--model`, so it
appears once — and naming a model both ways is refused rather than resolved by
precedence. Claude's `--resume <id>` / `-r <id>` and `--fork-session` are
consumed the same way, as the spellings of muster's own `--resume` and
`--fork-session` (see below). Unknown options, bundled short options, config injection and
raw permission overrides are refused, even with `allow_dangerous_flags`
enabled. Use Muster's normalized permission flags. Prompt strings are always
passed as one literal argument. Codex and Claude launches and OpenCode tasks put
that value after `--`; OpenCode sessions use the dedicated `--prompt` value.

## Resuming a Claude session

`muster run claude --resume <session-id> --prompt "<next message>"` reopens an
existing conversation instead of starting one. Everything else about the
launch is as usual — level, `--open`, `--title`, `--model`, `--on-exit`, and
`wait`/`stop`/`output`/`list` afterwards — and the run reports the resumed
session id, not a new one: if Claude registers any other session, the launch
fails. Add `--fork-session` to continue it under a new id,
leaving the original untouched.

Muster refuses, before anything is reserved:

- an id that is not a UUID: a bare `--resume` or a search term opens Claude's
  picker, which nobody is there to answer;
- a conversation that is not in the config dir the launch runs in
  (`$CLAUDE_CONFIG_DIR/projects/*/<id>.jsonl`);
- a conversation recorded in a different directory from `--cwd` (Claude would
  resume it anyway, with history about another tree);
- a session that is still running, since two processes on one transcript
  interleave it and register the same id twice — `--fork-session` is allowed,
  because it only reads the original;
- `--identity`, whose fresh config dir holds none of the profile's
  conversations;
- a remote requester: the resumed session carries that whole conversation, and
  being allowed to launch is not being allowed to read every conversation in
  the profile.

## Provider and model configuration

OpenCode inherits the provider and model definitions from its normal user and
project configuration, so configured local OpenAI-compatible providers such as
`local-provider/qwen3-30b` remain available. Muster never rewrites those
files. Put runtime options after `--`, as in the example above.

```sh
muster run opencode --prompt 'Review this project'
muster run opencode --prompt 'Build a plan' -- --model local-provider/qwen3-30b
muster run opencode --kind task --prompt 'Summarize the tests'
muster run opencode --mcp tincan --permissions auto --sandbox workspace-write --prompt 'Coordinate'
```
