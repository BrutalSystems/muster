# Five agents, one world

Four agents each write one kingdom of a shared fantasy world. A fifth — the
only one that is not a local model — runs a timed council where the four agree
on a theme, checks what they produce against a rigid contract, and assembles
the four fragments into a single self-contained HTML atlas.

    Asterfall   Nacre   Embersteppe   Verdant      4 opencode workers,
        \         |          |          /          local Qwen3 30B A3B
         \        |          |         /
          \       |          |        /            council + READY over Tin Can
                dist/atlas.html                    claude orchestrator

It is a creative task on purpose. The four workers are given the same immutable
canon and the same 13-rule output contract, but different realms, palettes and
document forms. The interesting question is not whether a 30B model can write
HTML — it can — but whether four of them, coordinating only through messages,
produce something that reads as one world.

## What each agent owns

| Agent | Runtime | Model | Writes |
|---|---|---|---|
| Asterfall | opencode session | Qwen3 30B A3B | `workers/01-asterfall/chapter.html` |
| Nacre Dominion | opencode session | Qwen3 30B A3B | `workers/02-nacre/chapter.html` |
| Embersteppe Compact | opencode session | Qwen3 30B A3B | `workers/03-embersteppe/chapter.html` |
| Verdant Choir | opencode session | Qwen3 30B A3B | `workers/04-verdant/chapter.html` |
| Orchestrator | **claude session** | — | `dist/atlas.html`, `dist/council-log.md`, `shared/theme-charter.md` |

Each worker's `--cwd` is its own directory, so no worker can reach another's
files by a relative path. File ownership is disjoint; the only shared surface
is the canon, and that is fixed in every brief before anyone starts.

## The protocol

Peer names are assigned at launch, so a brief can only name an agent that
already exists. That fixes the order:

1. Launch the orchestrator first and record its peer name.
2. Assemble each worker's `BRIEF.md` — canon, realm, contract and rules in one
   file — with that name substituted in, and launch the four workers.
3. Write `ORCHESTRATOR.md` with the four worker names now known, and nudge the
   orchestrator to start.
4. The orchestrator runs a 10-minute council: `COUNCIL_START`, one
   `THEME_PROPOSAL` per worker, `COUNCIL_ROUND_2` relaying every proposal, one
   `THEME_VOTE` per worker, then `THEME_LOCKED`.
5. Workers write their chapters independently and send `READY <realm> <path>`.
6. The orchestrator validates, requests at most one repair per worker, and
   assembles the atlas.

The orchestrator never proposes a theme, never writes a chapter, and never
rewrites one. If a worker fails twice, its realm is marked FAILED and the
partial output is preserved.

## Two transports, not one

This is the part that is easy to get wrong.

**Tin Can has no broadcast and no channels.** `send_peer` reaches exactly one
peer. Every council announcement is four separate calls, and "each worker sends
a proposal the others can see" is not something Tin Can can do — the
orchestrator relays proposals verbatim in `COUNCIL_ROUND_2`. Relaying is not
authoring.

**Tin Can deliberately does not carry Claude-to-Claude traffic.** From its own
source:

> Claude Code's own sessions are reached natively via SendMessage, so Tin Can
> deliberately does not duplicate that path.

So the mesh uses two transports, and both were verified end to end:

| From | To | Transport |
|---|---|---|
| orchestrator (claude) | worker (opencode) | Tin Can `send_peer` |
| worker (opencode) | orchestrator (claude) | Tin Can `send_peer` |
| launching session (claude) | orchestrator (claude) | `SendMessage` |

A worker's `peers` list on this machine showed **14** live Claude sessions,
three of them with near-identical names. A worker told to "message the
orchestrator" would have a real chance of picking the wrong one, so briefs name
the orchestrator by its exact canonical id.

## The two names are not the same string — except for Claude

Muster's session name and the name Tin Can addresses a peer by are different
strings for OpenCode. Muster reports something like
`new-session-2026-09-20t23-55-17-101z`; Tin Can uses the OpenCode slug, like
`proud-sailor`. Sending to muster's name fails:

    → No peer matches "new-session-2026-09-20t23-55-17-101z".

`run.sh` maps through `~/.tincan/peers/opencode/<session-id>.json` for the
workers, exactly as the four-agent example does.

**For Claude this does not apply.** Muster's reported `canonical_id` *is* the
string Tin Can addresses the session by — `claude-code:meridian-af.a62` came
back byte-identical in a worker's peer list. So the orchestrator's name is read
straight from its launch record, with no registry lookup.

### OpenCode names drift; the Tin Can name does not

An OpenCode session retitles itself from its own conversation. One probe went
`new-session-…` → `registered` → and muster's registry followed it each time.
**Tin Can's name is pinned when the plugin registers and does not move.** A
send to the registration-time name still delivered after the session had been
renamed twice, and replies still came back under the original name. A roster
recorded once at launch stays valid for the whole run.

## The one manual prerequisite

Muster never accepts a workspace-trust prompt, so a Claude session cannot be
launched into a directory Claude does not already trust:

    [muster] no Claude session registry found
             (check terminal for workspace trust or login prompts) after 30s

**Trust inherits from a parent directory.** Trust `~/Sandbox` once, by hand,
and every experiment directory created under it afterwards launches with no
prompt:

    cd ~/Sandbox && claude      # accept the trust review, then exit

This is a one-time step per parent directory, not per run. The four OpenCode
workers need no trust at all — only the Claude orchestrator does.

## Raise the concurrency cap before you run

Muster's `max_concurrent` defaults to **4**. This example launches **5** agents,
so the fifth launch fails with:

    [muster] Concurrency cap reached (4)

There is no CLI flag; it is config only. In `~/.muster/config.toml`:

    max_concurrent = 6

## Setup

You need muster, Tin Can registered as an MCP server *and* as an OpenCode
plugin, and a local OpenAI-compatible model. The plugin is what makes an
OpenCode session reachable as a peer — with only the MCP server a worker can
send but cannot be addressed.

```toml
# ~/.muster/config.toml
max_concurrent = 6
default_mcp = ["tincan"]
default_plugins = ["tincan"]

[mcp_servers.tincan]
command = "tincan"
tools = ["peers", "send_peer", "message_log"]

[plugins.tincan]
npm = "@brutalsystems/tincan-opencode"

[opencode]
model = "muster-local/qwen3-30b-a3b"

[opencode.provider.muster-local]
npm = "@ai-sdk/openai-compatible"
name = "Muster local (MLX)"
base_url = "http://127.0.0.1:11436/v1"
api_key = "local"

[opencode.provider.muster-local.models.qwen3-30b-a3b]
name = "Qwen3 30B A3B (local)"
tool_call = true
```

## Run it

```sh
./run.sh ~/Sandbox/meridian muster-local/qwen3-30b-a3b <your-claude-session-name>
```

The third argument is the Claude session that should receive the final report;
find it in `ListAgents`. `run.sh` prints the nudge to send the orchestrator once
the workers exist.

Take that name from the **first line** of your own `ListAgents` output — the
line that reads `This session is <name> [ref]`. That is the address other
sessions reach you at, and it is not necessarily the name you call yourself:
a session identified in its own notes as `ferry-d9` was registered as
`ferry-3a`, and a brief naming the former could never be answered.

**Read it at dispatch time, not once at the start.** The value can change
while a session is still running — name and ref together — so a name captured
early and reused later will silently stop resolving. The failure is quiet in
the wrong direction: the *worker's* send errors, and the worker is usually the
only one who sees it. If the brief also says "write the report to disk first,
message second" — which it should — the deliverable still arrives and the
controller has no reason to look.

When a send does fail with

```
No agent named 'X' is reachable. Did you mean: a, b?
```

check the first candidate against the controller's current name before
investigating anything else. That error is already correct and already
contains the answer; it is worth reading before suspecting the registry.

Watch it:

```sh
muster list --format human
tail -f ~/Sandbox/meridian/dist/council-log.md
grep delivered ~/.tincan/opencode-plugin.log | tail
```

That last one matters. A run can look successful while never delivering a
single message — the orchestrator's deadline fires, it proceeds anyway, and you
get an atlas assembled from a protocol that never ran. Check the log rather
than trusting a finished file.

## What the model can and cannot do

Measured against this contract on the local Qwen3 30B A3B, before the run:

- **Capacity is not the constraint.** Four concurrent 1,500-token generations
  finished in 23s wall — the MLX server batches rather than serializing.
- **The contract holds.** Given the 13 rules explicitly, one shot produced a
  valid fragment: correct outer section, scoped selectors, exactly two titled
  SVGs with `role="img"`, no h1, no script, no external URLs. 10 of 11
  mechanical checks passed in 26 seconds.
- **Length is the weak rule.** It wrote 723 words against a 900 floor. The
  contract in `shared/contract.md` therefore asks for **1,100–1,400, aim
  1,250**, so the real floor is cleared from above. Expect the one permitted
  repair round to be spent here.
- **Prohibitions do the work.** The same request *without* the explicit rules
  produced a markdown-fenced, full `<!doctype>` document. Every "do not" in the
  contract is load-bearing; do not trim them for brevity.

## An acknowledgement is a whole turn

This is the failure the first run actually hit, and it is the one worth
carrying to any message-driven multi-agent design.

After `THEME_LOCKED`, three of the four workers replied `THEME_ACK` — and that
reply *was* their entire turn. An OpenCode session produces output, goes idle,
and then does nothing at all until another message arrives. All three sat
there, acknowledged and empty, looking exactly like agents that were busy
writing. Only Embersteppe, which happened to carry on in the same turn,
produced a chapter unprompted.

Nothing was broken. Every message was delivered, every worker understood the
instruction, and each did precisely what it was told: acknowledge. "Acknowledge
the charter, then write a 1,250-word illustrated chapter" reads to a human as
one instruction with two parts. To a turn-based agent it is one small
instruction, completed, followed by silence.

**The orchestrator did not catch it, because its rules told it not to.** The
first version of `prompts/orchestrator.md` said "monitor sparingly" and "a
worker writing for several minutes is working, not stuck" — sound advice
against nagging, and exactly wrong here. It had no rule that separated *busy*
from *idle-with-nothing-on-disk*, so it waited politely on three agents that
were never going to move. A human had to notice and say so.

`prompts/orchestrator.md` now carries the broader rule: check liveness against
the disk rather than trusting silence, and judge each worker on the pair of
facts, not on either alone.

| State | On disk | Meaning | Action |
|---|---|---|---|
| busy | no file | writing | wait |
| idle | file present | done, or waiting on you | validate it |
| **idle** | **no file** | **stalled — it ended its turn** | **re-prompt it now** |
| busy | file present | revising | wait |

Two details matter as much as the rule itself:

- **A stall is not a failure.** It is a turn-mechanics artifact. It must not
  consume the worker's single repair attempt and must not count toward marking
  a realm FAILED. The one-repair limit is for a chapter that exists and breaks
  a rule. Re-prompting a stalled worker is free and may be repeated.
- **Silence is ambiguous, so never infer from it.** "Still working", "finished
  and waiting", and "ended its turn ten minutes ago" are indistinguishable from
  the outside. `muster list` plus `ls workers/*/chapter.html` distinguishes them
  in one second; nothing else does.

The alternative fix is to remove the ambiguity at the source — have
`THEME_LOCKED` say *"do not reply; begin writing now and report READY when the
file is complete"*, so acknowledging never competes with working. Both are
worth doing. Only the orchestrator-side rule, though, also catches a worker that
stalls for some reason nobody predicted, which is the whole reason there is an
orchestrator.

## Nothing here has a clock — an open design problem

The stall above was caught by a human watching. The orchestrator now holds a
production deadline (`prompts/orchestrator.md`, Step 2), which closes this
particular hole. But the deadline is held the only way this stack currently
allows, and that way is unsatisfying. **This section is a design note, not a
solved problem.**

### What is actually missing

An agent has no autonomous clock. It runs a turn, produces output, and stops.
An idle agent is not waiting — it is finished, and only an inbound message
starts it again. There is no timer, no scheduler, no wake-up.

That has a sharp consequence: **the deadline holder can never go idle.** The
orchestrator holds the clock today by staying inside one long turn, polling a
bash loop. It works — it is how the 10-minute council was held — but it binds
the clock to the one agent that has the most else to do, spends its context on
sleeping, and fails silently if that agent ever finishes its turn early.

Interruption cannot rescue this either. Tin Can's `urgent` is a no-op on every
runtime (see `runtimeSupportsUrgent`, which returns `false` unconditionally):
the only steer route was v2 `prompt`, which admits a message into a TUI-hosted
session and never runs it, so the plugin deliberately traded steering for
delivery over v1 `prompt_async`. Messages queue; a running turn always finishes.
A deadline can therefore never cut a worker off. It can only notice and
re-prompt.

### The asymmetry that rules out heartbeats

The obvious fix — have every worker emit a periodic `ALIVE` beacon, and reap
whoever goes quiet — does not work here, and the reason is worth stating
plainly.

In a game server, a client is a process that keeps running whether or not it
has anything to say, so it can always emit a heartbeat. **An agent that has
ended its turn cannot emit anything at all.** The silence and the failure are
the same event. A stalled agent cannot report its own stall, and an agent that
is deep in a legitimate 90-second generation cannot emit either — so the beacon
cannot even distinguish the two cases it exists to distinguish.

Heartbeat-by-emission is therefore the wrong shape. **Watchdog-by-observation**
is the right one: something outside the agents looks at facts the agents do not
have to produce — `muster list` state and files on disk. That is what Step 2
does.

### Borrowing the game loop

The game world's answer to "who holds the clock" is that **entities do not hold
clocks; the engine ticks them.** The main loop runs independently of every
entity, and an entity that does nothing on a tick is simply an entity that did
nothing — not a stalled system.

Applied here, the orchestrator should be a pure event-driven participant, and
the clock should live in a dumb external ticker that knows nothing about
kingdoms:

    every N seconds:
      for each worker:
        state = muster list ; file = ls workers/<w>/chapter.html
        if state == idle and no file:  nudge(worker)
      if anything has been nudged twice with no progress: tell the orchestrator

This is a **watchdog timer**, the embedded-systems pattern: the agent must show
progress before the interval expires or it gets kicked. It is also the RTS
**deterministic-lockstep turn timeout** — collect every player's input for turn
N, and when one input does not arrive inside the window, substitute an empty
input and advance rather than hanging the simulation. The council already
reinvented exactly that: a worker silent at minute 4 is recorded `NO_PROPOSAL`
and the round proceeds. Naming it makes the pattern reusable for production,
where it is currently missing.

A ticker like that needs no orchestrator and no Tin Can. Muster records each
OpenCode session's own loopback `server_url` and `session_id`, and v1
`prompt_async` on that server is the same route the Tin Can plugin already
posts to — so a ~20-line shell loop with `curl` could drive the tick with no
MCP client at all.

### What to decide before building it

- **Tick interval versus turn length.** A 20-second tick against 25-second
  generations will nudge a worker that is merely thinking. The tick must be
  long enough to never race a legitimate turn, which argues for observing
  *file mtime progress* rather than existence alone.
- **Idempotent nudges.** A queued nudge runs as a whole turn. Two nudges are
  two turns, and a worker that was already writing gets interrupted work
  queued behind it. Nudges must be safe to repeat and phrased so a worker that
  is already done treats them as a no-op.
- **Who owns escalation.** A ticker that can nudge but not judge keeps the
  creative decisions with the orchestrator, which is the point. It should
  escalate on the second failed nudge, not decide anything itself.
- **Whether the ticker is worth a process at all** for a five-agent run, or
  whether the orchestrator's bounded wait is simply the honest cost of having
  no scheduler.

None of this is implemented. The current answer is the Step 2 bounded wait, and
it works; the note is here so the next person does not rediscover the problem
from the same direction.

## A worker tried to lock the theme

During Round 1, the Embersteppe worker sent a `THEME_LOCKED` message of its
own — correctly formatted, plausible, and not its to send. The orchestrator
rejected it and warned all four in `COUNCIL_ROUND_2` to honour a lock only from
the orchestrator, so no worker acted on it and the council proceeded normally.

It is worth being precise about what this was. Nothing was compromised and no
worker was adversarial: a model handed a protocol with a `THEME_LOCKED` message
in it produced one, because the format was in its context and the moment looked
right. **A shared message vocabulary is not an authorisation model.** Any agent
can emit any message in the protocol, and a message is only as authoritative as
the recipient's willingness to check who sent it.

`prompts/worker-rules.md` now states that `COUNCIL_START`, `COUNCIL_ROUND_2` and
`THEME_LOCKED` are valid only from the named orchestrator peer, that a control
message from another worker is never authoritative however convincing, and that
a worker is a participant in the council and never its chair. Tin Can does
identify the sender of every message, so the check costs nothing — it just has
to be asked for.

## A validation check that passes without running

The orchestrator wrote itself a script for the mechanical checks, which is the
right instinct. It had two bugs, and the second is the one to remember.

The first was ordinary: it matched a bare `<title>` and so missed
`<title id="emblem-title">`, reporting that both of Embersteppe's SVGs lacked
titles. The orchestrator caught it, fixed the script, and explicitly declined to
charge the worker a repair attempt for a defect that was its own.

The second was not ordinary. The script used `/tmp` for scratch, the sandbox
blocks writes outside the workspace, and so the CSS-prefix check **silently
reported "ok" without ever executing.** A check that never runs and a check that
passes are the same output. Had that reached assembly unnoticed, Nacre's nine
unprefixed selectors — `h2`, `svg`, `.entry`, `.quote` — would have restyled all
four kingdoms in the finished atlas, and the validation log would have said
everything was fine.

`prompts/orchestrator.md` now requires proving the script runs — exercise it once
against a file known to be bad and confirm it fails — and warns that scratch
files outside the workspace die silently. The general rule is in the same
family as "check the Tin Can log rather than trusting a green suite": **verify
the instrument, not just the result.**

## What the run actually produced

One run, five agents, on the local Qwen3 30B A3B. No realm failed.

| Realm | Words | Outcome |
|---|---|---|
| Embersteppe Compact | 1,121 | passed every check; fixed its own Ashroot date and map direction |
| Asterfall | 1,762 | delivered; above band, heavy repetition |
| Verdant Choir | 1,216 | delivered; quotes the charter verbatim in its subtitle |
| Nacre Dominion | 932 | delivered; fixed its own nine unprefixed selectors; never sent READY |

The council closed at 00:07:25Z against a 00:14:58Z deadline. The vote finished
2-2 with no strict majority and was broken on canon fit, as the rules require.
No amendment was adopted — all four votes said `Amendment: NONE`, so none had
the two supporters needed.

**Claude's total contribution to the content was two mechanical map labels**: two
mislabelled compass positions in Asterfall, and one stale leftover label in
Verdant whose repair had appended a corrected map without removing the old one.
No prose was written. Nacre and Embersteppe received no orchestrator edits at
all. Three chapters ended with checks still failing — word bands, repetition,
one verbatim charter quote — and those were left failing and recorded rather
than fixed, because a chapter Claude rewrites stops being evidence of anything.

The interesting result is that the canon held. Every border fact appears in both
chapters that own it — the caravan eleven days gone from both sides, Ashroot
nineteen years old in both — across four agents that never read each other's
work and shared nothing but a brief. Nobody resolved the eclipse and nobody
invented a fifth realm. The locked premise reached four idioms a single author
would have struggled to invent separately: literal debt in Nacre's pearl
archives, a name erased with each observation in Asterfall, a sung oath in the
Compact, a first song being overwritten in the Choir. The seams between chapters
are tonal, not factual — which is the outcome the experiment was built to test.

Two limits on that claim. The atlas was verified analytically, not rendered:
fragments embedded byte-identical, tags balanced, no script or external URL, and
all 59 chapter selectors scoped to their own kingdom. And it is one run.

## A deviation from the original handoff

Each realm brief assigns a **document form** — observatory record, archive
ledger, oral testimony, annotated score. This is not in the original spec, and
it is the orchestrator-side judgment call the spec would otherwise forbid.

It is there because four identical prompts to this model returned byte-identical
output: sampling is near-greedy, so distinctiveness has to come from the prompt
rather than from temperature. The realm palettes alone move the visuals; the
document form is what moves the prose. Delete those three lines from
`prompts/realms/*.md` to run it exactly as originally specified.
