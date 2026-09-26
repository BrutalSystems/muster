# Configuration, permissions and containment

What an agent may do, who may ask for it, and how that is enforced.

[← back to the README](../README.md)

## Configuration and permissions

Muster reads `~/.muster/config.toml` once at startup and **never writes it**.

A key this build does not know is reported and ignored, so a config written for
a newer Muster does not stop an older one from running — a strict top level is
what made every 0.10.0 command fail with `unrecognized_keys` the moment
`terminal` was added in 0.11.0. Values are still validated, and the nested
policy tables stay strict: a dropped `sandbox` value would launch under the
default rather than the pair that was written, and an unknown key inside a
requester profile is a policy statement that would not apply.

Missing configuration uses these defaults:

```toml
host = "auto"
tmux_status = "off"
terminal = "terminal"
launch_timeout_sec = 30
max_concurrent = 4
permissions = "deny"
sandbox = "read-only"
allow_dangerous_flags = false
default_mcp = []
```

Choose `sandbox = "workspace-write"` yourself when agents should edit files.
`full-access` and `permissions = "bypass"` require `allow_dangerous_flags = true`.
The old config spelling `danger-full-access` remains accepted as an alias.

Per-launch `--permissions` and `--sandbox` override these config defaults. The
same named fields are accepted by MCP `run`. Both session and task launches
support them:

```sh
muster run codex --permissions auto --sandbox workspace-write \
  --prompt 'Implement the change' --format human
muster run claude --permissions auto --sandbox workspace-write \
  --prompt 'Implement the change' --format human
```

| Muster permissions | Codex translation            | Claude Code translation             | OpenCode translation                                                            |
| ------------------ | ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| `deny` (default)   | Approval policy `never`      | Permission mode `dontAsk`           | Deny write, shell, task, external-directory, web, and unselected MCP operations |
| `auto`             | `--approve-for-me`           | Permission mode `auto`              | `--auto` with explicit deny rules                                               |
| `bypass`           | Bypass approvals and sandbox | Permission mode `bypassPermissions` | Allow supported operations                                                      |

`deny` refuses actions that would require approval; it does not prohibit tools
already allowed by the sandbox or permission rules. `auto` delegates permission
review to the runtime and may still reject an action; it is not blanket approval.
Auto mode requires `workspace-write` in Muster because the Codex preset selects
that sandbox. Explicitly select it; Muster never widens a read-only request.
Bypass requires `full-access`; combinations claiming a sandbox while bypassing
it are refused. `deny` can be combined with any authorized sandbox setting.

`full-access` disables the runtime command sandbox and requires operator-owned
config authorization even without bypass. Muster never writes that config.
Config defaults apply to subsequent launches; overrides apply to one launch.
Resolved `permissions` and `sandbox` are returned in records, shown in human
output, persisted for listing, and written in the pre-launch log. Old records
without those fields remain readable; their settings are not guessed.

The runtimes' enforcement differs: Codex reviews sandbox escalation requests;
Claude's classifier reviews tool permission requests while its Bash sandbox is
separate. Auto-mode availability and decisions remain subject to runtime,
model, account, and managed policy. These fields describe Muster's resolved
launch settings, not a continuous attestation of remote policy or user changes.
See [Codex auto-review](https://learn.chatgpt.com/docs/sandboxing/auto-review) and
[Claude permission modes](https://code.claude.com/docs/en/permission-modes).

OpenCode permissions are tool policy, not an OS-level filesystem sandbox.
Muster's read-only OpenCode policy denies editing, shell, subagent,
external-directory, web, and MCP operations except explicitly selected MCP
tools; it does not claim kernel-enforced isolation. Auto still requires
`workspace-write`, and bypass still requires authorized `full-access`.

The concurrency cap is shared by separate CLI/MCP processes, including pending
launches. Settings apply to both kinds; tasks are read-only by default.

Codex defaults to an explicit sandbox and never-ask approval policy. Muster enumerates
and explicitly disables inherited MCP servers, enables only the selected
operator definitions, then verifies the effective server selection. Hooks, plugins, app connectors, automatic skill-MCP installation
and external notifications are disabled for the child. Unknown MCP names that
cannot be addressed safely are refused.

Claude's built-in tools default to enabled. Unless full access is selected, its command sandbox is enabled,
requires availability, and forbids unsandboxed retries. File-writing tools and
sandbox writes are denied in read-only mode; default permissions use `dontAsk` so an
unattended child does not auto-grant escalations. User/project settings and MCP
servers are not inherited. Detected managed policy is refused because the CLI
cannot prove that inline settings override it. Enterprise remote policy can
arrive after startup; this v1 is not an enterprise policy-enforcement layer.
Claude permissions and its command sandbox are different mechanisms; neither
claim implies that every external tool is OS-sandboxed.

**`workspace-write` does not fence Claude's Write tool, only its Bash.** This
is measured, not inferred — see "Write/Bash fence asymmetry" in
[PROBE_RESULTS.md](./PROBE_RESULTS.md). At `--level work` an agent's Bash write
outside the working tree is refused with `Operation not permitted`, while the
Write tool creates the same path successfully. The practical consequence is
that **an agent can create files outside the tree that it cannot then delete**,
because creation goes through Write and cleanup goes through Bash. No setting
Muster writes expresses the missing fence: the alternative, `deny`, blocks the
Write tool everywhere rather than by path, including inside the tree. Treat
`work` as "Bash is confined to the workspace", not "writes are". If that
distinction matters for a given launch, the containment that does hold for both
is `read`.

OpenCode keeps normal provider/model configuration and launches with `--pure`
unless plugins are selected, which disables inherited external plugins.
Providers declared under `[opencode.provider]` and a model named by
`[opencode] model` or `--model` are supplied in the same verified overlay (a
model named after `--` instead rides the child's argv and is left out of the
overlay, so it is delivered once rather than twice), so a
launch does not depend on the operator's own OpenCode configuration; provider
definitions merge with any the child resolves for itself rather than replacing
them. Secrets belong in `api_key_env_var`, read from the launching environment,
not in `config.toml`. Before launch, Muster inspects the
effective OpenCode configuration, disables every inherited MCP server and tool
family, enables only the selected Muster definitions, and fails closed if a
higher-precedence managed policy prevents that isolation from being proven.

These child restrictions prevent automatically propagating spawn authority.
External tools are enabled only through the operator configuration and launch
selection described below. Codex and Claude runtime inboxes remain reachable
from an external Tin Can even when they have no MCP tools of their own. An
OpenCode session is reachable as a Tin Can peer only when the Tin Can plugin is
selected with `--plugin`; the plugin, not the MCP server, is what advertises the
session to other runtimes.
No user-level runtime configuration is rewritten, and workspace-trust dialogs
are never accepted automatically.

Launch intent is fsynced to `~/.muster/launches.jsonl` before a runtime starts;
ready/failure outcomes follow. For a local requester the log contains the
**full prompt**, cwd, requester, runtime, kind and host. A non-local requester
gets metadata-only logging instead — no prompt text and no environment values,
see [Requester profiles and enrolments](#requester-profiles-and-enrolments)
below. Registry and task outputs also live under `~/.muster`, with private
file permissions. An abandoned `registry.lock` fails closed: verify no Muster
operation is running before removing that directory. There is no automatic
time-based lock theft. `launches.jsonl` rotates at 8 MiB: the file is renamed
to `launches.jsonl.1`, replacing any previous generation, and a fresh file is
opened at mode `0600`. One prior generation is kept; this bounds the file
without adding a retention policy nobody asked for.

### Launch options

`--options NAME` names something **Muster** does on the caller's behalf. That is
what separates it from the pass-through after `--`, which reaches the runtime
verbatim and is refused unless that runtime's row allow-lists it. The set is
closed, and naming an option a runtime cannot express is an error rather than a
silent no-op.

| Option              | What it does                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `auto-approve-path` | Records the launch directory as trusted in the profile the agent will use, so its one-time dialog does not block the launch. |

`auto-approve-path` needs a runtime with a workspace-trust gate: Claude and
Codex have one, OpenCode does not and the option is refused for it. The record
is written before the agent starts, into the same configuration directory the
child will open — which an identity launch relocates to a per-launch copy — and
under the canonical key described in [Claude workspace trust](claude-trust.md),
so **trusting a subdirectory trusts its
whole repository**. Decide on that basis, not on the path you happened to pass.

**The directory is screened first.** Trusting a folder lets its own
`.claude/settings.json` configure the session, hooks included, and hooks run
without asking — that is what the dialog exists to ask about. So a directory
shipping hooks or an `.mcp.json` is named and the launch refuses:

```
[muster] --options auto-approve-path refused: /path ships hooks in
.claude/settings.json; trusting it would let that configure the session.
Trust it yourself once, or launch without the option.
```

Not expressible remotely, for the same reason `--mcp` is not: it would have this
machine trust a directory a remote caller named, and trust is what lets that
directory configure the session.

### Containment levels

Two axes, answering different questions:

- **`--permissions` decides whether the agent stops to ask a human.** It
  configures the runtime's own approval prompting — a setting the agent's
  process honours.
- **`--sandbox` decides what the agent may touch, and the kernel enforces it.**
  On macOS that is seatbelt. Nothing the agent does talks its way past it.

The difference is not academic: a permissions refusal arrives as a prompt or a
tool error the agent can read and react to, while a sandbox refusal arrives as
`EPERM` from the kernel, with no negotiation and often no explanation the agent
can interpret. `enforcement` below records which of the two a launch actually
got.

`--level` names a legal `--permissions` / `--sandbox` pair. It is a spelling,
not a second policy path, and naming both a level and either flag is an error.

| Level  | Equivalent to                                                                         |
| ------ | ------------------------------------------------------------------------------------- |
| `read` | `--permissions deny --sandbox read-only`                                              |
| `work` | `--permissions auto --sandbox workspace-write`                                        |
| `open` | `--permissions bypass --sandbox full-access` (still requires `allow_dangerous_flags`) |

`deny` with `workspace-write` or `full-access` has no level and stays available
through the flags.

Every launch also records how strongly its containment was imposed:

| `enforcement` | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `kernel`      | Codex or Claude Code with an OS sandbox configured and active.              |
| `tool-policy` | OpenCode — rules the agent is asked to respect, with no kernel enforcement. |
| `none`        | `full-access` — the sandbox is deliberately disabled.                       |

#### What a sandboxed launch may write

Muster names the write roots rather than leaving them to default. Under
`workspace-write` a launched Claude session may write its cwd, `$TMPDIR`, and
**its own configuration directory** — the `CLAUDE_CONFIG_DIR` the child will
actually use, which an identity launch or a requester profile's `env_defaults`
may relocate. That last root is granted because an agent's memory lives there:
without it every Bash write to memory failed with `EPERM` while the in-process
file tools succeeded, which reads from inside the session as a path bug rather
than a boundary.

Under `read` nothing is writable, including the config dir. Under `full-access`
there is no sandbox to grant into.

One path stays denied that muster cannot open: **`$CLAUDE_CONFIG_DIR/projects/`**
(and `shell-snapshots/`). Claude Code refuses writes there in a sandboxed Bash
regardless of what muster grants — naming those directories explicitly in
`allowWrite` changes nothing, which is presumably deliberate, since a session's
own transcripts live there. Project-scoped memory under
`projects/<cwd-slug>/memory` is therefore reachable only through the file tools,
which are in-process and not kernel-sandboxed. Note that `work` implies auto
mode, which asks the model to prefer shell commands for file edits, so a session
saving project-scoped memory has to be told to use `Write`/`Edit` instead.

### Requester profiles and enrolments

A non-local caller — one reached through a transport such as Tin Can rather
than the local CLI or a local MCP client — is identified by an `(authority,
subject)` tuple supplied by whatever already authenticated it. That tuple must
be enrolled in `config.toml` and bound to a profile, or the request is
refused. Two additions to `configSchema`, following the existing record style
of `[projects]`, `[mcp_servers]` and `[plugins]`:

```toml
[requester_profiles.research]
allowed_roots = ["/Users/you/Source"]
level = "read"
min_enforcement = "kernel"      # "tool-policy" to admit OpenCode here
env_allow = ["GH_TOKEN"]
env_defaults = { PATH = "/usr/bin:/bin", LANG = "en_US.UTF-8" }
identities = ["research"]       # bounds which identities this requester may name

[[requesters]]
authority = "example.peer.v1"
subject = "<opaque authenticated key id>"
label = "m4pro"
profile = "research"
```

`[[requesters]]` is an array of tables rather than a record keyed by
`"authority:subject"`, so no separator can be ambiguous inside a subject. Two
enrolments with the same `(authority, subject)` are a configuration error
rather than a precedence rule. `label` is optional and never read for policy.

`allowed_roots` is **required** on a profile and must be non-empty — it is the
one key with no safe default, since the global `allowed_roots` defaults to
empty and empty is read as permitting anything the account can reach. Every
other key defaults to its narrowest value: `level` defaults to `read` and
excludes `open` (no remote request may disable the sandbox), `min_enforcement`
defaults to `kernel` (the default admits Codex and Claude Code; `tool-policy`
is what admits OpenCode), and `env_allow`/`env_defaults` default to empty.
Where a key appears in both, `env_defaults` wins — a profile that pins a value
and also allows the key means the value it pinned, not the accepting shell's. A
profile written as nothing but a required `allowed_roots` is therefore the
most restrictive profile expressible.

`identities` bounds which named identities (see [Agent
identities](#agent-identities) above) a non-local requester may launch under,
and it also defaults to its narrowest value — empty:

- **Empty or omitted** refuses any identity the request names — the launch
  falls back to lending the operator's own ambient account, same as before
  identities existed.
- **Exactly one** makes that identity the default: a request naming no
  identity gets it anyway, and a request naming it explicitly gets the same
  launch.
- **Several** require the request to choose: a request naming none of them is
  refused rather than guessing, and a request naming one outside the list is
  refused too.

A local requester has no profile and no ceiling here either — it may name any
identity that exists, exactly as it may reach any root.

A request naming no level resolves to its profile's level — never to the
receiving machine's own `config.permissions` / `config.sandbox` defaults,
which would let an unconfigured local default hand a remote caller more than
its profile grants.

**The `env_allow` trap.** A non-local launch's environment is composed from
nothing — an allowlist, not the accepting shell's environment filtered by a
denylist. That means a remote profile must list in `env_allow` (or supply in
`env_defaults`) everything the runtime's own toolchain needs — not just what
the agent's task needs. A missing entry does not present as a policy refusal;
it presents as a **broken runtime** — a launch that starts and then fails in
ways that look like a bug in Codex, Claude Code or OpenCode rather than a
missing environment variable. This is exactly the diagnosis-confusing failure
shape the rest of this feature avoids, so test a first remote profile with a
trivial launch before relying on it.

**`env_allow` is not the whole environment.** Two configured things still
contribute variables read from the accepting process's unfiltered environment,
exactly as for a local launch. A selected MCP server contributes its own declared
`env_vars` and its `bearer_token_env_var`. And on every OpenCode launch, each
configured `[opencode.provider]` contributes its API key, because the provider
configuration handed to the runtime is built from them — so a remote OpenCode
launch reaches this machine's model providers even with `env_allow = []`. That is the same principle applied
one level up: a configured credential authenticates, one that merely happens to
be present does not. It does mean a remote request may not choose which servers
or plugins run: naming `mcp` or `plugin` is refused as not expressible
remotely, and a remote launch gets this machine's configured `default_mcp` and
`default_plugins`. To withhold a credential from a remote requester, withhold
the server — a profile cannot withhold the variable alone. Provider keys cannot
be withheld per requester at all today; a machine that must not lend its model
providers should not enrol a remote requester for OpenCode.

**What this does and does not defend against.** Muster does not authenticate
its caller. A trusted local invoker that has already authenticated a remote
peer passes along the provenance it established, and Muster applies least
privilege to that provenance. This is not a defence against a compromised
same-user process: anything able to exec Muster can already rewrite the very
`config.toml` it reads, including its own enrolment and profile. The value is
in what a legitimately-authenticated remote peer is confined to, not in
resisting an attacker who is already running as the same local user.

**Stop and output are asymmetric.** A local operator may stop or read the
output of any launch on the machine, as before. A non-local requester may
`stop` or read `output` for only the launches it asked for — an attempt to act
on another requester's launch is refused. An entry with no recorded requester
(older data, or a local launch) reads as local and is therefore protected the
same as any other local launch. `list` is not scoped this way: every caller
sees every launch on the machine, so the asymmetry covers acting on a launch,
not seeing that it exists.
