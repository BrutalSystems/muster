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

## Full access with the profile intact

Claude and Codex accept an explicit profile-loading opt-in:

```sh
muster run claude --unrestricted --options inherit-profile \
  --options auto-approve-path --options accept-bypass-warning --prompt 'Review this project'
muster run codex --kind task --unrestricted --options inherit-profile --prompt 'Review this project'
```

This requires `allow_dangerous_flags = true` in Muster's configuration. It
requests bypass permissions and no sandbox while retaining the runtime's
normal profile configuration, instructions, hooks, plugins and MCP servers.
Claude receives a small per-launch settings override rather than the sealed
settings bundle. Codex tasks retain user configuration as sessions do, and
neither kind receives Muster's hook/plugin/MCP disabling overrides in this mode.
Codex sessions use `--no-daemon` to keep thread ownership inside the launched
process tree; this mode requires a Codex CLI supporting that flag (verified with
0.163.0). It does not attach the session to a shared background server.
Existing calls without the option retain their behavior. OpenCode and restricted
permission modes refuse the option. Remote callers cannot supply launch options.

`inherit_profile` is recorded at reservation and cannot be changed through
Muster. It appears in `run`, `list` and `wait`, including ended launches; legacy
records omit it. Changing the option with the same request key is refused.
The field records the explicit opt-in, not whether every profile component
successfully loaded. A normal Claude launch still inherits its profile without
this option.

Profile MCP servers remain enabled. Explicit `--mcp` selections add Muster
servers; `--mcp none` selects no Muster servers without removing profile servers.
Muster's configured `default_mcp` is not added in this mode. Codex name collisions
use a separate Muster server name to avoid merging credentials or policy. Claude
uses a per-launch `muster_<launch-id>_<server>` namespace for explicitly selected
servers in this mode, keeping their names separate from profile definitions.

`auto-approve-path` still refuses a workspace carrying hooks or MCP configuration;
trust that workspace yourself first. `accept-bypass-warning` remains Claude-only
and explicit. Profile code runs with your account's privileges, and prompts are
not an isolation boundary. Detected managed Claude policy refuses the launch,
as it does for other explicit permission modes: Muster cannot prove its overrides
win. Runtime checks, profile hooks and
programs such as `sudo` can still block or refuse an operation. Muster does not
promise that every interaction becomes unattended.

## Waiting for input

Session results from `run`, `list` and `wait` include an additive `input_status`
observation. The existing activity/lifecycle `state` is unchanged:

```json
{
  "state": "busy",
  "input_status": {
    "state": "waiting",
    "reason": "permission",
    "source": "codex-status",
    "observed_at": "2026-01-01T12:00:00.000Z"
  }
}
```

A positive observation has `state: "waiting"`, a reason and evidence source.
Otherwise all runtimes return `state: "unknown"`, `reason: "unknown"` and
`source: "none"`. Unknown means there is no current recognized evidence; it
never means the agent is definitely unblocked. Idleness alone is not evidence.
`observed_at` is the time Muster sampled the evidence, not when the dialog began.

Current native evidence is Codex's active approval/user-input flags and
OpenCode's pending permission/question requests, filtered to the launched
session. Muster reads current snapshots rather than replaying possibly stale
notifications between CLI invocations. Claude's current session registry provides
activity but no equivalent input-wait signal.

For tmux sessions, Muster also inspects the visible pane (no scrollback), bounded
to 64 KiB and 500 ms, and classifies its last 16 non-trailing-blank lines
within an 8,192-character tail. The held-message heading may appear earlier in
that bounded visible tail; its active menu must end the pane. Recognized reasons include trust, bypass-warning, permission,
MCP approval, plan approval, login, password and SSH host-key confirmation. Screen
matches are best-effort heuristics: changed/localized dialogs and arbitrary
programs can be missed, and displayed examples can resemble a dialog. Native
positive evidence takes precedence. Screen text is never saved in records, logs
or responses; only the reason, source and observation time are retained.

`list` and `wait` resample evidence. An observation can clear to unknown on the
next read; old evidence is not treated as a current wait after the process ends
or the evidence source becomes unavailable. Starting sessions can be inspected
once a live launch root and tmux pane are recorded. PTY hosts without native
signals, tasks and ended records report unknown; their output files are not
scanned for old prompts. Muster never answers dialogs or sends passwords.

Readiness still uses the top-level `launch_timeout_sec` configuration (default
30, positive values up to 600). This is a launch budget, not a timeout for dialogs
in an already running session. Long-running MCP servers need a restart after a
configuration change.

## Restrict MCP while keeping the Claude profile

```sh
muster run claude --unrestricted --options inherit-profile \
  --options restrict-mcp --mcp example --prompt 'Review this project'
muster run claude --unrestricted --options inherit-profile \
  --options restrict-mcp --no-mcp --prompt 'Review this project'
```

`restrict-mcp` keeps profile instructions, settings, plugins and hooks, but uses
strict MCP configuration to load only the explicitly selected Muster servers.
All claude.ai account connectors, automatic IDE MCP and Chrome integration are
disabled for this launch. Plugin MCP servers are excluded even though the plugins
and their hooks remain loaded. The option requires Claude Code 2.1.305 or later,
`inherit-profile`, full access and `allow_dangerous_flags = true`. Unsupported
runtimes, unverifiable versions and detected managed policy are refused.
The existing refusal to auto-trust workspace hooks or MCP configuration remains.

Selection must be explicit: use `--mcp NAME` (repeatable), `--no-mcp` for none,
or the MCP API's `mcp: []`. Omitting selection is refused. Unknown server names
are refused. Without `restrict-mcp`, existing additive behavior is unchanged.
Selected account connectors and other runtimes are not supported by this option.

`mcp_selection` is recorded at reservation and returned by run/list/wait, including
ended records. It contains `mode: "explicit"`, sorted source-qualified server IDs
such as `muster:example`, and `claude_ai: false`. It cannot be changed through
Muster. IDs name configured Muster servers, not frozen server definitions or
credentials. Changing selection or enabling/disabling restriction conflicts with
an existing request key; reordering the same selection does not. Old records omit
the field; an explicit empty selection records an empty `servers` array.

This controls the runtime's startup MCP inventory, not the authority of a
full-access process. Retained hooks and the agent can still execute programs or
make network requests. It is not a sandbox or a restriction on account access
outside MCP. Verification against Claude Code 2.1.305 confirmed that a selected
server connected, empty selection loaded no servers, unselected plugin MCP did
not start, and profile rules and a plugin SessionStart hook still ran.

## Per-launch Claude guards

Attach local policy scripts without editing a profile or workspace:

```sh
muster run claude --unrestricted --options inherit-profile \
  --options restrict-mcp --no-mcp --options guard=/path/to/bundle.json \
  --prompt 'Review this project'
```

`guard=FILE` is repeatable in CLI `--options` and the local MCP `options` array.
It requires Claude Code 2.1.305 or later, `inherit-profile`, and the existing
`allow_dangerous_flags` opt-in. It works with sessions and tasks, with or without
`restrict-mcp`. Codex and OpenCode attachments are refused. Without a guard
option, existing launch behavior is unchanged. Workspace auto-trust checks remain.

A bundle is a strict JSON object:

```json
{
  "version": 1,
  "id": "local-policy",
  "hooks": [
    {
      "event": "PreToolUse",
      "script": "check.py",
      "interpreter": "python3",
      "matcher": "Bash",
      "timeout": 10
    }
  ],
  "files": ["policy.json"],
  "deny": ["Bash(example-command:*)"]
}
```

Scripts and optional asset files resolve relative to the manifest. They must
be regular files inside that directory; symlinks, absolute attachment paths and
`..` traversal are refused. Manifest paths resolve relative to the launch's cwd.
A hook interpreter is `node`, `python3`, `sh`, or `bash`, resolved in the runtime's
PATH. Optional `args` is an array of strings passed after the script path.
Use the script's location to find bundled assets; the working directory stays
the launch directory. External interpreters, dependencies and services are not
snapshotted or pinned.

Synchronous `PreToolUse` and `Stop` command hooks are supported.
For `PreToolUse`: The default matcher
is `.*`, matching every tool; the default timeout is 10 seconds (1–60 allowed).
Each hook receives Claude's JSON input on stdin. Exit 0 with empty stdout passes;
exit 2 blocks. JSON output must contain only `hookSpecificOutput` with
`hookEventName: "PreToolUse"`, `permissionDecision: "allow"` or `"deny"`, and an
optional `permissionDecisionReason`. An allow result continues the normal
profile permission checks. Other output shapes, malformed JSON, nonzero exits,
more than 64 KiB stdout, and timeouts block. The attachment runner emits only a
generic denial, withholding script stdout/stderr and private reasons. Input is
limited to 1 MiB. It runs the script with the stated timeout; Claude gets two
additional seconds to start and finish the runner. Denial reasons must be strings
of at most 4096 characters; duplicate JSON keys are refused. Muster also adds
`onFailure: "block"` so a missing/crashing/timed-out guard blocks rather than
silently allowing a tool call. It refuses detected managed policy, disabled-hook
profiles and incompatible runtimes. Existing profile hooks remain active; the
attachment adds hooks and deny rules to the same per-launch settings overlay
that carries Muster's sandbox and connector choices.

### Turn-end reminders (`Stop`)

Add a hook with `"event": "Stop"`, `script`, `interpreter`, optional `args` and
`timeout` to a version-1 bundle. A Stop hook cannot have a `matcher`. Claude Code
2.1.306 or later is required; Codex attachments remain refused. Up to 32 Stop
hooks across all bundles run through one dispatcher, alongside the retained
profile's hooks. Scripts run concurrently, each with its own timeout.

Exit 0 with empty stdout passes. To request continuation, exit 0 with exactly
`{"decision":"block","reason":"Finish the pending work."}`. Reasons must be
non-empty strings of at most 4096 characters. The combined reason is bounded to
4096 characters and **is sent to the model and may appear in transcripts**.
Keep it non-secret. Malformed or duplicate-key JSON, other output shapes,
nonzero exits, missing scripts, oversized output and timeouts are failures;
the working dispatcher requests continuation with a generic failure reason.

The allowance is **one continuation per launch, session and prompt**, shared
across all Muster Stop hooks. An atomic private claim prevents simultaneous
invocations from each consuming an allowance. `stop_hook_active` also consumes
the allowance, even if a profile hook requested that continuation. Subsequent
Stop invocations still evaluate the policies, but cannot block again. A new
prompt (including after `/clear`) gets its own allowance. Missing or malformed
runtime turn identity produces a failure with continuation unavailable, rather
than guessing a new budget. Private budget files last until launch cleanup.

Run/list/wait expose `stop_guard_status` separately from the immutable `guards`
summary. It is the latest observation, retained after exit: `state` is `unknown`,
`passed`, `unresolved` or `failed`; `continuation` is `none`, `requested`,
`exhausted` or `unavailable`. Completed observations have `observed_at` and, when
identity is valid, a `turn` hash. No reason or raw session/prompt input is stored
there. A runner starts by recording unknown, so interruption during evaluation
does not leave an old pass. This is an observation, not proof of current inbox
contents or an authenticated safety attestation; a full-access process can
modify its local files.

An unresolved or failed check after the allowance is consumed reports exhausted
and allows the turn to end, with a generic diagnostic. Claude ignores
`onFailure: block` for Stop hooks: if the dispatcher itself cannot start, is
killed or hits Claude's outer timeout, completion can still happen. No fresh
observation is guaranteed when it cannot start. This is a bounded reminder,
**not an absolute completion gate**, and it does not wake an idle agent.
Profile hooks are preserved and may independently request continuations; their
budgets are outside Muster's control. Hook timeouts bound evaluation and cleanup
signals the policy's process group; a descendant that daemonizes into another
process group can survive. Attached policies must not daemonize. These hooks do
not provide process containment. Claude's own retry cap is not a reliable
bound for tool-using continuations, so Muster enforces its own allowance.

Limits: 16 bundles, 64 KiB per manifest, 32 hooks and 64 unique attached files per
bundle, 1 MiB per file, and 4 MiB of attached file data per launch. IDs contain
1–64 letters, digits, underscores or dashes and must be unique within a launch.
Unknown fields, duplicate JSON keys and invalid inputs are refused. Deny rules
are optional, up to 128 strings of 1–1024 characters per bundle. Hook arguments
are limited to 32 strings of at most 1024 characters each.

Muster reads attachments into memory before reserving the launch, then writes
private per-launch copies. The runtime receives a settings-file path, not raw
rules or scripts in its launch arguments. Later source edits do not change the
snapshot. Private files are removed on stop/failure, task exit, or when an ended
session is refreshed. Cleanup failures emit a content-free `cleanup_pending`
audit event and are retried on later refreshes; they do not block other artifact
cleanup or hide ended records. A crashed launch owner may leave files until
reconciliation.

The immutable `guards` summary contains an aggregate digest and each bundle's
ID, digest, event names, hook count and deny-rule count. Run/list/wait retain it
after exit. It records delivery configuration, not proof that a policy is
complete or every hook ran. Retries compare canonical manifests and attached
file bytes; changing a script at the same path conflicts. JSON object key order
and whitespace do not matter; bundle/hook/argument order does. Old records omit
`guards`. Source paths, scripts and rule contents are not stored in the registry
or Muster's launch audit log.

Keep IDs non-sensitive. Bundles are private policy files, **not secret storage**:
the full-access process can read or modify them. Hook arguments and output can
appear in runtime diagnostics or transcripts, and captured task output retains
what the runtime prints. Do not put credentials or secrets in scripts, rule
strings, arguments or denial messages. A hook sees tool calls, not every action
inside a program; catching a literal command inside `sh -c` does not catch every
encoded or indirect equivalent. Keep critical credentials outside the session's
reach when that operation must be impossible.


The bounded Codex 0.163.0 compatibility probe found working hook injection and
per-launch rules loading, but hook errors could allow the tool call through.
Attachment-only trust required undocumented state, and subsequent `write_stdin`
input did not receive a fresh `PreToolUse` check. Codex attachments therefore
remain refused; a guard bundle is never silently reduced to prefix rules.

## Conversation resets inside a launch

Claude `/clear` starts a new conversation inside the existing process. Muster
keeps the same `launch_id` and original `id`, while `session_id` and
`canonical_id` report the current observed conversation. Use `launch_id` for
supervision and stopping; use the current canonical address for Tin Can delivery.
An old canonical address is historical evidence, not a forwarding address.
Observed raw session IDs remain aliases for controlling the same launch;
`launch_id` avoids ambiguity across separate resumed launches.

`runtime_history` contains ordered observations with `session_id`,
`canonical_id`, and `first_observed_at`. It survives exit and is available in
run/list/wait records. These are observation times, not exact conversation start
times. Several clears between observations may leave intermediate IDs unseen.
A new launch starts with one observation; an older record acquires history when
its original conversation can be verified. A legacy launch already cleared
before that verification cannot be safely rebound automatically.

A new Claude ID is accepted only for the same runtime PID and process start
time, still under the launch root, with a reachable messaging socket. Ambiguous
registries, process replacements and missing evidence do not cause automatic
rebinding. `tracking_error: "runtime_identity_unverified"` explains an unsuccessful
refresh; `unreachable` does not mean the owned process exited. Concurrent
refreshes cannot replace a newer identity observation with an older one.

Identity rotation requires the original parent-chain relationship; a reparented
process is not rebound from process-group membership alone. Process-group
ownership still governs stopping and exit detection.

Codex `/new` tracking is currently unsupported. A bounded probe of Codex 0.163.0
found that the same process retains multiple writer locks and that an old
thread remains RPC-readable after the foreground thread changes. When the
original thread cannot be uniquely verified under its launch root, Muster
reports `tracking_error: "codex_thread_tracking_unsupported"` and `unreachable`
instead of claiming the old thread is current. It does not choose a thread by
lock order or modification time. Start a new supervised launch for a new Codex
conversation. This diagnostic does not mean the owned process has exited.

Claude held-message menus are observed as `input_status.state: "waiting"`,
`reason: "held-message"`, with `source: "tmux-screen"` and an observation time.
The detector requires the heading, both Deny/Deliver choices and a selected
menu row in the visible pane. Dismissing or answering the dialog clears that
observation on the next refresh. Screen/message contents are not persisted,
and observation never sends keys or answers the dialog. PTY and macOS Terminal
hosts currently lack screen observation and remain `unknown`; no Codex
held-message equivalent is claimed. `unknown` is not proof that typing is safe:
screen detection is heuristic and a dialog can appear after an observation.


## Identifying launches before readiness

While a launch is `starting`, `list` includes `name`, `title`, `cwd` and
`provisional: true`, alongside the existing `launch_id`, metadata and provenance.
The display label comes from the sanitized explicit `--title`, otherwise the
folder name plus runtime. It is not a runtime identity or Tin Can address.
The existing restrictions on `--title` still apply: only tmux sessions accept it.
Legacy starting records use the folder/runtime fallback. Running and ended
records keep their existing fields and naming behavior.

For subprocess callers that need the ID early, opt in with
`--options report-launch`. After reservation and before preparation/spawn,
Muster writes one newline-delimited JSON event to **stderr**, for example:

```json
{"event":"launch-reserved","launch_id":"example-launch-id","state":"starting","reused":false,"runtime":"claude","kind":"session","cwd":"/work/project","name":"review","title":"review","provisional":true}
```

Parse stderr by lines and select `event: "launch-reserved"`; other diagnostic
lines can also appear there. Stdout still contains the usual final result,
`run` still waits for readiness, exit codes keep their meaning, and PTY ownership
is unchanged. The event means a reservation exists, **not that a process has
started or is ready**. Later failure can follow it. Use the stable `launch_id`
with `list`, `wait`, or `stop`; a runtime conversation ID may arrive later.
Stopping during startup records durable cancellation. If stop wins before the
spawn claim, no process is started. If spawning is already in flight, Muster
waits for ownership and cleanup before confirming the stop. It never reports
`stopped: true` while the startup owner can still start a process.

A startup owner that cannot finish within the five-second cancellation wait
produces a pending error, not success; run/list/wait include
`cancellation_pending: true` until acknowledgement. Inspect or retry stop to
confirm the result. An owner that dies after claiming a spawn but before
recording ownership leaves an `unknown` outcome, never a claim that no process
exists. Existing process-stop operations can extend the cancellation wait.

A matching request-key retry reports the existing ID and actual recorded state
with `reused: true`, then follows the existing retry behavior: a starting or ended
launch still produces its usual error. Conflicting retries and other refusals
before reservation emit no event. Adding or removing `report-launch` does not
change request-key matching. Display fields on retries come from the original
reservation, never replacement request text. Only starting events carry the
provisional display fields. Prompts, environment, scripts and credentials are
not included; keep explicit titles non-secret.

JavaScript callers may pass a synchronous reservation reporter as the third
argument to `Muster.run(input, requester, reporter)` with the same option.
A throwing reporter fails a new reservation before spawn; it never changes an
existing reused launch. The option is refused without a reporter, including
through MCP; it does not introduce MCP progress messages or a receipt file.
