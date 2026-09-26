# Four agents, one pipeline

Four agents build a word-frequency tool together. Three write one pipeline
stage each; the fourth writes the command-line entry point, waits for them to
report, then runs the suite.

It is small on purpose. The interesting part is not the program — it is that
four separately launched agents, in three processes and two runtimes, agree on
an interface, work in parallel without colliding, and hand their work to one
another without a human relaying messages.

    parse.js     rank.js     format.js     3 workers: 2 opencode, 1 codex
        \           |           /
         \          |          /             DONE messages via Tin Can
          \         |         /
              cli.js                         opencode integrator
              node --test

## What each agent owns

| Agent | Runtime | Writes | Interface it must honour |
|---|---|---|---|
| parse | opencode session | `src/parse.js`, `test/parse.test.js` | `parse(text) -> string[]` |
| rank | **codex task** | `src/rank.js`, `test/rank.test.js` | `rank(words) -> [word, count][]` |
| format | opencode session | `src/format.js`, `test/format.test.js` | `format(rows, limit) -> string` |
| integrator | opencode session | `src/cli.js`, `test/cli.test.js` | chains the three |

File ownership is disjoint, so no two agents ever write the same file. The
only shared surface is the three signatures, and those are fixed in the prompts
before anyone starts — nothing is negotiated at runtime.

## The protocol

Peer names are assigned at launch. A prompt can therefore only name an agent
that already exists, which decides the launch order:

1. Launch the integrator first, and resolve **the name Tin Can knows it by** —
   not the name muster reports. These differ, and it matters: see below.
2. Substitute that name into the three worker prompts.
3. Launch the workers. Each writes its stage, tests it, and sends **one**
   message: `DONE <stage> <files> <n> tests passing`.
4. The integrator writes the CLI immediately — it knows the contract, so it
   does not wait — then blocks until three DONE messages arrive, runs
   `node --test`, and reports.

Three messages in total, one per worker, no round trips.

### The two names are not the same string

Muster reports a session name like `new-session-2026-09-20t22-10-21-850z`. Tin
Can addresses the same session by its OpenCode slug, like `shiny-comet`. Putting
muster's name in a worker prompt produces:

    tincan_send_peer [peer=new-session-2026-09-20t22-10-21-850z, ...]
    → The integrator peer isn't reachable yet.

The worker then retries, sleeps, re-checks `peers`, and looks like it is
thinking hard when it is actually stuck. Worse, the run still *succeeds*: the
integrator's stop condition fires, it runs the suite anyway, the tests pass, and
you get a green result from a protocol that never delivered a single message.

We shipped exactly that mistake and only caught it by reading a worker's
terminal. `run.sh` now resolves the slug from
`~/.tincan/peers/opencode/<session-id>.json`, and prints both names so the
difference is visible:

    integrator: shiny-comet  (muster called it new-session-2026-09-20t22-10-21-850z)

**Check the plugin log if you want proof the protocol ran**, rather than
trusting a passing suite:

```sh
grep delivered ~/.tincan/opencode-plugin.log | tail -3
```

## Setup

You need muster, a model, and Tin Can registered as an MCP server. Tin Can is
what lets the agents message each other; muster does not require or install it.

Register it in `~/.muster/config.toml`:

```toml
[mcp_servers.tincan]
command = "tincan"
tools = ["peers", "send_peer", "message_log"]
required = false

[plugins.tincan]
path = "~/.config/opencode/plugin/tincan.ts"
```

The `[plugins.tincan]` entry matters. Tin Can has two halves: an MCP server
that gives an agent the messaging tools, and an OpenCode plugin that advertises
the session so other agents can reach it. Without the plugin a session can send
but cannot be sent to, and this example needs neither — the workers only send —
but you will want it for anything two-way.

**The trap worth knowing**: the OpenCode plugin is a copy on disk. Updating the
npm package does not update it. A stale plugin fails in a way that looks
exactly like an agent ignoring you.

```sh
PKG=$(npm root -g)/@brutalsystems/tincan
cp "$PKG/plugins/opencode/tincan.ts" ~/.config/opencode/plugin/
cp -r "$PKG/plugins/opencode/tincan-lib" ~/.config/opencode/plugin/
```

Sessions record the version they loaded, so you can confirm it took:

```sh
cat ~/.tincan/peers/opencode/ses_*.json | grep plugin_version
```

## Why the codex agent is a task, not a session

This is the design decision most worth understanding, because it is forced.

A codex **session** asks, interactively, whether it trusts a directory the
first time it opens one:

    Do you trust the contents of this directory?
    1. Yes, continue   2. No, quit

It waits there indefinitely. Muster does not answer trust prompts on your
behalf, so codex never starts, muster waits for a process that will never
appear, and you get `no descendant runtime identity found after 30s` — a
message that says nothing about trust.

Nothing gets a session past it. A per-launch `-c projects."…".trust_level`
override does not work. Neither does
`--dangerously-bypass-approvals-and-sandbox`. Trust is not inherited from a
parent directory. The only routes are answering once, which persists to
`~/.codex/config.toml`, or writing that entry yourself.

A codex **task** has no trust gate at all — tasks run `codex exec`, which
never asks. So the codex agent here is a task, and it costs nothing: a worker's
job is to do the work, report once, and exit, which is precisely a task's
shape. The example stays fully unattended.

This is worth separating from approvals. Approval policy is muster's job and
it works: `--permissions` and `--sandbox` map onto each runtime's approval
settings. Trust is a different, one-time-per-directory gate that the runtimes
deliberately make non-bypassable.

**The directory must also be a git repository** or codex exits with "Not
inside a trusted directory and --skip-git-repo-check was not specified".
`run.sh` runs `git init` for you.

## Running it

```sh
./run.sh /tmp/wordcount <your-opencode-model> [your-codex-model]
```

Four terminals open. Watch the integrator's: it writes `src/cli.js` straight
away, then sits waiting while the workers report.

When it finishes:

```sh
cd /tmp/wordcount
node --test
node src/cli.js sample.txt 5
```

`expected/` holds the real output of our run — the four source files, the four
test files, and the console output. Ours ran on a **local** model, three agents
concurrently, and assembled first try in well under two minutes:

    $ node --test
    tests 15 | pass 15 | fail 0

    $ node src/cli.js sample.txt 5
    the      8
    fox      5
    dog      4
    and      3
    not      3

All three DONE messages were delivered — confirmed in the plugin log, not
inferred from the passing suite.

Your agents will not match it byte for byte. Different models write different
code, and that is the point: the *interfaces* are fixed, the implementations
are not.

Stop everything when you are done:

```sh
muster list --format json \
  | python3 -c 'import json,sys;[print(e["canonical_id"]) for e in json.load(sys.stdin) if e.get("state") in ("idle","busy")]' \
  | xargs -n1 muster stop
```

## Why the flags are what they are

`--permissions auto --sandbox workspace-write` — the agents write files and run
tests, so they need more than the read-only default. `auto` passes OpenCode's
`--auto`, which auto-approves anything not explicitly denied. Read that flag's
own warning before using it on anything you care about, and note that launched
agents inherit your environment.

`--mcp tincan` on every agent — the workers need `send_peer`; the integrator
needs to receive. An explicit `--mcp` selection replaces your personal
defaults, so the example does not depend on how you have `default_mcp` set.

Sessions for anything that must be *reached*; a task for anything that only
reports. The integrator is a session with `--plugin tincan`, because being
addressable is what the plugin provides. The codex worker is a task, which gets
no MCP or plugin defaults at all — hence the explicit `--mcp tincan`. A task
cannot be messaged, which is fine: it only ever sends.

## What tends to go wrong

**An unreachable peer looks exactly like a thinking agent.** A worker whose
`send_peer` fails will retry, sleep and re-check, burning context while
appearing busy. We spent a long time believing our agents were too slow or the
local model was contended, when they were addressing a peer name that did not
exist. If an agent seems to be working but producing nothing, read its terminal
and check the plugin log for deliveries.

**A green test suite is not proof the protocol worked.** Because the integrator
is told not to hang, a run in which zero messages arrive still ends with a
passing suite and a printed table. The artifact and the coordination are
separate claims; verify them separately.

**A DONE message is a claim, not evidence.** One of our workers reported
"5 tests passing" when its own suite had 4 passing and 1 failing — it counted
the tests it had written rather than the result of running them. This is why the
integrator runs `node --test` itself instead of trusting the reports. Design any
protocol like this one on the assumption that workers will over-report.

**A weak model makes this look broken.** The workers must call a tool with an
exact argument. Small local models loop on this, re-sending the same call, or
invent a tool name that does not exist. If an agent seems stuck, read its
terminal before blaming the plumbing.

**A worker never reports.** The integrator is told not to hang: after a long
wait it reports which stages are missing and whether the files exist anyway.
A partial result stated clearly beats a hang.

**Messages queue; they do not interrupt.** Tin Can delivers to a busy agent's
queue, and as of 0.6.0 there is no urgent delivery on any runtime. Nothing here
needs interruption, but do not design around one.

**`no descendant runtime identity found after 30s`.** A codex *session* sitting
on a trust prompt, or any runtime in a directory that is not a git repository.
The message describes what muster observed, not what went wrong. See above.

**An agent edits someone else's file.** Every prompt forbids it, and the
integrator is told to report a worker's failing test rather than fix it. If it
happens anyway, that is a finding worth keeping — it is exactly the failure
mode that makes multi-agent work hard.
