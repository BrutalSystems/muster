# Release notes

Versions before 1.0.0 were released from an earlier repository whose history is
not published. Their notes are kept below because they are the record of how
Muster got here — but npm cannot verify their build provenance any more, since
the commits they were built from no longer exist. Install 1.0.0 or later.

From 1.0.0 this project uses ordinary semver: major for an incompatible
interface or permission-default change, minor for a feature, patch for a fix.
Before 1.0.0 the minor carried the breaking-change signal and features shipped
as patches, so do not read an old entry under the new rule.

## Unreleased

**`--options auto-approve-path`.** A launch option that records the launch
directory as trusted in the profile the agent will use, so Claude's one-time
folder-trust dialog does not stop the launch:

```sh
muster run claude --kind session --cwd ~/Source/thing --options auto-approve-path
```

`--options` names something **Muster** does, which is what separates it from the
pass-through after `--`. The set is closed; an option a runtime cannot express
is refused rather than ignored, so OpenCode — which has no trust gate — rejects
this one instead of accepting it and doing nothing.

**The directory is screened before it is trusted.** Trusting a folder lets its
own `.claude/settings.json` configure the session, hooks included, and hooks run
without asking. A directory shipping hooks or an `.mcp.json` is named and the
launch refuses. Auto-approving without looking would be answering a question
nobody read.

Not expressible remotely, for the same reason `--mcp` is not: it would have the
receiving machine trust a directory a remote caller named.

**Trust is recorded under the git repo root, not the launch directory** — and
the README was wrong about how trust works. Claude Code 2.1.274 has two gates:
the dialog gate walks up from the launch directory but stops at the repo root,
so a trusted `/` does not reach inside a repository; the settings gate, which
decides whether the workspace's `.claude/settings.json` is honoured, tests one
exact key with no walking, and that key is the repo root — the main checkout for
a linked worktree.

Only the repo root satisfies both, so that is what Muster writes, for
`auto-approve-path` and for identity launches alike. The previous behaviour
wrote the launch directory, which silenced the dialog and still left the
workspace untrusted for settings. Claude reports that itself:

```
Ignoring 1 permissions.allow entry from .claude/settings.json: this workspace
has not been trusted ... set projects["<repo root>"].hasTrustDialogAccepted
```

Verified before and after on the same directory and profile: that warning
appears, Muster writes the canonical key, and it is gone.

**This means trusting a subdirectory trusts its whole repository.** Decide on
that basis rather than on the path passed to `--cwd`.

Also observed: a `--kind task` launch does not stop at the dialog, though it
does consult trust for settings.

## 0.11.1 — 2026-09-26

**An unknown config key no longer stops Muster running.** It is reported on
stderr and ignored:

```
[muster] ignoring unknown config key: future_key — written for a different version of muster?
```

The schema refused every key it did not recognise, so a config written for a
newer Muster bricked an older one — adding `terminal` in 0.11.0 made _every_
command on 0.10.0 fail with `unrecognized_keys`, `list` and `stop` included,
which is a poor way to learn you upgraded one machine and not another.

Only unknown top-level keys are tolerated. Values are still validated, because
that is the half that matters: a silently dropped `sandbox = "workspce-write"`
would launch under the default instead of the pair that was written. The nested
policy tables stay strict for the same reason — an unknown key inside a
requester profile is a policy statement that would not apply.

**A flaky test is fixed.** `stop-tree.test.ts` asserted a SIGKILL had already
landed the instant `stopTree` resolved; `stopTree` resolves once it has
_signalled_ the tree, and SIGKILL is asynchronous. It failed about one run in
ten under load — the worst shape for a release gate, since a randomly red
`npm run check` teaches people to re-run rather than look. The test now waits
for the condition, and `stopTree` carries its contract in writing.

**`launch()` is now a sequence of named phases** — authorize, resolve identity,
plan, reserve, prepare environment, build command, start, await readiness —
instead of one 700-line method. No behaviour change: a baseline of real Claude,
Codex and OpenCode launches was captured before any edit, and every phase was
re-verified against it, because the suite runs against fake runtimes and could
not have caught a change to a `canonical_id` shape, which is a Tin Can contract
rather than an implementation detail.

Per-agent branches were deliberately left explicit rather than flattened behind
one interface. "Is there a session I can address yet" is answered by a file on
disk for Claude, a JSON-RPC call for Codex, and an HTTP check plus a
port-ownership test for OpenCode — one question, three unrelated mechanisms.
`AGENT_CAPABILITIES.md`, also new, records the sixteen things Muster must know
about each agent and where each lives today.

Not verified, and worth stating: the readiness FAILURE path. Forcing it with
`launch_timeout_sec = 1` did not work, because Claude registers in under a
second, so the timeout and workspace-trust diagnostics remain covered only by
tests against fakes — where they already were.

**Two more flaky tests fixed, same class as the first.** The codex-lock poll
budgeted attempts rather than seconds, so it did not degrade with the machine;
it now waits on wall clock. And two identity test files inherited Vitest's 5s
default while giving a launch 3s, which is no budget at all for tests that spawn
real processes — `testTimeout` is now 20s and those fixtures allow 10s, leaving
the launch deadline as the binding constraint so a real failure still reports a
launch diagnostic. Raising a budget costs a little sensitivity; a gate that
reddens at random costs more.

## 0.11.0 — 2026-09-26

**The tmux status bar is off by default.** Muster's tmux runs on its own server
(`-L`) with `-f /dev/null`, so the bar a launched agent showed was never the
configured one — it was tmux's stock default — and a Muster session is one
window running one agent, so it reported nothing the caller did not already
know. `tmux_status = "on"` in `config.toml` restores it. Set per session, inside
the same tmux invocation as `new-session`, so it never flashes visible and
sessions already running keep what they had.

**`--open` now names its terminal.** `--open ghostty`, `--open=ghostty`, or a
bare `--open` for the configured default. The real gap this closes is that
`--open` had no configurable default at all: the app was hardcoded to
Terminal.app, so anyone on Ghostty or iTerm2 passed `--terminal` on every launch
with nowhere to state it once. The new **`terminal`** config key is that
default.

`--terminal` still works and is **deprecated, for removal in v2** — in `--help`
and in a notice when it is used, since a deprecation only in help never reaches
anyone scripting against the flag.

**Note for anyone sharing a config file across machines:** `terminal` and
`tmux_status` are new keys, and the config schema refuses keys it does not know.
A config written for this release will fail on 0.10.0 and earlier with
`unrecognized_keys`, so upgrade before adding them.

**One `claudeConfigDir`, not two.** The 0.10.0 sandbox work added a second copy
in `guard.ts` beside the one already in `src/identity/claude.ts`, and they
drifted on the emptiness rule: a blank or whitespace `CLAUDE_CONFIG_DIR` was
read as unset by one and taken literally by the other, so the sandbox could
grant write to one directory while the trust check and session registry looked
in another. Nothing sets a whitespace value today. Now a single definition, with
the absolute form applied only where the sandbox boundary needs it.

**Documentation.** `AGENT_CAPABILITIES.md` is new: the sixteen things Muster has
to know about each of Claude, Codex and OpenCode, and where each lives today.
README now states what the two containment axes _are_ before listing their
values — permissions decides whether the agent stops to ask, the sandbox decides
what it may touch and the kernel enforces that. A permissions refusal is a
prompt the agent can read; a sandbox refusal is `EPERM` with no negotiation,
which is how #80 stayed hidden for so long.

## 0.10.0 — 2026-09-26

**A sandboxed Claude session can write its own memory again.** Under
`--level work` the sandbox now grants the launched agent's `CLAUDE_CONFIG_DIR`
as a write root, so Bash writes to `$CLAUDE_CONFIG_DIR/memory` succeed. They
failed with `EPERM` before: muster named no write roots at all, leaving Claude
Code to default to the cwd plus `$TMPDIR`, and `--setting-sources ""` meant the
profile's own `permissions.additionalDirectories` never loaded either. The
in-process file tools are not kernel-sandboxed and kept working throughout,
which is why this read as a path bug from inside a session rather than as a
boundary (#80).

The dir granted is the one the child will actually open — taken from the
composed agent environment, so an identity launch's per-launch copy or a
requester profile's `env_defaults` override is what gets the grant, not the
directory muster itself runs under.

`--level read` still grants nothing, verified against a real launch: every
probe path including the two memory dirs reports `WRITE-FAIL`. `full-access`
is unchanged, having no sandbox to grant into. `$HOME` stays denied under
`work`, so the boundary still holds where it should.

**`$CLAUDE_CONFIG_DIR/projects/` remains unwritable from Bash, and muster
cannot change that.** Claude Code denies writes there — and to
`shell-snapshots/` — regardless of what muster grants; naming those exact
directories in `allowWrite` was tried and refused, which makes sense given a
session's transcripts live there. So project-scoped memory under
`projects/<cwd-slug>/memory` is reachable only through `Write`/`Edit`, while
`work` implies auto mode, which nudges the model toward Bash. #80's proposed
fix expected this path to start working; it cannot from muster's side.

**A mustered session gets the profile's plugins again.** `--setting-sources ""`
also dropped `enabledPlugins`, so every launch ran with built-in skills only —
16 of them, and none of the machine's own plugin-provided skills. The
profile's `enabledPlugins` and `extraKnownMarketplaces` are now forwarded into
the inline settings blob, taking a mustered session from 0 plugin-scoped skills
to 40 on this machine. Nothing else is forwarded: `permissions`, `sandbox` and
`hooks` stay muster's alone, which is what `--setting-sources ""` is for, and a
profile that sets them is ignored. An absent or malformed `settings.json`
forwards nothing rather than failing the launch.

## 0.9.2 — 2026-09-26

**Re-synced the vendored Tin Can contract to 1.9.2.** No behaviour change:
`naming.ts` is untouched, the fixture keeps all 40 cases with no expected value
moved, and the contract suite stays 4/4 against a real 1.9.2 binary. What moves
is the version label and the normative document.

`CANONICAL_ID.md` now warns against recovering the three-hex suffix by taking a
canonical id's last dot-separated segment. That worked before Tin Can 1.0.0,
when the segment _was_ the suffix, and returns the whole uuid now, so every
qualified `slug.suffix` address resolves as `unknown` — which names a missing
peer rather than a malformed address, and is why the same bug went unnoticed
here until 0.9.1 added the test for it. Tin Can documents Muster as where it
was found. Derive the suffix from the uuid; pass a canonical id along whole
rather than parsing fields out of it.

Both Tin Can pin sites moved together — `RELEASING.md` and
`.github/workflows/publish.yml`. Moving only the first is what left v0.9.0 an
inert tag that published nothing, and the guard added in 0.9.1 was confirmed by
mutation to fail on exactly that mistake before this was committed.

**The contract pin is now derived, not restated.** Both sites compute the Tin
Can version from the frozen fixture's `tincan_version`, which is the single
place recording which Tin Can the vendored copies describe:

```sh
ver=$(node -p "require('./test/fixtures/canonical-id.json').tincan_version")
npm install --prefix "$contract_dir" --no-save "@brutalsystems/tincan@$ver"
```

A pin cannot lag a fixture it is computed from, so the failure that made v0.9.0
an inert tag is now impossible rather than merely detected. `npm run check`
fails if either site hardcodes a version again, and the derived command was run
end to end — it installs 1.9.2 and the contract suite passes 4/4 through it.

This release is the first to exercise that: the 1.7.0 copies were replaced with
1.9.2 mid-branch, and updating the fixture moved the CI pin on its own. No pin
was edited by hand, which is the failure that made v0.9.0 an inert tag having
nothing left to act on.

**The README was a third site, and it was stale.** Its Verification section named
`Tin Can 0.6.4` as the verified baseline and handed out a copy-paste command
pinned to that release, while the vendored copies described 1.6.0 and then 1.9.2.
It gates nothing, so nothing failed — anyone following it simply installed a Tin
Can four minors behind the fixture and watched the contract suite pass, which
reads as confirmation of a contract at a version nobody vendored. It now derives
`ver` from the fixture like the other two sites, and states the baseline by
pointing at `tincan_version` instead of naming a release. `npm run check` covers
it: the guard fails if the README hardcodes a pin again, or names a Tin Can
version in that section's prose.

## 0.9.1 — 2026-09-24

**Tin Can 1.6.0 addresses. `canonical_id` now carries the whole durable id, so
this is a breaking interface change** — hence the minor bump rather than the
patch everything else in 0.8.x got.

```
before   codex:auth-refactor.7f3
after    codex:auth-refactor.00000000-0000-0000-0000-0000000007f3
```

Anything that stored, parsed or compared a Muster `canonical_id` must be
re-read. The short forms are untouched: `display` is still the bare slug,
suffixed only on collision, and the qualified form is still `slug.<3 hex>`.

**Why it had to move.** The old form was not unique. Two peers whose slugs
matched _and_ whose ids shared their last three hex characters produced the
same `canonical_id`, and resolution then refused both — telling the caller to
disambiguate with a string that did not disambiguate. Both were unaddressable
until one exited.

**Addresses may now end in `@<machine>`**, absent for a peer on this machine, so
every address in use today keeps working and keeps meaning the same thing.
Collisions are counted per machine, and resolution gates on `@` before matching
anything: without that gate a local-looking address could fall through and
resolve to a session on another computer once the local one exited — a message
meant for a peer at this desk, delivered elsewhere, reported as sent.

**A qualified `slug.suffix` address resolves again.** `find()` rebuilt the
suffix by taking the last dot-separated segment of the stored canonical id. On
a 1.x id that segment is the whole uuid, so every qualified address stopped
resolving, and it failed as "unknown" rather than as anything that named the
cause. It now derives from the durable id, with a test.

**The contract suite is verified against Tin Can 1.x for the first time.**
`RELEASING.md` pinned it to 0.6.4, so it passed 4/4 while never having been run
against any 1.x. Measured before and after: against 1.5.1 it went 0/4 to 4/4,
and against 0.6.4 it now fails 4/4 — the mirror image, which is what a genuine
format change looks like. Muster no longer interoperates with Tin Can 0.x.

Contract copies re-synced from Tin Can `v1.5.1`
(`b62ca6a719131dbd1b43875fa47604c1c17cd9fb`), ending a freeze at 0.1.0 vintage;
`CONTRACT_PROVENANCE.md` records the acquisition, the hashes, and why the tag
rather than HEAD.

**Known defect inherited deliberately.** A full name that is a prefix of a
longer full name resolves to the longer one once the exactly-named session has
gone — `muster` lands on `muster-b1`. Muster reported this upstream and Tin Can
confirmed it as
[tincan#39](https://github.com/BrutalSystems/tincan/issues/39), choosing to
document rather than change it: no rule separates it from the fixture case that
freezes `auth` resolving to `auth-refactor`, and an implementation of the
stricter rule failed both. Muster reimplements resolution and so inherits it by
construction. `canonical_id` is the form that cannot misroute — resolution
matches it exactly and never by prefix — so prefer it wherever a durable id is
already in hand.

**Adopted at Tin Can 1.6.0, not 1.5.1.** 1.6.0 landed while this release was
being fixed, and it labels the fixture for the release that contains it — so
the acquisition point and the version metadata agree and the provenance
compromise 1.5.1 forced is gone. The fixture gains one additive resolve case
(39 → 40) freezing the prefix defect above; no expected value changed, and
`naming.ts` passes it unchanged.

That case was verified to have teeth rather than assumed to: implementing the
stricter rule it documents — refuse a prefix ending at a segment boundary —
fails the new case _and_ `resolve: unambiguous prefix resolves` together. That
pair failing together is the argument for documenting the defect instead of
changing resolution, and it reproduces in this copy.

**The Tin Can pin is now tested for agreement, because a half-bump cost a
release.** `v0.9.0` was tagged and never published: `RELEASING.md` had been
moved off 0.6.4 and `.github/workflows/publish.yml` had not, so the contract
step failed after the tag was already pushed — the expensive place to find it.
The npm pin already had a test for exactly this shape of drift; the Tin Can pin
did not. It does now, along with a second guard that the pinned version matches
the `tincan_version` of the fixture actually vendored, so a pin cannot claim
verification against a contract that was never copied. `v0.9.0` remains as an
inert tag with nothing behind it.

## 0.8.3 — 2026-09-24

**The registry-timeout message stops naming a screen nobody has demonstrated.**
0.8.2 told a reader whose directory was already trusted to look for "the
one-time confirmation Claude asks the first time a profile uses
bypass-permissions mode". That was a plausible account of one report, not a
measured fact: no profile on this machine carries a key for it, the way they
all carry `hasSeenAutoModeEntryWarning` and its siblings. Sending someone after
a screen that may not exist costs what the vague message cost. It now says the
directory is trusted and the session is stopped on something else — a login
prompt or another one-time confirmation — and leaves it there. Trust stays
named, because trust is the one Muster can actually check.

**`--identity` replaces an inherited account rather than hardening it.** A
shell whose `CLAUDE_CONFIG_DIR` already selects an account hands it to a launch
with no flag at all — `launchEnv` blocks the variables that would confuse a
child and lets that one through deliberately. Passing `--identity` there points
the runtime at a copy of a _different_ account, so the session quietly appears
under one you did not mean to use. The right answer for profile work is no
`--identity`, which is counter-intuitive enough that nothing having said it was
a documentation defect.

## 0.8.2 — 2026-09-24

**A Claude launch that times out with nothing registered now names workspace
trust, or rules it out.** A session stopped at the workspace-trust dialog never
writes a registry record, so the launch failed with the same
`no Claude session registry found (check terminal for workspace trust or login
prompts)` as a hung or crashed one — a message that listed two unrelated
consent screens and committed to neither. Trust is the one Muster can check, so
it now does: on that failure path only, it reads `hasTrustDialogAccepted` for
the working directory out of the profile's `.claude.json` and either names the
untrusted directory with the one-time `cd <dir> && claude` fix, or says the
directory is trusted and points at what is left — a login prompt, or the
confirmation Claude asks the first time a profile uses bypass-permissions mode.

**`--level work` is documented as what it measurably is.** A sibling session
reported that the write fence was asymmetric between Bash and the Write tool,
and could not establish which of three causes was responsible.
`probes/write-fence.mjs` settles it: at `work` the Write tool creates files
outside the working tree that the same agent's Bash then cannot delete, and the
alternative permissions value blocks Write everywhere rather than by path. The
Write tool's path scope is not governed by the sandbox, so no setting Muster
writes closes the gap — the README and PROBE_RESULTS now say so plainly rather
than leaving `work` to read as though writes were confined. No behaviour
changed here; the claim did.

The trust read only ever reads: Muster still never accepts a trust dialog on the
operator's behalf, and `setWorkspaceTrust` still writes that flag only into an
identity copy Muster itself created. It is deliberately not a pre-launch
refusal — `--kind task` runs headless and never sees the dialog, so failing
closed up front would break task launches that work today. The message also
states that trust is per-directory and not inherited, which is the part that
costs the most time to work out by hand.

## 0.8.1 — 2026-09-24

Follow-ups to the session lifecycle in 0.8.0, all of them cases where the
feature told the truth badly or honoured a limit loosely.

**A session whose reaper could not be armed no longer reports an idle timeout.**
Arming failure never fails the launch — the session is up and usable — but the
record used to keep advertising an expiry that nothing would honour, and
nothing outside could tell the difference. It now reports none, which is true.

**A `#` in a path no longer corrupts the armed command.** tmux expands a
`run-shell` command as a _format_ before any shell sees it, so a `#{...}` in a
home or node path was silently replaced and POSIX quoting could not prevent it.

**A short limit is now honoured rather than rounded up.** The poll floor drops
from 30s to 5s, so `--ttl 45s` fires near 45s instead of up to 75s. A session
with a limit that short does not live long enough for the extra polls to cost
anything.

**A bad `[session] idle_timeout` names itself.** It used to report
`--idle-timeout must be a duration like …`, sending the reader after a flag they
never typed.

Also: a duration unit is case-insensitive, as `off` already was (`30M` works);
the tmux host names its own socket rather than having the launch path reach in
with a structural cast; and the human renderer's duration helper moved out of
the per-record path.

**Measured, replacing an assumption.** 0.8.0 shipped with a stated residual
risk: a runtime whose TUI does not redraw while thinking would look idle.
Sampling `window_activity` against the wall clock on an isolated socket, claude
holds `idle = 0s` for an entire 51s turn and opencode `idle = 0–1s` through
generation; both render a live elapsed-time counter, and both freeze exactly
when the turn ends. So a working agent is not idle by this measure, for those
two. **codex is still unverified** — the account hit its usage limit before a
turn could run — and it should be treated as unknown rather than safe. The
attempt did show a codex session sitting indefinitely at an interactive
usage-limit prompt with no pane output at all, which is the silent-at-a-prompt
case the 30m default exists to tolerate.

## 0.8.0 — 2026-09-24

**A launched tmux session is now stopped after 30 minutes with no pane
activity.** This is a change of default behaviour, which is why this is a minor
rather than a patch: a session you leave idle for half an hour will be gone
where it previously persisted. `--idle-timeout off`, or `[session] idle_timeout
= "off"` in `config.toml`, restores exactly the old behaviour.

The reason for a default rather than an opt-in flag: sessions launched
programmatically survive their parent by design, live on a private tmux socket
with no attached client, and leave no window anywhere, so nobody is reminded
they exist. Every orphan found while building this came from tooling that would
never have passed a flag.

`--idle-timeout DURATION` and `--ttl DURATION` set it per launch, as `90s`,
`30m`, `4h`, or `off`; `[session] idle_timeout` and `[session] ttl` set the
default for every launch. A flag beats config, config beats the built-in
default. `--ttl` is a hard ceiling regardless of activity — the backstop for a
session that looks busy only because something is looping in it — and is off
unless asked for.

**A session with a client attached is never stopped**, however idle it looks. A
person reading a pane produces no activity.

The limit applies to tmux sessions only. pty and macos-terminal sessions die
with the process that launched them, and a task ends when its prompt does;
naming either flag there is refused rather than silently ignored, while a
configured default simply does not apply.

Enforcement runs inside tmux itself, as a self-rearming delayed job, so nothing
of Muster's is left running between checks and a session's lifecycle survives
every Muster process exiting. Idleness is measured from the window's activity
rather than the session's: `session_activity` does not advance for a detached
session, and every Muster session is detached.

## 0.7.21 — 2026-09-24

A session launch now reports its model the way its listing already did. `run`
and `list` build separate records, and only the listing carried `model` and
`model_source` for a session, so one launch described itself two ways depending
on which command you asked. Both carry it now.

`--format human` says where a model came from — `Model: opus (requested)` or
`Model: local/qwen (configured default)`. Pinned by the caller and fell back to
the configured default are the distinction the field exists to draw, and the
listing was not drawing it.

`launchArgs` resolves the model before it walks the runtime options, so it
reports a model named twice rather than whichever refused option happened to
come first in the list. No caller inside Muster could reach the old order;
`launchArgs` is exported, so the invariant now holds in the function instead of
in its callers.

## 0.7.20 — 2026-09-24

`--model` now selects the model for every runtime, not only OpenCode. claude and
codex take a bare model id and receive it on the child's argv; OpenCode is
unchanged and keeps taking `PROVIDER/MODEL` through its config overlay. A
slashed value handed to claude or codex is refused at the boundary rather than
passed down to fail in the child. Naming a model both as `--model` and inside
the `--` runtime options is refused instead of silently preferring one.

A run now records the model Muster resolved for it, and `list` reports it as
`model` with a `model_source` of `request` or `config`. The recorded value is
what Muster determined and passed, never what the child said about itself — an
audit asking which model produced a packet should not have to trust the packet's
author. A launch that named no model records an explicit `null`, which says the
child chose its own default; a run from before this release has no field at all.

`run` and `list` now also name the `identity` a launch ran under. The registry
has always recorded it; the projection dropped it, so reading `registry.json` by
hand was the only way to tell which account a session was running as. A launch
with no identity omits the field rather than reporting null — it ran on the
ambient environment, and that is the whole answer. The per-launch `identityPath`
and `configHome` stay unpublished: they name a directory deleted when the launch
ends.

## 0.7.19 — 2026-09-24

### Fixed

- A login you interrupt is no longer reported as a missing `claude`. The
  non-zero-exit path told you to check that `claude` is on PATH whichever way
  it ended, because the two are genuinely hard to tell apart: node-pty does not
  throw for a missing executable, it exits 1 having emitted nothing, which is
  the same exit shape as a login that failed or that you aborted. What
  separates them is whether anything was ever printed, so that is what is now
  checked. A login that ran says so and points at its own output; one that
  never started says it printed nothing and names PATH.
- `--token-env` against a codex or opencode identity is refused as what it is —
  a flag that applies only to Claude — instead of being explained as one of two
  credential routes to choose between. That description is Claude's behaviour;
  for the other agents `--interactive` captures nothing and `--token-env` does
  not apply at all.
- `--token-env ""` is refused rather than ignored. An empty value is falsy, so
  it slipped past the checks that asked whether one had been given and was then
  dropped, leaving the identity on neither credential route without saying so.

## 0.7.18 — 2026-09-24

### Fixed

- `muster setup-identity --interactive` asks for what you did not give it,
  instead of refusing. `--interactive` said the login would run here, so typing
  exactly that was the natural thing to do — and it was answered with
  "setup-identity requires --identity and --agent", because the two flags were
  still required. It now asks for the name and the agent, validates each
  against the same rules the store applies, and asks again rather than failing
  on a typo, giving up after three tries. Anything you did pass as a flag is
  used and not asked about, so a scripted invocation is unchanged. Without
  `--interactive` the command is still the unattended route and still requires
  both flags; with `--interactive` but no terminal it says there is nobody to
  ask, which is a different problem from a forgotten flag.

### Changed

- `--help` is two levels instead of one wall. The top level is a synopsis, an
  aligned command table and the few global options; each command now answers
  `muster <command> --help` with its own flags, its rules and an example or
  two. The old help was a reference manual in a help string — a 140-column
  usage line that wrapped at any ordinary width, then forty lines of unbroken
  prose about flags, with nothing to tell you which command a paragraph
  belonged to. `muster setup-identity --help` used to answer "Unknown option
  '--help'", because the flag reached a strict parser that had no such option;
  a help request is now recognised before parsing. No line of any help output
  exceeds eighty columns, and a test fails if one does, or if a command is
  dispatched without an entry in the table.

  The prose that left the help string moved to the README rather than being
  dropped — `--no-plugin` was documented nowhere else and is now written down.
  One paragraph stayed: that Muster's MCP server is installed deliberately in
  the one authorized session and never at user scope. That is a statement about
  who gets launch authority, and it is only load-bearing at the moment someone
  is about to install.

## 0.7.17 — 2026-09-24

### Fixed

- Typing `muster` at a terminal no longer looks like a hang. With no arguments
  Muster starts the MCP server — a documented entry point, and how a client
  configured with `command: "muster"` reaches it — but a server waiting for
  JSON-RPC on stdin prints nothing, so a person who typed the bare command got
  a cursor and no explanation. The server is now reached by a pipe, which is
  what every MCP client provides and what a terminal never is; at a terminal
  the command prints its usage text and a short status — which identities exist
  and what state each is in, how many sessions the registry has recorded, and
  that `muster mcp` is the server. `muster mcp` still starts the server whether
  or not it has a terminal, so it can be driven by hand to debug it, and no MCP
  client sees any change.

  The session count is read straight from the registry rather than through
  `list`: a `list` refreshes each entry, which also removes a terminal entry's
  identity copy and reaches an OpenCode session over HTTP. Neither belongs in
  the output of typing a bare command, so the count is what was recorded and
  the line says so.

## 0.7.16 — 2026-09-24

### Added

- `muster setup-identity --interactive` runs the agent's login itself and stores
  what comes back. For Claude it drives `claude setup-token`, captures the token
  from the output, and prints a redacted confirmation rather than the token — so
  a year-long credential no longer travels through the terminal scrollback and a
  shell rc file. Your terminal is attached both ways, so anything the login asks
  you — the `Paste code here if prompted:` fallback an ssh session gets, say —
  reaches it from your keyboard; your terminal's mode is restored on every way
  out — normal exit, an error, Ctrl-C, or a `kill` from another window — short
  of a `SIGKILL`, which nothing can catch. It needs a terminal and refuses when
  stdin is not one, and it cannot be combined with `--token-env`: they are the
  two mutually exclusive credential routes, so passing both is refused rather
  than ranked. If the login's output format ever changes, nothing is redacted
  and nothing is captured: the token appears exactly as it does today, and the
  command says it could not store one and points you at `--token-env` to record
  the token now on your screen — re-running `--interactive` would mint a
  different one. A login that exits non-zero stores nothing and fails with that
  identity's name, its own output standing as the error. The relayed login is
  rendered at 1000 columns rather than the real terminal's — load-bearing, so a
  token can never be wrapped across a line break and split in two where the
  filter can't see it — so the view wraps oddly in a normal 80-120 column
  terminal; that's expected, not a bug.

- `MUSTER_TMUX_SERVER` names the tmux server a launch lands on, for a caller
  that must not share the machine's dedicated `muster` server. Unset, nothing
  changes: there is still one Muster tmux server per machine.

### Fixed

- A Claude identity's reported state no longer depends on which shell asks.
  `muster identities` computed it from the ambient environment, so the same
  identity read as `configured` in the shell that exported its token variable and
  `not-configured` everywhere else. An identity now holds its own credential, and
  `--token-env` remains available for machines that should keep none at rest.

- `npm run check` no longer leaves its launches on the developer's tmux server.
  The suite created its Muster instances without overriding the drivers, so it
  went through `hosts()` and landed on `muster` — the server real launches use —
  and `close()` stops only `pty` entries, deliberately, because a tmux launch is
  documented to survive its parent exiting. Nothing was misbehaving and nothing
  would ever reap the result: 40-50 live sessions and 300-plus temp directories
  per run, accumulating on the one server a developer actually reads. It had
  become blocking rather than untidy — 950 sessions in a day exhausted the pty
  table (`kern.tty.ptmx_max` is 511) and unrelated suites then failed with
  `posix_spawnp failed`, which reads as a broken working tree rather than as a
  full tmux server, and cost a diagnostic detour every time. The suite now names
  a tmux server and a temp root of its own per run and reaps both when it ends.
  Measured across a full run: zero sessions added to `-L muster`, zero entries
  added to `$TMPDIR`, and a session of your own on that server survives
  untouched — where the same run without the fix left 21 behind.

## 0.7.15 — 2026-09-23

### Fixed

- A Codex launch under an identity reaches a session instead of dying at its
  deadline. Codex gates on its own directory trust — without a
  `[projects."<dir>"] trust_level = "trusted"` entry in the `config.toml` it
  reads, it stops on "Do you trust the contents of this directory?" before
  opening a thread, so no thread-writer lock is ever written and nothing is
  discoverable. A fresh identity copy trusted nothing, which made every Codex
  identity launch fail this way and report `no descendant runtime identity found
after 30s`. The entry is now written into that launch's own copy, keyed by the
  resolved path Codex looks itself up by; the user's real `~/.codex/config.toml`
  is untouched, as with Claude.

## 0.7.14 — 2026-09-23

### Added

- `--level read|work|open` names a legal permissions and sandbox pair. The
  existing `--permissions` and `--sandbox` flags are unchanged; naming both a
  level and a flag is an error rather than a precedence rule.
- Every launch records an `enforcement` grade — `kernel`, `tool-policy` or
  `none` — so what kind of containment surrounded a session is answerable
  afterwards instead of inferred from the runtime name.
- `[requester_profiles.<name>]` and `[[requesters]]` in `config.toml` describe
  what a non-local requester may do here: which roots, which containment level,
  and the weakest enforcement grade acceptable. A remote requester with no
  enrolment is refused.
- A non-local launch receives an environment composed from an allowlist rather
  than the accepting shell's environment filtered by a denylist. A configured
  MCP server still contributes its own declared variables, so a remote request
  may not select `mcp` or `plugin`: the receiver's configured defaults apply,
  and withholding a credential means withholding the server.
- Named agent identities. `muster setup-identity --identity NAME --agent AGENT`
  creates a template configuration under `~/.muster/identities`, prints the
  one-time login for that agent, and reports whether a credential is
  configured. `muster identities` lists them. `muster run <agent> --identity
NAME` launches under one, copying the identity's configuration per launch so
  a launch states which account it runs as instead of inheriting whatever the
  environment implied.
- A Claude launch under an identity marks its working directory trusted inside
  that launch's own copy, so a fresh directory starts as a session without
  anyone accepting a dialog. The live `~/.claude.json` is never written.
- `identities` on a requester profile bounds which identities a non-local
  requester may use. Empty refuses any; one makes it the default; several
  require the request to choose.
- The MCP `run` tool now advertises `identity`, `model` and `plugin`. Its schema
  rejects properties it does not list, so an MCP client was previously told
  these were invalid rather than merely undocumented.

### Changed

- The launch log's `requester` field is now an object rather than the strings
  `cli` and `mcp:<client>`. Non-local launches log metadata only — no
  instruction text and no environment values — and `launches.jsonl` now rotates
  at 8 MiB, keeping one previous generation.
- Request keys are scoped to their requester, so two callers choosing the same
  key get two launches rather than one deduplicated into the other.
- A non-local requester may stop or read output for only the launches it asked
  for. A local operator may act on any launch on the machine, as before.
- Request keys now hash the identity a launch resolved to, so reusing a key
  with a different identity is refused rather than silently returning the
  launch running under the other account. The fingerprint is a positional hash,
  so a request key recorded by an earlier version now raises
  `IdempotencyKeyReuse` rather than deduplicating — the safe direction, but it
  means a caller replaying a pre-upgrade key must rotate it.
- Claude session discovery now follows `CLAUDE_CONFIG_DIR` when it is set,
  rather than refusing it outright. An identity launch relocates that
  variable to its own copy, and discovery has to follow it there to find the
  session. Launching without `--identity` is unaffected: no config-home
  variable is set, so discovery falls back to `~/.claude` exactly as before.

### Fixed

- A `project` named through the MCP `run` tool is resolved instead of being
  refused as "use project or cwd, not both". The MCP path validated the request
  before handing it over, and the schema's `cwd` default then looked like a
  caller-supplied directory.
- `muster setup-identity --token-env VAR` now records the variable on an identity
  that already exists, instead of accepting the flag and ignoring it. This was the
  only route to making a Claude identity launchable, so the refusal that names the
  flag pointed at a command that did nothing. Re-running without `--token-env`
  still leaves a recorded one untouched, and re-running with a different `--agent`
  is still refused.

Local launches are unchanged: same environment, same permissions, same full
logging.

## 0.7.12 — 2026-09-22

A worker that outlives its own parent no longer drops out of the session it
belongs to. Process-tree membership came from the parent chain alone, and that
chain stops holding the moment an intermediate process exits: its children
reparent to launchd and are no longer reachable from the launched root, though
they are still running the session's work. Measured on a three-deep tree, the
survivors leave the set the instant their parent dies — there is no delay and no
grace period.

Both consequences were real. A stop could not reach those processes, so they
outlived the session as orphans holding whatever it held. And with the root gone
and no recorded descendant alive, the registry concluded the session had exited
while the agent was still working — which also meant `muster list` reported it
as ended.

A process group survives reparenting, because reparenting changes no process's
group. Muster now records the group its launched root leads and takes the union
of the two signals: a stop reaches the strays, and a group that is still busy
keeps the session reported as running.

Only a group the root _leads_ is trusted. A process that merely belongs to
someone else's group shares it with whatever else is there — a shell, a tmux
pane, the terminal — so the signal is used only where the group exists because
this launch created it. Both terminal hosts start their root in a new session,
so in practice it does lead its own group.

A process that calls `setsid()` for itself still escapes both signals. Nothing
on macOS prevents that, and the union of two imperfect signals is the ceiling
the platform offers.

## 0.7.11 — 2026-09-22

A launch whose outcome cannot be established now says so. If Muster died between
starting a process and recording it, the entry became `failed` — which reads as
"nothing is running, safe to retry", and retrying it is how a second agent
appears in the same directory. Entries are now marked as about to spawn, which
separates the two halves of that window: an owner that died before the mark
provably never reached a spawn and is still `failed`, while one that died after
it is `unknown`, records when it became so, and reports that a session may be
running untracked. A repeat under the same request key is refused rather than
answered, and human output no longer paints it like an ordinary ended session.
Resolving an `unknown` entry is manual — look for the session, stop it if it is
there, and launch again under a new key.

A launch can now be confined to configured directories. `allowed_roots` and a
`[projects]` table in `config.toml` narrow what `cwd` may be, and a launch
outside all of them is refused; `--project NAME` (MCP: `project`) launches in a
named one instead of naming a path, and naming both a project and a directory is
an error rather than a precedence rule. A project name also travels between
machines in a way an absolute path does not. The check resolves symlinks before
comparing, so a link inside an allowed root that points elsewhere does not
escape it, and compares path-relatively, so `/work/project-other` is not treated
as part of `/work/project`. Configuring neither permits any directory the
account can read, exactly as before — now stated in the README as a choice
rather than left as an accident.

Neither setting constrains what a launched agent can subsequently reach. They
govern where a session starts; permission modes and the sandbox settings are
what limit it afterwards.

## 0.7.10 — 2026-09-22

A launch request can now carry its own identity. `--request-key KEY` (MCP:
`requestKey`) names the request rather than the session it produces, and sending
the same key again returns the launch it already produced instead of starting a
second agent in the same directory. Until now nothing connected a request to its
result: a retried call, a caller-side timeout that was really a success, and a
double-click each launched again.

The key is bound to a fingerprint of the parameters it was first seen with — the
runtime, kind, resolved working directory, instruction, effective permissions,
selected MCP servers and plugins, and model. The same key offered with any of
those changed is refused rather than answered with a session that does something
other than what was asked; launching something different means using a different
key. The fingerprint is computed after validation rather than accepted from the
caller, because two machines canonicalize a path differently and one computed
earlier would disagree with itself.

What a repeat returns depends on what the first attempt did: a reachable session
or running task comes back unchanged, a launch still in flight is refused rather
than answered with a result that does not exist yet, and one that failed, exited
or stopped is refused with the outcome that was recorded. A repeat never
consumes launch capacity, including when the concurrency cap is full of the very
launch being asked about — checking capacity before identity would reject the
retry of a launch that succeeded, which reads as a failure and invites a third
attempt.

The deduplication lives inside the transaction that already serializes
reservations, so there is no second store to keep consistent and no receipt file
to reconcile: the registry entry is the receipt.

Omitting the key leaves every path exactly as it was.

## 0.7.9 — 2026-09-22

A stop no longer leaves behind a process the tree forked while it was being
stopped. `stopTree` enumerated the process tree once, before the wait between
SIGTERM and SIGKILL, and then signalled that list — so anything spawned during
the wait was never in it and survived as an orphan, holding whatever the session
held. A process being asked to terminate is exactly the kind that spawns one
last child. Membership is now re-read after the wait and unioned with what was
already known, newly found processes get their own termination signal before the
kill pass, and every entry is still revalidated immediately before each signal,
because a pid that exits between discovery and the signal may already belong to
something else.

The reasoning behind process ownership on macOS is now written down, in the
README and beside the code it governs. Pairing a pid with its start time is the
strongest check this platform offers a supervisor rather than a shortcut around
a better one: there is no cgroup to own a tree, the kernel's unique process
identifier is not in the public SDK, and audit tokens require a message from the
target that arbitrary children never send. Two properties that read as wasted
work now say why they are not — identity is revalidated at the moment of use
rather than at discovery, and that revalidation survives Muster's own restart,
which is why a session that ended while Muster was not running is reported as
ended rather than as running.

One limit is recorded rather than left implicit: process-tree membership comes
from the parent chain, and a child reparented after its own parent exits leaves
that chain and cannot be recovered from it.

## 0.7.8 — 2026-09-22

A tmux launch no longer depends on the environment having a locale. tmux
rewrites every control character in `-F` output to an underscore when it runs
with `LANG`, `LC_ALL` and `LC_CTYPE` all unset, so the tab-delimited window
format came back as `@0_11657`, nothing parsed, and every launch failed with
"tmux returned an invalid window identity". An interactive shell exports a
locale and a bare `ssh host cmd`, a launchd job and an agent harness do not —
which is why this reached users running Muster under an agent and never showed
up in a terminal. The formats now use a printable delimiter, which tmux passes
through untouched; the one free-text field is read last so nothing depends on
tmux's discretion about any character.

The error that reports a window row it cannot parse now quotes the bytes tmux
actually returned, bounded. The bare message was the reason the above was filed
as a hardware and tmux-version defect rather than diagnosed.

A Codex launch that cannot succeed now says why. `resolveCodex` screened
candidate writer locks only when there were two or more, so a launch whose sole
descendant thread was unmessageable returned that thread as its identity, and
the reason it could not be used surfaced late enough to land past the launch
deadline — where the loop discards it and reports whichever earlier step was
reached first. `source is exec` became "no descendant runtime identity found".
Every candidate is now screened, and the reason is raised where the deadline
can still keep it. Retries are unchanged: a later pass can still find a
messageable thread.

## 0.7.7 — 2026-09-22

`npm run check` is the local gate, and CI runs the same script. `npm test`
builds and runs the suite but never packs, so tarball drift was green locally
and red on push — CI gated on a check no local command performed. Both now call
`scripts/check-tarball.mjs`, so the two cannot disagree about what "verified"
means. What it is not is recorded with it: CI also runs the suite across the
Node matrix, and the contract suite runs only on release, so passing `check` is
necessary rather than sufficient.

Documentation: `docs/ci-cd-standard.md` is rebuilt from the best of the three
copies that carry it, after review with the sessions working on the other two.
Muster's was the thinnest at 180 lines and gains the numbered pipeline order,
the tarball-verification rationale, the npm version floor and the release loop.
It keeps its own fork-guard heading: a sentence about the fork guard buried in
another section is where a duplicated paragraph hid in one copy for months.

The file no longer claims the three copies are identical. The repos are
independent, so the copies will diverge, and a document asserting otherwise
ages into a falsehood — which is what happened to the sentence this replaces
and to the notes that tracked it. What replaces the claim: anything true of
only one repo is marked `> **Repository-specific, <repo>.**`, and statements
describe the past or the standard rather than what is in flight elsewhere. A
dated fact ages legibly; a standing claim rots.

`test/ci-standard.test.ts` checks this repo's own copy — no sibling is read,
so nothing here can fail because another repo moved. It catches the mechanical
drift that actually occurred: two-repo wording left behind, and repo-specific
facts written as prose a reader cannot tell from shared standard. It caught one
of each on its first run, both of them mine.

The publish workflow installs Tin Can 0.6.4 for the contract suite. It still
installed 0.5.2, the baseline `CONTRACT_PROVENANCE.md` superseded on
2026-09-20, so the release verified against a different Tin Can than
RELEASING.md names. Tin Can remains a test prerequisite installed ad hoc and
never a dependency: it is absent from every dependency list, the contract suite
skips unless `MUSTER_CONTRACT=1`, and the naming fixture it checks is a frozen
local copy rather than something fetched.

The npm that packs the release tarball is pinned, and the packing moved out of
the engines-floor matrix into its own job. `ci.yml` verified the tarball with
whatever npm each matrix Node bundled while `publish.yml` packed what ships
under `npm@latest`, so the two jobs ran the same `verify-tarball.mjs` against
different tools and "verified" in one did not describe the other. Tin Can hit
this for real (tincan#15): one commit packed differently under npm 10 and npm 12. Both workflows now declare the same `NPM_VERSION` and install it before
`npm ci`, a test fails the build if the two ever disagree, and the floor matrix
is left unpinned so it still exercises the npm a Node 22 user actually has.

Documentation: the README named `.opencode/plugin` as the project-local plugin
directory OpenCode merges into a non-empty plugin list. It globs
`.opencode/plugins` too, so a reader auditing a repository before selecting
plugins for it was told to check one of the two places a repository can ship
them. Verified on opencode 1.18.32.

Documentation: `docs/ci-cd-standard.md` covers three repositories rather than
two, and records that a trusted publisher cannot be registered before a package
exists — `npm trust` on an unpublished name answers E404, so the name has to be
claimed with a throwaway `0.0.0` and every version anyone installs left to CI.
Publishing the real first version by hand would otherwise make its release tag a
green no-op. Reported as #16.

`RELEASING.md` names Tin Can 0.6.4 as the contract baseline. It still said
0.5.2, which `CONTRACT_PROVENANCE.md` superseded on 2026-09-20, so following the
release steps literally verified against a withdrawn baseline.

## 0.7.6 — 2026-09-21

Codex identity resolution no longer misses a writer lock whose holder appeared
while `lsof` was running. The descendant snapshot the lock owners are matched
against was taken before that call rather than after, so a process that spawned
during discovery was absent from the set and the launch had to spend a whole
poll cycle before trying again. Under the default 30s launch timeout that retry
was invisible; under a short `launch_timeout_sec` it could consume the budget
and report `no descendant runtime identity found` instead of the real reason
the session was rejected.

A plugin configured with neither `path` nor `npm` now says so. The schema
carried a refinement naming both keys, but the union rejects such an object
before any refinement runs, so the message never reached anyone and a
`[plugins.foo]` section with no keys reported only "Invalid input".

Documentation: the README no longer claims an npm specifier "has no copy to go
stale". OpenCode resolves a specifier once and caches it under the range it was
asked for, so an unpinned plugin keeps running the version it first resolved.
The cache path, the command that clears it, and pinning a version in the
specifier are all recorded now. Reported as #18.

New: `muster doctor` checks path-configured plugins against the packages they
came from. A copied plugin file goes stale in silence — the package moves, the
copy does not, and the stale copy keeps writing records that look current, so
nothing downstream can tell. The copy carries no version of its own, so doctor
compares its mtime against the registry's publish time for the current release:
a file re-copied recently reads as current even when old, which keeps it from
crying wolf. It exits 1 when anything is stale, reports an unreachable registry
as such rather than failing, and skips `npm`-named plugins, which keep no copy
of their own. Muster knows the packages for the plugins it ships with; a
`published` key names any other. Reported as #17.

## 0.7.5 — 2026-09-20

A pty launch now repairs node-pty's macOS `spawn-helper` if its executable bit
is missing, instead of failing with `posix_spawnp failed`. The bit is normally
set by `scripts/prepare-pty.mjs` at install time, but that runs only when
install scripts are permitted — a global install that skips them leaves the pty
host broken while tmux launches keep working, so the breakage stays invisible
until someone uses that host, and the error names neither the file nor the
permission. If the repair itself fails, the error now says which file and what
to do.

Documentation: RELEASING.md records the versioning convention already in
practice. While Muster is `0.x` the minor marks a breaking change and
everything else, features included, ships as a patch.

## 0.7.4 — 2026-09-20

Codex tasks that select an MCP server no longer die before starting. A task
launch passes `--ignore-user-config`, so the user's MCP servers are not loaded,
but Muster still emitted `-c mcp_servers.<name>.enabled=false` for each one it
had enumerated. Setting a key on a server that no longer exists creates it,
leaving an entry with neither `command` nor `url`, and Codex refuses the whole
config with `invalid transport`. This affected every Codex task selecting an
MCP server on any machine whose Codex config defines one; the two flags are
harmless individually and only break together. Verification moved with the fix:
`codex mcp list` rejects `--ignore-user-config`, so for tasks the check is now
that every requested server is present rather than that nothing else is.

A plugin can now be named by npm specifier as well as by path:

```toml
[plugins.tincan]
npm = "@brutalsystems/tincan-opencode"
```

A path still becomes a file URL; a specifier passes through for OpenCode to
resolve and install. Prefer the specifier where a plugin is published — a
copied file goes stale in silence, and a specifier has no copy to go stale. A
specifier does require the package to declare an entry point OpenCode's loader
reads: it looks for `exports["./server"]` and falls back to `main`, and ignores
`exports["."]`. A package declaring only the latter is fetched and never
executed, with nothing logged.

The Tin Can contract baseline moves to 0.6.4, verified against a real installed
package with every pre-existing fixture case unchanged. Do not pin 0.6.3: its
publish run put the server on the registry and skipped the plugin, so the two
halves are not both present at that version.

Documentation. A four-agent worked example lives in
`docs/example/four-agent-wordcount/` — three OpenCode agents and one Codex
agent build a pipeline together, one stage each, with an integrator that waits
for their reports and runs the suite. It is documented as run rather than as
designed, including the traps: Muster's session name and the name Tin Can
addresses a peer by are different strings, and a green test suite is not proof
the protocol worked.

Registering Muster itself as an MCP server is now called out where
`[mcp_servers]` is taught, not only where installing Muster into a runtime's
shared configuration is discussed. A definition running `muster mcp` grants
launch authority to whatever selects it, and via `default_mcp` that reaches
every launched session.

An OpenCode behaviour worth knowing if you deliver to a session yourself rather
than through Tin Can is recorded in `CONTRACT_PROVENANCE.md`: a message posted
to the v2 prompt endpoint of a TUI-hosted session is admitted and then dies
silently. What was established, what was not, and why it was not filed upstream
are all set down there.

Internal: Vitest is now configured to look only at `test/`, so sample code
shipped in `docs/` cannot break the suite by existing.

## 0.7.3 — 2026-09-20

The Tin Can contract baseline moves to 0.6.0, whose opencode leg delivers to
`/session/{id}/prompt_async` instead of the v2 prompt endpoint. That resolves
the limitation described in 0.7.2: a message delivered to a TUI-hosted OpenCode
session now runs the turn.

Verified end to end, not just by the contract suite — a Muster-launched
OpenCode session received a Tin Can message, ran it, and replied to the sending
Claude Code session, with no `Failed to drain` line in the OpenCode log.

Note for anyone upgrading: the OpenCode plugin is a copy on disk under
`~/.config/opencode/plugin/`, and updating the npm package does not update it.
A stale plugin still posts to the old endpoint and fails exactly as before. The
peer registry records `plugin_version`; check it matches.

Contract suite 4/4 against a real installed `@brutalsystems/tincan@0.6.0`, with
every pre-existing fixture case unchanged.

## 0.7.2 — 2026-09-20

OpenCode launches gained three fixes, each of which had been failing invisibly.

A wildcard `*` permission entry suppresses MCP tools outright in OpenCode, and
an explicit allow for the tool does not rescue it, so every launch that
selected an MCP server reported the server connected while the model saw no
tools at all. A launch that selects MCP servers now names the built-in tools it
denies instead of relying on `*`; launches that select none keep the wildcard.
The built-in list is fixed, so a tool added by a future OpenCode release would
not be denied by it.

`--plugin NAME` (repeatable, `--no-plugin` to clear) selects plugins declared
under `[plugins.<name>]`. Selecting one drops `--pure`, which is what had been
suppressing them; selecting none keeps `--pure` and additionally pins an empty
plugin list, which is stricter than before. OpenCode merges project-local
`.opencode/plugin` discovery into any non-empty plugin list, so selecting a
plugin also admits whatever plugins the target repository ships — select
plugins only for repositories trusted with that.

`[opencode.provider.<name>]` and `[opencode] model`, or `--model`, carry the
provider and model in the verified per-launch overlay, so a launch no longer
depends on the operator's own OpenCode configuration. Provider definitions
merge with the child's own rather than replacing them. Credentials belong in
`api_key_env_var`, read from the launching environment.

Known limitation, and not a Muster one: a message delivered to a TUI-hosted
OpenCode session has, in every case observed on OpenCode 1.18.31, failed to
run. OpenCode admits it and schedules the turn, but the drain path fails to
resolve the session's model — the same model the TUI path resolves in the same
process — so the turn dies before reaching it. Seen across 14 distinct sessions
and two unrelated providers, with no TUI-hosted drain observed to succeed.
Reproduced on stock OpenCode with no Muster involvement and a globally
authenticated provider. An `opencode serve` session resolves its model and runs
the turn, which localises this to TUI-hosted sessions.

For callers this means a success response cannot be taken as evidence the peer
acted: nothing is recorded in the session and the only trace is a line in
OpenCode's own log. Tin Can 0.5.9 reports this as a notice on `send_peer`
results for OpenCode peers.

Documentation: the README now covers installing and updating Muster, including
that an MCP server started at session startup keeps the old binary until the
session restarts, and that publishing is tag-driven over OIDC. RELEASING.md now
describes the pipeline that exists rather than a hand-run `npm publish`. The
contract baseline prose read 0.2.0 while the command beside it pinned 0.5.2.

Releases are now one command: write notes under `## Unreleased`, commit, then
`npm version`, which stamps the heading, bumps, commits, tags and pushes.

CI actions moved from v4 to v7.

The Tin Can contract baseline moves from 0.5.2 to 0.5.9. The intervening
releases are additive on this contract: 0.5.6 added a `notes` array to `peers`
results, and 0.5.7 through 0.5.9 added and twice corrected a `notice` field on
`send_peer` results for OpenCode peers. Every pre-existing fixture case is
unchanged.

Validation: full automated suite (243 tests, 4 intentionally skipped) and the
Tin Can contract suite (4/4, verified against `@brutalsystems/tincan@0.5.9`)
passed.

## 0.7.1 — 2026-09-20

`muster --version` (or `-v`) prints the installed package version and exits.
The MCP server's own reported version, previously a hardcoded stale string,
now reads from `package.json` at runtime, the same as the CLI flag, so the
two can no longer drift apart.

Validation: full automated suite (229 tests, 4 intentionally skipped) and
the Tin Can contract suite (4/4, verified against `@brutalsystems/tincan@0.5.2`)
passed.

## 0.7.0 — 2026-09-20

OpenCode 1.18.31+ is now a first-class runtime for persistent sessions and
one-shot tasks. Sessions start their own Muster-selected `127.0.0.1` server,
return durable `session_id` and loopback `server_url` metadata only after API
readiness and listener-ownership checks, and participate in the existing tmux,
pty, terminal-viewer, list, refresh, stop, logging, and cleanup lifecycle. Tasks
run through `opencode run --format json` and retain the existing detached output
and exit-status behavior.

Provider and model configuration, including local OpenAI-compatible providers,
is inherited without rewriting OpenCode files. Every launch uses `--pure` to
disable external plugins. Muster verifies a per-launch overlay that disables
inherited MCP servers and tool families and enables only definitions selected
with `--mcp`; launch fails closed when managed configuration prevents that
isolation from being proven. OpenCode's tool permissions are not an OS-level
filesystem sandbox. Auto requires workspace-write, and bypass requires
operator-authorized full access, as for the existing normalized policy.

The minimum supported OpenCode version is 1.18.31. Muster owns the loopback
endpoint and never attaches to a personal OpenCode server. The endpoint metadata
is a transport-neutral seam for future Tin Can integration; native OpenCode
messaging versus A2A and the corresponding Tin Can changes remain deferred.

Validation: 229 automated tests and all four Tin Can contract cases passed. A
live OpenCode 1.18.31 session used the configured local
`local-provider/qwen3-30b` model, returned the expected reply, matched its
durable ID through `list`, exposed a healthy owned loopback endpoint, and was
then stopped and cleaned up.

## 0.6.0 — 2026-09-19

Launched Codex and Claude sessions can use explicitly configured MCP tools.
`--mcp NAME` selects a configured server, `--no-mcp` disables defaults, and MCP
`run` accepts the equivalent `mcp` array. Personal session defaults are optional;
tasks require explicit selection. No MCP server, including Tin Can, is required
or enabled by the shipped defaults. Launch output records enabled server names
and warnings for skipped optional defaults.

Server startup and tool discovery are checked before launch. Codex definitions
are isolated from inherited configuration; Claude connections enforce the tool
selection for discovery and calls. Existing sandbox and permission modes remain
in effect. See the README for configuration and supported transports.

Terminal.app and Ghostty no longer open extra startup windows or restored tabs.
Each launched agent has its own tmux session, so opening or exiting one does not
switch another agent's terminal viewer.

Validation: 133 automated tests and four Tin Can contract tests passed. Live
Codex and Claude sessions each received a Tin Can ping and replied through
their configured MCP tools.

## 0.5.0 — 2026-09-19

`run --open --terminal auto|terminal|iterm2|ghostty` selects the macOS viewer
while tmux continues to host the session. MCP accepts the same `terminal`
field. Auto defaults to Terminal.app, preserving existing behavior. Explicit
choices require the selected app; unavailable apps fail before agent launch.
`--terminal` without `--open` is refused. Results, human output, and launch logs
identify the resolved viewer. No permission or sandbox defaults change.

Ghostty uses a separate app instance configured to exit when its last window
closes. Terminal.app and iTerm2 use AppleScript and may require macOS Automation
permission. Apps must be in the documented Applications directories.

Validation: 110 model-free tests and all four Tin Can contract cases passed.
A live fake-runtime check confirmed Ghostty 1.3.1 attached to the intended tmux
window and the fake session was stopped. iTerm2 command construction is tested
against its documented API; live iTerm2 validation was unavailable because the
app is not installed on the test machine.

## 0.4.0 — 2026-09-19

`run --open` (MCP `open: true`) opens a new Terminal.app window attached to the
launched tmux session on macOS. Detached launch remains the default. Tasks and
pty hosts reject this option before launch. Opening failures stop the spawned
session; the requested open action is logged before launch. Successful records
include `terminal_opened: true`, also shown in human output. Terminal selection
is deferred; Terminal.app currently is the sole viewer.

Includes the normalized permission options prepared in 0.3.0 below.
Validation: 104 model-free tests and four Tin Can cross-binary contract cases
passed. A separate fake-runtime launch opened Terminal.app and attached a real
tmux client to the expected window; the test session was then stopped.

## 0.3.0 — prepared, not yet published

`run` accepts normalized `--permissions auto|deny|bypass` and
`--sandbox read-only|workspace-write|full-access` options. MCP accepts the same
fields. Per-launch choices override config defaults; defaults remain deny and
read-only. Launch results, human output, registry entries, and pre-launch logs
record the resolved settings.

Auto mode translates to Codex's automatic reviewer or Claude's auto permission
mode and requires workspace-write. Bypass requires full-access, and either
bypass or full-access requires operator config authorization. Incompatible
combinations are rejected without starting an agent. Raw permission/sandbox
flags are now refused even when dangerous flags are authorized: use Muster's
normalized options instead. The legacy config spelling danger-full-access
remains accepted.

Codex automatic review can hold multiple writer locks for one launch. Muster
now identifies the unique reachable CLI thread among locks belonging to its
spawned descendants, excluding internal review threads. Multiple qualifying
CLI threads still fail as ambiguous; no session-list diff is used.

Separate live checks confirmed both runtimes launch and answer their initial
prompts in auto mode, followed by cleanup. Claude still requires a pretrusted
directory. Automatic review can deny actions and depends on runtime/model/account
support; it does not guarantee every action will be approved.

Validation: 99 model-free tests, four Tin Can cross-binary contract cases,
20 installed-runtime argument combinations, and live auto-mode launches on both
runtimes passed. The prepared package installs and exposes the new CLI options.

## 0.2.1 — 2026-09-19

Human CLI output now colors states, labels, failures, and follow-up commands
for easier scanning. IDs and paths keep the normal text color. Colors apply
only to interactive terminals; `NO_COLOR` and `TERM=dumb` disable them. Piped
output, JSON, and MCP responses remain unchanged.

Validation: 85 model-free tests, four cross-binary contract cases, and an actual
terminal check with and without `NO_COLOR` passed.

## 0.2.0 — 2026-09-19

`run`, `list`, and `stop` accept `--format human` for readable terminal output,
including full IDs and copyable follow-up commands. JSON remains the default;
`--format json` is also accepted. Human output identifies unwatchable pty hosts,
shows task exit results, and handles empty lists. Captured task `output` and MCP
responses remain unchanged. Invalid formats are refused before launch.

Validation: 77 model-free tests and all four Tin Can 0.2.0 cross-binary contract
cases passed. The published package contains 32 allowlisted files.

## 0.1.0 — 2026-09-19

Muster starts instructed local Codex and Claude Code sessions and waits until
they are reachable before returning a peer record. Tin Can can use the returned
address; neither tool imports or depends on the other.

- CLI and stdio MCP: `run`, `list`, `stop`, and task `output`.
- tmux and pty terminal hosts, PID-based identity, reachability polling, and
  cleanup on timeout or process exit.
- Separate fire-once task handles with captured output; tasks are not peers.
- Read-only defaults, guarded runtime flags, concurrency limits, and logging
  before launch. Claude built-in tools remain available subject to permissions.
- Durable registry IDs and a frozen Tin Can naming contract with preserved
  upstream edge cases.

### Compatibility and deliberate limits

Tested on macOS with Codex 0.155.1, Claude Code 2.1.267, and tmux 3.7c.
Requires Node 22.12+ and POSIX process discovery. The macOS Terminal driver is a
stub; tmux and pty are implemented. pty sessions live only as long as their
Muster owner and cannot be watched or attached to.

Claude's target directory must already be trusted by its operator. Muster never
accepts trust prompts or edits trust settings. MCP installation is deliberately
session-scoped, never user-scoped. Custom MCP tools are not injected into launched
agents. Detected managed Claude policy is refused; v1 does not enforce enterprise
remote policy that arrives after startup.

Tin Can 0.2.0 is the exact independently installed contract-test baseline. Later
releases require compatibility verification, even if naming fixtures match.
Canonical addresses can collide or expire; use durable IDs and re-resolve before
sending. Codex `idle` means reachable and not known busy, not guaranteed free.

### Validation

The implementation passed 72 model-free tests and four cross-binary contract
cases covering both runtimes through both terminal hosts. Separate live probes
verified initial-prompt submission and replies on Codex and on Claude in a
pretrusted directory, followed by cleanup. Publishing checks additionally
inspect and install the packed artifact before release. The published registry
tarball matches the verified 31-file package (SHA-1
`5e8af67bac849c16ffa73ad74a0b60ecd01ce8b5`).
