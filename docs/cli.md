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

## Passing options to the runtime

`run` accepts an optional `--` followed by runtime arguments. The normal
allowlist is `--model` / `-m`, plus Claude's `--effort` and OpenCode's `--agent`
and `--variant`. For Claude and Codex a model named there is _consumed_ rather
than forwarded — it reaches the child through the same path as `--model`, so it
appears once — and naming a model both ways is refused rather than resolved by
precedence. Unknown options, bundled short options, config injection and
raw permission overrides are refused, even with `allow_dangerous_flags`
enabled. Use Muster's normalized permission flags. Prompt strings are always
passed as one literal argument. Codex and Claude launches and OpenCode tasks put
that value after `--`; OpenCode sessions use the dedicated `--prompt` value.

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
