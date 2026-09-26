# Agent identities

Running a launch as a named account instead of whatever the environment implied.

[← back to the README](../README.md)

## Agent identities

An **identity** is a named, pre-authenticated template configuration for one
agent, stored under `~/.muster/identities/<name>` at mode `0700`. Launching
under one makes a launch state which account it runs as instead of silently
inheriting whatever the environment happened to imply.

```sh
muster setup-identity --identity work --agent claude --interactive
muster setup-identity --identity ci-bot --agent codex
muster setup-identity --identity research --agent opencode
```

Claude needs a credential of its own: its keychain credential is keyed to the
template directory's own path, and a launch runs from a per-launch copy whose
path hashes to a different keychain service name, so a token is the only thing
that can authenticate a Claude identity launch. `muster run --identity` refuses
a Claude identity with neither route configured rather than spawning an agent
that cannot log in. There are two ways to give it one:

- **`--interactive` (recommended).** Runs `claude setup-token` itself inside a
  pty with your terminal attached both ways — you see the flow and approve the
  browser step, and anything it asks you (the `Paste code here if prompted:`
  fallback, say, which is what an ssh session gets) reaches it from your
  keyboard. It captures the token from the output and stores it at
  `~/.muster/identities/<name>/token`, mode `0600` — the same directory
  Codex and OpenCode identities already hold their own `auth.json` in. The
  command prints a redacted confirmation of what it stored, never the token
  (`muster identities` later reports only that a stored token is present). If
  the login's output format ever changes so the token isn't recognised, this
  fails open: nothing is redacted or captured, the token appears exactly as it
  does today, and the command says it could not store one and points you at
  `--token-env` to record the one now on your screen. It needs a terminal, and
  refuses when stdin is not one.
- **`--token-env NAME`**, for a machine that should keep no credential at
  rest — CI, say. It names the environment variable holding a Claude Code
  token (from a `claude setup-token` run yourself) — never the token itself.
  It applies to Claude **only**; Codex and OpenCode authenticate from an auth
  file inside the template, so `--token-env` is refused for them — it could
  only ever add a way for the launch to fail.

An identity holds exactly one of these routes at a time: storing a token
clears a declared `--token-env`, and passing `--token-env` deletes a stored
token. `setup-identity` says which route it removed, if either. Passing
`--interactive` and `--token-env` in the same command is refused rather than
resolved by precedence — they ask for opposite things, and choosing one for
you would be choosing where the credential lives.

`setup-identity` creates the template (or reuses an existing one for the same
agent — it refuses to repurpose one that belongs to a different agent) and
reports whether a credential is already configured. Without `--interactive`
it prints the **one-time login** for that agent to run yourself instead of
running it for you:

```sh
CLAUDE_CONFIG_DIR=~/.muster/identities/work claude setup-token   # then export it, or use --interactive
CODEX_HOME=~/.muster/identities/ci-bot codex login
OPENCODE_CONFIG_DIR=~/.muster/identities/research opencode auth login
```

Muster never performs a login without `--interactive` — each is an
interactive OAuth flow, and a command that appeared to do it for you without
showing you the flow would be hiding a credential prompt. Run the printed
command, complete the flow, then check the result:

```sh
muster identities
```

Launch under a named identity with `--identity`:

```sh
muster run claude --identity work --cwd ~/projects/thing --prompt 'Ship it'
```

At launch, Muster copies a declared subset of that identity's files into a
fresh per-launch directory under `~/.muster/identities-live/<launchId>/` and
points the runtime's own configuration-location variable
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `OPENCODE_CONFIG_DIR` +
`XDG_DATA_HOME`) at that copy — never at the template itself, so one launch
can never mutate another's credential.

The copy lives only as long as the launch. `muster stop` removes it directly,
and otherwise it is removed by the **first `muster list` after the entry
reaches a terminal status** (`exited`, `failed`, `stopped`, `unknown`). There
is no prune operation — an earlier draft of this documentation said the copy
was retained until the entry was pruned, and that was never what was built.
This matters for two reasons: an agent writes its own session transcript into
its configuration directory, so that transcript goes with the copy moments
after the launch ends (capture it while the launch is still running if you
need it), and resume/fork (#32) cannot assume a copy is still there.

Launching without `--identity` sets none of this: behaviour is exactly as
before, using the ambient environment.

**That is the right choice for profile work, which is counter-intuitive.** If
you already work in a shell whose `CLAUDE_CONFIG_DIR` selects an account —
`~/.claude-work`, say — a launch with no `--identity` inherits it, and the
session lands on that account with no flag at all. `launchEnv` blocks
`CLAUDECODE`, `CLAUDE_CODE_*`, `CODEX_THREAD_ID`, `TMUX`, `TMUX_PANE` and
`MCP_*` from reaching the child, and deliberately lets `CLAUDE_CONFIG_DIR`
through for exactly this reason. Passing `--identity` there does not add
containment to that account — it **replaces** it, pointing the runtime at a
copy of a different one, so the session appears under an account you did not
mean to use. Reach for `--identity` to choose an account Muster manages, not to
harden the one your shell already selected.

Session discovery follows the same relocated path, so a Claude identity's
sessions are found even though `CLAUDE_CONFIG_DIR` no longer points at
`~/.claude` — this was previously refused outright as an unsupported
configuration.

Five things worth stating plainly, because each is a sharp edge:

1. **`muster identities` reports _configured_, never _valid_.** A keychain
   item, an auth file, a stored token or a set variable proves a credential
   exists — not that it still works. Tokens expire and are revoked; there is
   no way to check that without exercising the credential, and `identities`
   does not do that.
2. **The identity store holds credentials at rest**, for every agent that
   keeps one there. Codex and OpenCode always do, because their own logins
   write auth files directly into the template. A Claude identity created
   with `--interactive` does too, at `~/.muster/identities/<name>/token` —
   the same directory, the same `0700`/`0600` protection, nothing more:
   storing it does not make it any safer at rest than Codex's or OpenCode's
   `auth.json` sitting right beside it, it just makes Claude consistent with
   them instead of relying on the operator's shell rc file. Directories are
   `0700`, and deleting an identity deletes whatever credential it holds —
   there is no separate secret to revoke elsewhere first. The one route with
   nothing at rest is `--token-env`: it names a variable instead, so the
   credential lives only in whichever environment sets that variable.
3. **Use `--interactive`, or `claude setup-token` with `--token-env` — never
   `ANTHROPIC_API_KEY`.** The OAuth token from `setup-token` bills the
   account's Claude subscription. An `ANTHROPIC_API_KEY` silently moves the
   same account onto pay-per-token API billing instead — same agent, very
   different bill, no error either way.
4. **A Claude identity's token is briefly written to disk during a launch.**
   The tmux host serialises the whole launch specification — environment
   included — to a temporary `launch.json` at mode `0600` and removes it once
   the launch is recorded. That is the same treatment every other launch
   variable gets, not special handling for this one, but it does mean a
   long-lived subscription token passes through disk; a launch whose host
   temp directory leaks (a crash before cleanup, a misconfigured `TMPDIR`)
   leaves it there.
5. **A requester profile with no `identities` lends the operator's own
   account** to that requester, because the launch falls back to the ambient
   environment exactly as it did before identities existed. That is preserved
   for compatibility, not a recommendation — an operator should set
   `identities` on any requester profile whose access they actually care
   about bounding.

A Claude launch under an identity also marks the launch's working directory
trusted _inside that launch's own copy_ of the configuration, so a brand-new
directory starts as a registered session without anyone accepting a trust
dialog. This is distinct from the ordinary Claude prerequisite described
above: it only ever writes to the per-launch copy, never to the operator's own
`~/.claude.json`, and only applies to launches under an identity. A launch
without `--identity` still requires the operator to have trusted the directory
themselves beforehand.

Automated tests use fake runtimes, so they prove the plumbing — the copy, the
variables, the trust flag, the lifecycle — but not that a real agent starts
authenticated from a copy. See
[docs/identity-verification.md](./docs/identity-verification.md) for the
manual checklist that covers that, and for which agents have actually been
verified.
