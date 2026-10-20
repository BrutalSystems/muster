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

## Launch metadata and provenance

The repeatable `--options` flag also accepts `metadata=JSON` and
`provenance=JSON`. Existing named options keep their behavior. These are
**caller-supplied facts**, not secrets or grants of authority:

```sh
muster run codex --prompt 'Review this project' --read-only \
  --options 'metadata={"workflow.role":"reviewer","workflow.versions":"rules@4"}' \
  --options 'provenance={"namespace":"workflow","session":"run-002","launcher":"controller","parent":"run-001"}' \
  --title reviewer
```

`metadata` is a flat string-to-string object: at most 32 entries, nonempty
keys of at most 64 UTF-8 bytes, values of at most 1024 UTF-8 bytes, and at most
16 KiB when serialized as compact JSON with sorted keys. Values may be empty.
Muster assigns no meaning to the keys. Use a namespace of your choosing.

`provenance` has exactly four fields:

| Field | Meaning |
| --- | --- |
| `namespace` | The caller's identifier namespace |
| `session` | The new session's ID in that namespace |
| `launcher` | The caller's name for the application performing the launch |
| `parent` | The requesting session's ID in the same namespace, or explicit `null` for an operator root |

Every identifier uses 1–128 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`,
`:`, and `-`. A missing or empty parent is refused. A `null` parent is a
caller-declared root, not proof of operator authorization. Omitting the entire
provenance option means it was not supplied. The caller maintains the mapping
between its session IDs and Muster's IDs; Muster does not require parents to
exist, enforce uniqueness, or build a launch tree.

Both objects are stored when the launch is reserved. They appear in `run`,
`list`, and `wait` output for sessions and tasks, including failed or ended
records. The programmatic `wait` result contains them in `record`; the CLI
prints that record directly, as before. Human output shows both objects. Use
`--title` separately to display a role in a tmux terminal; changing the title
does not change the stored facts.

These fields cannot be updated through Muster. Supported sealed launches
protect the registry using the existing filesystem containment; this does not
protect it from an unrestricted process running as the same OS user. The
registry's existing `requester` records who supplied the facts under Muster's
caller model, and `owner` identifies the Muster process. Neither is replaced
by the caller's `launcher` or `parent` claim. Authorization must come from the
calling application's own trusted records.

Each structured option may occur only once. Malformed JSON, duplicate object
keys (including escaped spellings), wrong value types, unknown provenance
fields, and exceeded limits fail before reservation. Each raw JSON payload
also has a 128 KiB input limit, including whitespace. Reusing a request key
with different annotations is refused; object key order, option order and JSON
whitespace do not change the request. An absent metadata object and an explicit
empty object are distinct. Existing requests without annotations preserve their
retry behavior and output shape.

MCP callers put the same strings in the existing `options` array. As before,
remote requesters cannot supply `options`; the local CLI and launch-enabled
local MCP server can. These options never forward data into runtime arguments
or prompts. They are visible in records, output and launch logs: do not put
credentials, tokens or other secrets in them.
