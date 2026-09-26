<img src="docs/assets/muster-logo.png" alt="" width="120" align="left" hspace="12" vspace="4">

# Muster

[![license](https://img.shields.io/github/license/BrutalSystems/muster)](./LICENSE)

<br clear="left">

**Launch coding agents on your machine, under containment you chose, and get
back an address you can actually reach.**

Muster starts Claude Code, Codex and OpenCode sessions on your behalf. You say
what the agent may do; Muster arranges it, verifies the session is genuinely
alive, and hands you a durable address for it. If a session never becomes
reachable, you get a diagnosis naming what stopped it — not a process that looks
fine and isn't.

It is the launching half of a small family: Muster starts agents,
[tincan](https://github.com/BrutalSystems/tincan) lets them message each other,
[birddog](https://github.com/BrutalSystems/birddog) watches what they do.

## What it's for

Running more than one agent, deliberately. One session reviewing while another
builds; a task that runs once and captures its output; an agent launched under a
separate account so its work never touches your own configuration. Muster is the
part that makes those launches repeatable, contained and addressable instead of
a terminal tab you have to remember.

A `session` returns an address only after its runtime is reachable. A `task`
runs once, captures output, and never advertises a peer address.

## What makes it different

- **Containment is two separate questions, and both are answered.** Whether the
  agent stops to ask you, and what it may touch — the second enforced by the OS,
  not by asking nicely. Every launch records which of the two it actually got.
- **A session is only reported ready when it is reachable.** Muster asks each
  runtime in its own language — a session record, an RPC call, an HTTP endpoint
  — and does not confuse "the process started" with "the agent is listening".
- **It refuses instead of guessing.** An unrecognised flag, a contradictory pair
  of options, an identity belonging to a different runtime: all errors, before
  anything is started. Nothing half-launched is left behind.
- **Other machines can ask, within limits you set.** An enrolled caller launches
  inside a profile's ceiling — the directories it may use, the strongest
  containment it may request. Configuration is the grant; the request never
  widens it.
- **Every claim here was measured.** Runtime behaviour is established by
  driving the real programs and recording what they did — see
  [Verification](docs/verification.md). Where a finding later proved wrong, the
  correction is in the release notes rather than quietly edited away.

Claude requires a directory already trusted by the operator, or
`--options auto-approve-path`. The automated suite uses fake runtimes, not real
models; behaviour against real ones is verified by hand and recorded in
`RELEASE_NOTES.md`.

## Quick start

```sh
npm install -g @brutalsystems/muster

# A session: an agent you can reach, addressed once it is genuinely alive.
muster run claude --prompt 'Review this project' --cwd . --level work

# A task: runs once, captures output, advertises nothing.
muster run codex --kind task --prompt 'Summarise the failing tests' --level read
muster output <id>

# What is running, and stopping it.
muster list --format human
muster stop <id>
```

`--level` names a containment pair. `read` can look but not change; `work` can
edit its working directory; `open` removes the sandbox and needs
`allow_dangerous_flags` in config.

| Level  | The agent asks before acting | What it may touch |
| ------ | ---------------------------- | ----------------- |
| `read` | always                       | nothing on disk   |
| `work` | no                           | its cwd           |
| `open` | no                           | everything        |

Claude asks to trust a directory the first time. That is a one-time review you
do yourself — or `--options auto-approve-path`, which records it for you after
checking the directory ships no hooks. See
[Claude workspace trust](docs/claude-trust.md).

## Requirements

**Node 22.12+** (tested on 24.16), and a POSIX host with `ps` and `lsof`.
Terminals use tmux or node-pty. The OS sandbox is seatbelt, so kernel-enforced
containment is macOS only; everywhere else `enforcement` reports what was
actually applied rather than pretending.

Then whichever agents you mean to launch, installed and logged in. Verified
against **Claude Code 2.1.274**, **Codex 0.155.1** and **OpenCode 1.18.31** or
newer — a newer OpenCode must keep the CLI and loopback HTTP API Muster uses.
What that verification covers is in [Verification](docs/verification.md).

## Documentation

|                                                      |                                                        |
| ---------------------------------------------------- | ------------------------------------------------------ |
| [How a launch runs](docs/launching.md)               | hosts, terminals, lifetimes, repeated requests         |
| [Configuration and permissions](docs/permissions.md) | containment, config file, remote callers               |
| [Agent identities](docs/identities.md)               | running as a named account                             |
| [Claude workspace trust](docs/claude-trust.md)       | the one-time dialog, and the two gates behind it       |
| [Command-line reference](docs/cli.md)                | output formats, runtime pass-through                   |
| [MCP servers and plugins](docs/mcp.md)               | tools for launched agents, and Muster's own MCP server |
| [Verification](docs/verification.md)                 | what is tested, what is checked by hand                |

## Keeping it up to date

Publishing a release does not touch an installed copy: `muster --version` keeps
reporting the old version until you update it.

```sh
npm update -g @brutalsystems/muster
```

If `which muster` resolves to a version-manager shim (for example
`~/.asdf/shims/muster`), run that update under the Node the shim resolves to and
reshim afterwards — `asdf reshim nodejs` — or the shim keeps pointing at the old
binary.

An MCP server starts once at session startup, so an agent session that already
has Muster loaded keeps running the old binary until that session restarts.
Updating on disk is not enough; restart the session too.

## Build and run locally

`npm run check` is the local gate: it builds, runs the suite, then packs and
verifies the tarball — the same `scripts/check-tarball.mjs` the CI packing job
runs, so the two cannot disagree about what "verified" means. `npm test` alone
does not pack anything, so tarball drift is green locally and red on push.

It is not everything CI does: CI additionally runs the suite across the Node
version matrix, and the contract suite runs only on release. Passing `check` is
necessary rather than sufficient.

Beyond the runtime requirements above, building needs TypeScript 5. The
terminal interface itself is platform-neutral; the macOS Terminal driver is an
unavailable v1 stub.

```sh
npm ci
npm run build
node dist/muster.js run codex --prompt 'Review the authentication flow'
node dist/muster.js run claude --prompt 'Summarize the project' --host tmux
node dist/muster.js run opencode --prompt 'Review this project'
node dist/muster.js run opencode --prompt 'Build a plan' -- --model local-provider/qwen3-30b
node dist/muster.js run codex --kind task --prompt 'Explain the test layout'
node dist/muster.js run opencode --kind task --prompt 'Summarize the tests'
node dist/muster.js list
node dist/muster.js list --format human
node dist/muster.js list --kind task
node dist/muster.js output RUN_ID
node dist/muster.js stop THREAD_OR_SESSION_OR_RUN_ID
```

`--prompt` is required and cannot be blank. `--cwd` defaults to the current
working directory. `--kind` defaults to `session`. All commands except `output`
emit JSON; `output` prints the captured task output. `stop` also accepts an
unambiguous peer name or canonical address, refusing ambiguity with candidates.
Use the durable ID to stop a session whose runtime has renamed it.

## License and releases

MIT © 2026 Mike Williams. See [LICENSE](./LICENSE). Vendored Tin Can code
retains source attribution and its [MIT notice](./TINCAN_LICENSE).

Publishing is tag-driven and runs in GitHub Actions over OIDC trusted
publishing, with no stored npm token. A bare `git push` publishes nothing; a
version tag is what triggers `publish.yml`. That workflow validates a [RELEASE_NOTES.md](./RELEASE_NOTES.md) section for
the version being published, so write the notes under `## Unreleased` as you do
the work and commit them normally. Cutting the release is then one command:

```sh
git commit -am "<the change, including its notes under ## Unreleased>"
npm version patch -m "%s — <what changed>"
```

`npm version` runs the `version` hook, which stamps `## Unreleased` into
`## <version> — <date>` and stages it, then bumps, commits and tags; the
`postversion` hook pushes the commit and tag together. If there is no
`## Unreleased` section, or it is empty, the stamp refuses — before a tag
exists, rather than in CI after one has been pushed.

[RELEASING.md](./RELEASING.md) covers versioning, package inspection, publication,
and release notes in full. Changes to the shared address format require an explicit
contract update; Muster never independently fixes the frozen naming behavior.
