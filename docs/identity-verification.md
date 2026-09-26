# Verifying agent identities

Named agent identities (`muster setup-identity`, `muster identities`,
`muster run <agent> --identity NAME`) are covered by an automated suite —
`test/identity-store.test.ts`, `test/identity-auth.test.ts`,
`test/identity-copy.test.ts`, `test/identity-cli.test.ts`,
`test/identity-launch.test.ts`, `test/identity-discovery.test.ts`,
`test/identity-lifecycle.test.ts`, `test/identity-opencode.test.ts`,
`test/identity-policy.test.ts` and `test/identity.test.ts` — but every one of
those tests runs against `test/fakes/runtime.cjs`, a fake runtime that records
what environment and arguments it received and reports itself ready. That
proves the plumbing: the copy gets made, the right variable gets pointed at
it, each agent's own trust flag gets written into the copy, the copy gets removed
on the right cleanup paths, and discovery derives its path from the
environment instead of a hardcoded `~/.claude`/`~/.codex`/`~/.config/opencode`.

None of it proves that a **real** agent — Claude Code, Codex or OpenCode,
built and authenticated the way an actual user authenticates them — starts up
believing itself logged in when pointed at a copy of an identity's files
instead of its own real configuration directory. A fake runtime cannot lie to
you about that; only a real one can. That needs a human, with a real account
for each agent, running the one-time login and then a real launch, once per
agent. This document is that checklist.

## Prerequisites

- The version of Muster under test installed and on `PATH` (`muster
--version`).
- A real, working install of the agent being verified — `claude`, `codex`, or
  `opencode` — new enough to match the versions in the [README](../README.md)
  install requirements, and a real account to log each of them into.
- A scratch `~/.muster` you don't mind creating identities in, or `MUSTER_HOME`
  pointed somewhere disposable if the repo's test suite supports overriding
  it. Nothing here requires network access to any Muster-specific service —
  only to the agent vendor's own login endpoints.

## Per-agent checklist

Repeat this block once per agent. Each step's exact command is given; when a
step's outcome differs from what's described, stop and treat the identity as
**not verified** — don't skip ahead and assume a later step will paper over
it.

### 1. Create the identity

```sh
muster setup-identity --identity verify-<agent> --agent <codex|claude|opencode>
# for Claude, --token-env is required for the identity to be launchable unless
# it was created with --interactive instead (see step 2):
muster setup-identity --identity verify-claude --agent claude --token-env VERIFY_CLAUDE_TOKEN
```

Expect a JSON object naming the identity's `path` under
`~/.muster/identities/verify-<agent>`, a `login` command, and
`auth.state: "not-configured"` — nothing has logged in yet.

### 2. Run the printed login

Copy the exact `login` command from step 1's output and run it yourself,
interactively, in a real terminal. Muster does not and will not run this for
you — it's an interactive OAuth flow, and a command that appeared to do it
automatically would just be hiding a credential prompt somewhere you can't
see it. Complete whatever the agent's own login flow asks for (browser
approval, device code, `/login`, `claude setup-token`, etc.) using a real
account.

For Claude specifically, the recommended way to do this step is to have
created the identity in step 1 with `--interactive` instead of `--token-env`:
that single command runs `claude setup-token` itself inside a pty with your
terminal attached both ways — you see and approve the browser step, and
anything the login asks you reaches it from your keyboard — captures the token
from the output, stores it at `~/.muster/identities/<name>/token` (mode
`0600`), and prints a redacted confirmation (`sk-ant-oat01…AwAAA`) instead
of the token — nothing sensitive lands in this terminal's scrollback. If the
login's output format ever changes so the token isn't recognised, this fails
open: nothing is redacted, nothing is captured, you see the token exactly as
you do today, and the command says it could not store one. Fall back to
`--token-env` with the token you can now see: re-running `--interactive` would
mint a _different_ token, so it can never store the one on your screen. If the
login itself fails — `claude` not on PATH, a refused browser approval — the
command fails with that identity's name and nothing is stored, and the login's
own output above it is the error.

The manual alternative — what step 1's example command above uses, and the
only option for a machine that should keep no credential at rest, CI say —
is `--token-env NAME` pointing at a variable holding a token from a `claude
setup-token` you ran yourself. An interactive `/login` writes a keychain
credential keyed to the _template_ directory's path, and a launch runs from
a per-launch **copy** whose path hashes to a different keychain service name
with no fallback — so a Claude identity logged in that way can never
launch. `muster setup-identity` will still create such an identity, but
`muster run --identity` refuses the launch before anything is reserved, and
`muster identities` reports it as `not-configured`.

Use the token from `setup-token` and **not** an `ANTHROPIC_API_KEY` exported
into that shell. The token from `setup-token` bills the account's Claude
subscription; an `ANTHROPIC_API_KEY` silently moves that same account onto
pay-per-token API billing instead, and nothing about a successful login will
tell you which one you did.

### 3. Confirm `muster identities` reports configured

```sh
muster identities
```

Find `verify-<agent>` in the output and confirm `auth.state` is now
`"configured"`, with a `detail` that matches what you'd expect (the
`--token-env` variable being set, for Claude; `auth.json` for Codex;
`data/opencode/auth.json` for OpenCode). A Claude identity with **no**
`--token-env` reports `not-configured` even when the keychain holds an item
for its template path — that item is keyed to the template's path and a
launch runs from a copy, so it cannot produce a launch and is not reported as
though it could.

Remember what this confirms and what it doesn't: it confirms a credential is
configured — an auth file in the identity's template, or a token variable
that is set. It does **not** confirm that credential still
works — see [Sharp edges](#sharp-edges-worth-remembering) below.

### 4. Launch into a brand-new directory

Pick or create a directory the target agent has never been opened in before
— genuinely new, not merely empty, so there is no chance an old workspace-trust
decision for it is already sitting in the operator's real `~/.claude.json` (or
equivalent) and masking a broken copy:

```sh
# One variable, so the timestamp is generated once and reused. Writing
# `$(date +%s)` in the mkdir and then a literal `<timestamp>` in the --cwd
# gives you two different directories and a launch into an empty one.
DIR=/tmp/muster-identity-verify/<agent>-$(date +%s)
mkdir -p "$DIR"
muster run <codex|claude|opencode> --identity verify-<agent> \
  --cwd "$DIR" \
  --prompt 'Say hello and stop.' --format human
```

### 5. Confirm it registers without a dialog

Expect the command to return a `running` record with a real `id`/session
address within the configured `launch_timeout_sec` (30s by default) — **and**
expect to have seen no trust-dialog, login-dialog, or approval prompt of any
kind appear for you to click through, in any terminal or window the launch
opened. If a dialog does appear, or you're prompted to accept anything by
hand, that's not a pass even if you click through it and the launch
eventually reaches `running` — the whole point of an identity launch is that
nobody has to do that.

### Expected failure to watch for

A launch that instead **times out** with a diagnostic of the shape:

```
no Claude session registry found (check terminal for workspace trust or login prompts) after 30s
```

(or for Codex, `no descendant runtime identity found after 30s`; for
OpenCode, `no OpenCode session matched the launch endpoint, cwd, and creation
window after 30s`) means the copy did not leave the agent authenticated and
trusting the directory — for Claude specifically, most often the workspace-
trust flag inside the copy's `.claude.json` did not take effect, or the
token/keychain credential the copy pointed at did not actually work. Do not
mark the agent verified. Treat it as a bug report: check
`~/.muster/identities-live/<launchId>/` for what the copy actually contained,
and compare against `IDENTITY_FILES` in `src/identity-copy.ts`.

**Capture that directory before you run `muster list` or `muster stop`.** The
copy is removed by the first `list` after the entry reaches a terminal status,
and directly by `stop` — there is no prune step that keeps it around. A timed-
out launch reaches a terminal status, so the very next `muster list` deletes
the evidence. Copy the directory aside first (`cp -a
~/.muster/identities-live/<launchId> /tmp/`), then investigate.

**What this looked like for Codex, and how it was found** (fixed in f252d13,
recorded because the next agent added will have the same shape of gate). Codex
has a directory-trust prompt of its own, behind a different file and a different
key than Claude's, and a fresh copy trusted nothing — so _every_ Codex identity
launch timed out with `no descendant runtime identity found after 30s`. The copy
was useless as evidence after the fact: post-mortem it is deleted, and captured
mid-launch it looked healthy — `auth.json` present, Codex's own sqlite state
being written into it, no error anywhere. The one thing missing was
`thread-writer-locks/`, which is exactly what discovery looks for.

What actually answered it was capturing the terminal, not the filesystem:

```sh
S=$(tmux -L muster list-sessions -F '#{session_created} #{session_name}' | sort -rn | head -1 | cut -d' ' -f2)
tmux -L muster capture-pane -p -t "$S"
```

which showed the agent sitting on "Do you trust the contents of this directory?".
**Capture the pane before the filesystem.** A launch that never registered is
usually a launch waiting on a human, and the pane says so in one line while the
copy's contents will not say it at all.

### 6. Clean up

```sh
rm -rf ~/.muster/identities/verify-<agent>
rm -rf /tmp/muster-identity-verify
```

Stop the launched session (`muster stop <id>`) if it's still running.

## Verification status

Codex has been walked end to end. Claude and OpenCode have not. Update this
table (agent, date, who, and the Muster version tested) the first time each row
is actually walked through, including a successful step 5 with no dialog.

| Agent    | Verified | Date       | By            | Muster version              |
| -------- | -------- | ---------- | ------------- | --------------------------- |
| Claude   | No       | —          | —             | —                           |
| Codex    | Yes      | 2026-09-23 | Mike Williams | main @ f252d13 (unreleased) |
| OpenCode | No       | —          | —             | —                           |

**What the Codex row does and does not claim.** Steps 1-5 all passed: a real
`codex login` against a real ChatGPT account under `CODEX_HOME` pointed at the
template, `muster identities` reporting `configured`, and a launch into a
brand-new directory that reached a registered session with a real `thread_id`
and no dialog of any kind to click through. The copy contained `auth.json`, the
trust entry Muster wrote, `thread-writer-locks/`, `sessions/` and
`thread_history_1.sqlite` — a real, authenticated, discoverable Codex session
running as that account.

It does **not** claim a model reply was obtained. The account had exhausted its
usage limit ("You've hit your usage limit... try again at Sep 27th"), so the
agent accepted the instruction and could not answer it. That is an account
condition, not an identity one, and everything the identity mechanism is
responsible for — authenticated, onboarded, trusting the directory, discoverable
— was verified. A reader wanting the last inch (an actual answer coming back
under the identity) should re-run step 4 with an account that has credit.

The row is pinned to an unreleased commit deliberately: the released 0.7.14
cannot pass it. Every Codex identity launch on 0.7.14 fails at step 5 for the
reason documented above.

An agent missing from this table, or listed with "No", must be treated as
unverified — assume nothing about whether a real launch under that identity
actually works. Don't infer "probably fine" from the other two rows passing;
each agent's login flow, configuration layout, and session-discovery
mechanism are unrelated to the others', and a pass on one says nothing about
the others.

### OpenCode's additional unverified constant

Beyond "nobody has walked the checklist above for OpenCode yet," OpenCode
carries a second, more specific unverified claim. `IDENTITY_FILES.opencode`
in `src/identity-copy.ts` (`opencode.jsonc` for config, and
`data/opencode/auth.json` for the auth file, with `XDG_DATA_HOME` pointed one
level above the copy so the binary's own hardcoded `opencode` suffix lands
back on it) was derived by inspecting the real installed 1.18.32 binary and
the real on-disk layout it produces under `~/.config/opencode` and
`~/.local/share/opencode` — not guessed. That inspection is documented in
`src/identity-copy.ts` itself and in `task-4-report.md`. But it was never
exercised end to end against an authenticated OpenCode identity, because no
one has run the OpenCode one-time login on this machine to produce a
template to copy from and launch. Whether a copy built to that shape
actually leaves OpenCode believing itself logged in on first launch — which
is exactly what step 5 above checks — is the open question this whole
document exists to close, and for OpenCode specifically it closes both that
question and this one at once.

## Sharp edges worth remembering while doing this

- **`muster identities` reports _configured_, never _valid_.** Revisiting
  this checklist after a token expires or is revoked will still show
  `"configured"` right up until a real launch fails at step 5 — the state
  reported by `identities` and the state actually required to pass this
  checklist are different questions, and only this checklist answers the
  second one.
- **The identity store holds credentials at rest.**
  `~/.muster/identities/verify-<agent>` contains a real, usable credential the
  moment step 2 completes, not just a reference to one — Codex and OpenCode's
  own logins write `auth.json` there directly, and a Claude identity created
  with `--interactive` gets the same treatment: a usable, year-long token at
  `~/.muster/identities/<name>/token`, mode `0600`. Treat deleting the identity
  directory as revoking a credential, because it is, for all three agents.
  Storing the Claude token this way is what makes `muster identities` answer
  the same way in every shell; before that, the same identity read as
  configured only where a variable happened to be exported. The one route
  that keeps nothing in the identity directory is `--token-env`.
- **A Claude identity's token is briefly written to disk during a launch** —
  the tmux host serialises the whole launch specification, environment
  included, to a temporary `launch.json` at mode `0600` and removes it once
  the launch is recorded. This is expected during step 4/5 and is not itself
  a failure; it's mentioned here so it isn't mistaken for one if you go
  looking at what a launch wrote to disk mid-flight.
