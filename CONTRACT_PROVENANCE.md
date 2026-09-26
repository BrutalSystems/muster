# Tin Can contract provenance

Copied verbatim from `https://github.com/BrutalSystems/tincan` at commit
`fbaaea5842fd4a5c86849d7f51c8e16b8683b058` on 2026-09-19.
The contract describes `@brutalsystems/tincan` version `0.1.0`.

| File | SHA-256 |
| --- | --- |
| `CANONICAL_ID.md` | `8cf4312d6af1c4d85ec0641d8739bec261be2feb35dd16bdd9d8be2b89551915` |
| `test/fixtures/canonical-id.json` | `47fb41fe62efaab6d9ecc7a77623fb2761f79829faf8bcd67c6e54bc4414b751` |

Both copies were verified byte-for-byte against the clean source checkout.
The fixture contains 31 cases: 8 slugify, 6 suffix, 7 assignment, 10 resolution.

Tin Can's fixture runner compares refusal candidates after sorting both arrays;
candidate ordering is not asserted by the fixture. Preserve duplicate candidates.
CLI runtime `claude` maps to address runtime `claude-code`.

Known defects are intentionally preserved: non-unique canonical IDs,
unnamed versus empty-slug display differences, and empty-input resolution.
See the normative document for exact behavior.

## Compatibility check against Tin Can 0.2.0

On 2026-09-19, verified source commit
`3f13fdcc9ac1246b2e5707b6a44f0cf8d207899f`: Claude `peers` now emits
`session_id`; Codex emits `thread_id`. The integration test must compare those
durable fields directly, in addition to verifying message delivery.

The four fixture case arrays are identical to our 0.1.0 copy. The upstream
fixture version is now 0.2.0; that metadata change is not a naming change.
Our original frozen files remain unchanged. Their full-file hashes above
detect local edits; they must not be compared to an entire newer upstream
fixture to infer a format change.

For case comparison, SHA-256 of UTF-8 `JSON.stringify` applied to an object
with the keys `slugify`, `suffix`, `assign`, `resolve` in that order is:
`a92936ef4b713641d29da3fbafccab0e6da79a54e27bfea3c6a779e801a925b3`.
Both revisions produce this hash.

## Privacy remediation edit — 2026-09-20

`test/fixtures/canonical-id.json` originally copied a real internal project
codename as an example `rawName`/`display`/`canonicalId` value. Tin Can made
the same change to its own copy and asked Muster to match; both projects
renamed the same two example strings to a neutral placeholder
(`billing-api`).

This is a **local text edit to the frozen 0.1.0 copy**, not a re-sync with
Tin Can's current upstream fixture. By the time of this edit, Tin Can's
fixture had moved to `tincan_version: 0.5.2` and gained real new content —
`opencode` suffix rules, new fixture cases, and new `CANONICAL_ID.md`
sections describing opencode session-id behavior. Muster's OpenCode
integration explicitly defers Tin Can/address-format work (see
`RELEASE_NOTES.md`), so adopting that upstream fixture wholesale would claim
verification Muster does not have. Per this document's own earlier
guidance — "their full-file hashes ... must not be compared to an entire
newer upstream fixture to infer a format change" — only the two leaked
strings were changed; every other byte of the 0.1.0-vintage fixture is
unchanged, including its 31 cases and `tincan_version: 0.1.0`.

New hash after this edit:

| File | SHA-256 |
| --- | --- |
| `test/fixtures/canonical-id.json` | `974cef9e06370a562cef588f1cd6d5c1d83b49afdb64808487759d6280bffff2` |

`CANONICAL_ID.md`'s hash is unchanged (`8cf4312d6af1c4d85ec0641d8739bec261be2feb35dd16bdd9d8be2b89551915`)
— the codename never appeared there.

Adopting Tin Can's opencode naming rules, if Muster's OpenCode/Tin Can
integration is ever un-deferred, is a separate, deliberate compatibility
check — not something this edit performs.

The `at commit fbaaea5842fd4a5c86849d7f51c8e16b8683b058` provenance line
above may no longer resolve in Tin Can's current history: Tin Can applied
the same codename remediation via a history rewrite (`git filter-repo
--replace-text`, force-pushed), which changes the hash of every commit
whose content or ancestry it touched. This is a historical acquisition
record, not a claim that the commit is still reachable.

## OpenCode v2 prompt endpoint: closed as routed around, not diagnosed

Status as of 2026-09-20. Recorded because the underlying behaviour is not
fixed, only avoided, and because the investigation produced three confident
wrong answers before a right one. Deliberately not filed upstream.

**Reproduced, with neither Muster nor Tin Can involved.** POST to the v2
`/api/session/{id}/prompt` of a TUI-hosted OpenCode 1.18.31 session returns 200
with an `admittedSeq`; a drain fires about 68ms later; the turn dies with
`ModelUnavailableError` naming the session's own model. The TUI path resolves
that same model string, in the same process, seconds either side:

    20:42:30  stream providerID=fireworks-ai modelID=...qwen3p8-max   (TUI turn)
    20:42:54  ERROR Failed to drain Session
              ModelUnavailableError: fireworks-ai/...qwen3p8-max      (delivered)

Observed across 14 distinct TUI-hosted sessions, 20 failures, two unrelated
providers, no successes. An `opencode serve` session drains and resolves its
model normally, failing only on an unrelated HTTP 401 — a strictly later stage.
The v1 `/session/{id}/prompt_async` route runs turns on the same TUI sessions.

**Not established.** That the drain path "cannot resolve the model" is a
reading of an error string, not a claim from source. Nobody has read OpenCode's
drain path the way its scheduling path was read. Two loose ends would weaken a
report: a session that suffered a v2 failure appeared to stop running anything
afterwards, including v1 calls that had worked moments earlier — one
observation, never isolated, and if v2 failure corrupts session state then the
20 failures are fewer independent events than the count suggests. And the
`serve` control differed in credentials as well as host type.

**Theories that were asserted and disproved**, kept because each looked
convincing: that OpenCode never scheduled the turn (the drain fires, visibly);
that the model was cold (TUI success and drain failure alternate 17-24s apart
on one model); that Muster-supplied inline providers were invisible to the
drain (a globally authenticated provider fails identically). Each was killed by
a control that could have been run first.

**Why it is closed.** Tin Can 0.6.0 delivers over v1, which works, so nothing
in Muster or Tin Can depends on the v2 path. A report resting on an inferred
mechanism is one a maintainer would reasonably bounce, and the cost of
diagnosing it properly is not worth paying for a route neither project uses.
If someone wants to reopen it, the missing step is reading the drain's
model-resolution path in OpenCode 1.18.31.

## Contract baseline moved to 0.6.4 — 2026-09-20

Re-pinned from `0.6.0`. The suite was run against a real installed
`@brutalsystems/tincan@0.6.4` and passed all four cases; 0.6.4's
`canonical-id.json` was compared case by case with Muster's frozen copy and
every pre-existing case is present with an unchanged expectation, with the same
four additive opencode-specific cases introduced in 0.5.7. Naming is untouched.

The intervening releases are about how the OpenCode plugin is delivered rather
than about the address contract: 0.6.1 published the plugin as its own package,
0.6.2 corrected its entry points so OpenCode's loader can actually execute it,
and 0.6.4 fixed the publish ordering described below.

**Do not pin `0.6.3`.** Its publish run put the server on the registry and then
failed a post-publish verification with `ETARGET` — `npm view` had already
answered for the version while `npm pack` still 404'd — and the plugin publish
behind that check was skipped. So `@brutalsystems/tincan@0.6.3` exists and
`@brutalsystems/tincan-opencode@0.6.3` does not. The tag was deliberately not
moved, because the 0.6.3 server build is published with provenance pointing at
that commit. 0.6.4 publishes both halves before any post-publish check.

Muster's own pipeline already tolerates that lag: `Confirm published` polls for
five minutes, and `Verify the published artifact` retries and then warns rather
than failing when the tarball is not yet downloadable, failing only on a real
file-list difference.

## Contract baseline moved to 0.6.0 — 2026-09-20

Tin Can 0.6.0 changes the endpoint it delivers to on the opencode leg, from the
v2 `/api/session/{id}/prompt` to the v1 `/session/{id}/prompt_async`, and the
change resolves the failure described in the 0.5.9 entry below. It is a minor
rather than a patch because `urgent` was removed as a capability: the v1 route
has no equivalent of v2's steer/queue distinction, so rather than accept it and
ignore it, Tin Can now reports urgent as unsupported on every runtime. Muster
never referenced that capability, so nothing here changes.

Muster's contract suite was run against a real installed
`@brutalsystems/tincan@0.6.0` and passed all four cases. Naming is untouched:
0.6.0's `canonical-id.json` was compared case by case with Muster's frozen copy
and every pre-existing case is present with an unchanged expectation, with the
same four additive opencode-specific cases introduced in 0.5.7.

Verified end to end rather than by the suite alone: a Muster-launched OpenCode
session in a terminal received a Tin Can message, ran the turn, and replied to
the sending Claude Code session. The OpenCode log for that session shows a
started loop and a resolved model with no `Failed to drain` line, which is the
signature the 0.5.9 entry documents as the failure.

One operational trap worth recording, because it makes a working setup look
broken: the OpenCode plugin is a **copy on disk** under
`~/.config/opencode/plugin/`. Updating the npm package does not update it, and
a stale plugin keeps posting to the old v2 route. The peer registry records
`plugin_version`; confirm it matches the installed package before trusting a
delivery result.

## Contract baseline moved to 0.5.9 — 2026-09-20

Re-pinned from `0.5.7`, skipping a separate `0.5.8` pass, because the `notice`
text moved twice in one afternoon while the underlying mechanism was being
isolated: 0.5.7 described it as never scheduled, 0.5.8 as a warmth problem,
0.5.9 states what was actually observed. Both earlier descriptions were wrong.

Muster's contract suite was run against a real installed
`@brutalsystems/tincan@0.5.9` and passed all four cases.

0.5.9 changes the `notice` text on `send_peer` results and widens it from idle
opencode peers to all opencode peers. It does not touch naming: 0.5.9's
`canonical-id.json` was compared case by case with Muster's frozen copy, and
every pre-existing case in `slugify`, `suffix`, `assign` and `resolve` is
present with an unchanged expectation, with the same four additive
opencode-specific cases 0.5.7 introduced.

The reason for the churn is worth recording, because Muster's own evidence
caused it. Muster reported that inbound Tin Can delivery to an idle
TUI-hosted opencode session was admitted but never scheduled, and 0.5.7's
notice encoded that mechanism. The opencode log disproves it: a session idle
since 20:00:13 was woken 68ms after admission at 20:01:13 and ran the drain,
which then failed with `ModelUnavailableError` on a local model. Fourteen of
the seventeen `Failed to drain` lines in that log name the same local model.
Admission does schedule execution, exactly as the endpoint documents; the
turn died afterwards. Muster's `opencode serve` control did not separate host
type from model resolution, because it used different credentials and failed on
an unrelated 401.

The mechanism was subsequently isolated, and it is neither scheduling nor model
warmth. In every TUI-hosted opencode session observed, the drain path failed to
resolve the session's model, while the TUI path resolved the same model in the
same process seconds either side of it:

    20:42:30  stream providerID=fireworks-ai modelID=...qwen3p8-max   (TUI turn)
    20:42:54  ERROR Failed to drain Session
              ModelUnavailableError: fireworks-ai/...qwen3p8-max      (delivered)

That run was stock opencode 1.18.31 with no Muster involvement, no overlay, and
a globally authenticated provider, so it is not a Muster defect and not
specific to Muster-supplied providers.

Observed across 14 distinct TUI-hosted sessions and 20 failures, under two
unrelated providers (`muster-local` and `fireworks-ai`). No TUI-hosted drain
was observed to succeed. The contrasting case is an `opencode serve` session,
whose drain resolved its model and reached the provider, failing only on an
unrelated HTTP 401 — the model resolution itself worked there. That is what
localises this to TUI-hosted sessions. It is a consistent observation on
1.18.31, not a proof about every configuration.

What remains true for callers is narrower: a caller cannot confirm that an
opencode peer acted on a message, because a turn that dies after admission is
indistinguishable from outside from one that succeeded.

## Contract baseline moved to 0.5.7 — 2026-09-20

Re-pinned from `0.5.2` to `@brutalsystems/tincan@0.5.7`, deliberately rather
than by drift: 0.5.2 was three releases behind and no longer what anyone runs.

Muster's contract suite was run against a real installed
`@brutalsystems/tincan@0.5.7` and passed all four cases.

The intervening releases are additive on this contract. 0.5.6 added a `notes`
array to the `peers` result and changed tool description text; 0.5.7 added a
`notice` field on `send_peer` results for idle opencode peers, reporting that a
message is durably admitted but that execution cannot be confirmed on that leg.
Neither touches naming.

Verified against the artifact rather than assumed: 0.5.7's
`test/fixtures/canonical-id.json` was compared case by case with Muster's
frozen copy. Every pre-existing case in `slugify`, `suffix`, `assign` and
`resolve` is present with an unchanged expectation. 0.5.7 adds four cases, all
opencode-specific — one `suffix` case for opencode session ids, three `assign`
cases for opencode peers and slug collisions between them. Nothing was modified
or removed.

Muster's own fixture stays frozen at `tincan_version: 0.1.0` with its 31 cases.
That is the point of the design: frozen expectations are checked against a live
installed binary, so the suite detects drift rather than absorbing it.

## Contract baseline moved to 0.5.2 — 2026-09-20

`@brutalsystems/tincan@0.2.0`, this document's verified baseline, was
withdrawn from the npm registry as part of Tin Can's own codename
remediation (every version through 0.5.1 carried the same leaked string
0.7.0's fixture did, in Tin Can's README and fixture). Withdrawn version
numbers cannot be republished. This is a **registry availability problem,
not a format change** — Tin Can diffed `src/naming.ts` between 0.2.0 and
0.5.2 and found `slugify`, `suffixOf`, `assignNames`, and `resolvePeer`
byte-identical; the only source change is the `RuntimeName` union widening
to add `'opencode'`. `test/fixtures/canonical-id.json` gained new opencode
cases with every pre-existing expectation unchanged.

Muster's own contract suite was run against a real installed
`@brutalsystems/tincan@0.5.2` and passed all four cases before this
re-baseline was made.

`0.3.0` through `0.5.1` were never verified by Muster's contract suite (see
"Upgrade boundary" below) and have also been withdrawn from the registry.
The verified, currently-available set is exactly `{0.5.2}`.

One caveat for anyone reconstructing a baseline from Tin Can's git history
rather than a published artifact: Tin Can's git tags predating 2026-09-20
no longer match what npm ever served at that version number, because the
history-rewrite in the section above applies retroactively to every commit,
tagged ones included. Git content at an old tag is not evidence of what a
withdrawn npm artifact actually contained.

## Upgrade boundary: listing and state

The upstream release notes report that 0.3.0 expands
Codex-hosted listings to both runtimes and 0.3.1 corrects Codex status decoding.
These releases have not been verified by Muster's contract suite. The tested
baseline is 0.5.7; README installation instructions pin it outside Muster's
dependency tree.

Inspection confirms the contract test does not assert total peer counts,
same-runtime exclusion, or Tin Can state. Its count assertion applies only to
the matching canonical ID in the isolated test environment. Naming hashes do
not cover listing membership, self-exclusion, or state semantics. A future
upgrade must test these behaviors separately where relied upon.

## Re-sync to Tin Can 1.5.1 — 2026-09-24

Both contract copies were replaced wholesale from Tin Can at tag `v1.5.1`,
commit `b62ca6a719131dbd1b43875fa47604c1c17cd9fb`. This ends the 0.1.0-vintage
freeze described above: Muster had never been verified against any Tin Can 1.x,
and the contract suite passed only because `RELEASING.md` pinned it to 0.6.4.

| File | SHA-256 |
| --- | --- |
| `CANONICAL_ID.md` | `7ec8857238262ff49277488a515f830078df25451cff11dad69c0b6aa820dfa5` |
| `test/fixtures/canonical-id.json` | `dde6ce24bf259fc0a44685f08fc724232968cd9ec3c839802cd2b37de702a85a` |

The fixture carries `tincan_version: 1.5.1` and 39 cases: 8 slugify, 7 suffix,
12 assignment, 12 resolution. These hashes are the same numbers asserted by
`test/naming.test.ts` ("contract copies remain frozen"); the two sites must
always agree, and the earlier divergence between this document's recorded
fixture hash and the test's is what #48 reports.

**Why the tag and not HEAD.** Tin Can's HEAD was one commit past `v1.5.1` when
this was copied, and the three contract-relevant files were byte-identical
between the two — confirmed from both sides. HEAD has since gained a 40th
resolve case, but the fixture's `tincan_version` still reads 1.5.1 because
those version sites only move on a cut. Copying HEAD and recording it as 1.5.1
would manufacture exactly the provenance confusion this document exists to
prevent, so the tag is the acquisition point and the 40th case is a follow-up.

**What the 40th case is, and why it matters here.** It freezes a known defect
Muster reported upstream and Tin Can confirmed as
[tincan#39](https://github.com/BrutalSystems/tincan/issues/39): a full name
that is a prefix of a longer full name resolves to the longer one once the
exactly-named session has gone — `muster` lands on `muster-b1`. Tin Can chose
to document it rather than change resolution, because no rule can separate it
from fixture case [4] (`auth` resolving to `auth-refactor`) using anything a
peer listing carries; an implementation of the stricter rule failed both the
new case and the existing one. Muster reimplements resolution, so it inherits
the defect by construction. Adopt the frozen case when it is cut; do not
special-case it locally, because a local rule is drift by another name.

`canonical_id` is the form that cannot misroute — resolution matches it
exactly and never by prefix. Prefer it over a bare name wherever a durable id
is already in hand.

## Superseded same day: re-sync to Tin Can 1.6.0 — 2026-09-24

The 1.5.1 acquisition above **never shipped**. Its release, 0.9.0, failed in CI
before publishing (see below), and Tin Can cut 1.6.0 while that was being
fixed. The copies are now from tag `v1.6.0`, commit
`3d66ceaa718a098bb9e962282d901aff03dd47ff`.

| File | SHA-256 |
| --- | --- |
| `CANONICAL_ID.md` | `06dd8afe83fa641183fb44b2625dbc684c2bed13c9ac5c8f51a6c1206a00da3e` |
| `test/fixtures/canonical-id.json` | `a574fe291a515d920aab07f29629100caadb4fc8d8e8130a0851559bf2384aac` |

`tincan_version: 1.6.0`, 40 cases: 8 slugify, 7 suffix, 12 assignment, 13
resolution. This removes the compromise the 1.5.1 section describes — the
fixture is now labelled for the release that contains it, so the acquisition
point and the version metadata agree, and no follow-up is outstanding.

The 40th case freezes the prefix-resolution defect
([tincan#39](https://github.com/BrutalSystems/tincan/issues/39)) that Muster
reported. `naming.ts`, written against the 39-case fixture, passes it
unchanged — no expected value moved, so this is not an address-format change.

**The case was verified to have teeth rather than assumed to.** A case that has
never failed has not been shown to test anything. Implementing the stricter
rule it documents — refuse a prefix that ends at a segment boundary — fails the
new case *and* `resolve: unambiguous prefix resolves` together, in this copy.
That pair failing together is the argument for Tin Can's decision to document
the defect rather than change resolution, and it reproduces here.

## Re-sync to Tin Can 1.7.0 — 2026-09-24

The copies are now from tag `v1.7.0`, commit
`f2aaeb20ea278c229afe955db59f69301fc6626f`.

| File | SHA-256 |
| --- | --- |
| `CANONICAL_ID.md` | `8d5e93894e5c43cc854330f7b64ebbdcc450649cfa910c8b4015edf2559125e7` |
| `test/fixtures/canonical-id.json` | `1db118b22484271932e7cde33c1c80b469563f18f2961532d6910d79ce1e4c3b` |

`tincan_version: 1.7.0`, still 40 cases: 8 slugify, 7 suffix, 12 assignment, 13
resolution. **No expected value moved and no case was added.** Diffed
`v1.6.0..v1.7.0` upstream before copying: `src/naming.ts` does not appear in the
diff at all, the fixture's only changed line is its `tincan_version`, and
`CANONICAL_ID.md` gains fourteen lines of warning with no normative change. So
`naming.ts` is untouched here and the contract suite is expected to stay 4/4
without it — this is a re-label plus a doc, not an address-format change.

What the doc gains is the hazard this repo hit and reported: recovering the
three-hex suffix by taking a canonical id's last dot-separated segment returned
the suffix before 1.0.0 and returns the whole uuid now, so every qualified
`slug.suffix` address resolves as `unknown` — a missing peer, not a malformed
address, which is why it stayed quiet here until a test was written for it.
Tin Can names Muster as where it was found. The rule is to derive the suffix
from the uuid via `suffixOf` and otherwise pass a canonical id along whole
rather than parse fields out of it.

**A re-sync touches three sites, not two.** Both Tin Can pins —
`RELEASING.md` and `.github/workflows/publish.yml` — plus the SHA-256 drift
hashes in `test/naming.test.ts` ("contract copies remain frozen"), which must
move whenever a copied file changes. The two pins are the ones handed down in
conversation; the hashes were found by grepping for the old version and the old
digests rather than by working from that list, so grep the repo instead of
trusting an enumeration. That advice earned itself twice over: this very
enumeration missed `README.md`, which carried a literal baseline of its own —
recorded below.

Moving only the first pin is what made v0.9.0 an inert tag that published
nothing. `test/workflow-npm-pin.test.ts` now fails when the two pins disagree,
or when the `publish.yml` pin and the fixture's `tincan_version` disagree, and
that guard was re-confirmed by mutation here rather than assumed: reverting
`publish.yml` alone to 1.6.0 fails both assertions, and restoring it passes
them. A stale drift hash fails `npm run check` on its own.

### The pin sites became one derived value

Recording the fix rather than only the incident. The two Tin Can pins no longer
restate a version; both compute it from this fixture's `tincan_version`. That
field is the single place saying which Tin Can the vendored copies describe, so
a pin can no longer lag it — the v0.9.0 failure class is closed structurally
instead of guarded after the fact.

The guard that replaced the old agreement tests asserts the derivation
expression itself, not the word `tincan_version`. The first version of it
checked for the word and **passed against a `publish.yml` whose command had
been mutated to `ver="1.6.0"`**, because the prose explaining the derivation
contains that word too. It was caught by running the mutation rather than by
reading the test. A guard that cannot fail is the thing this document exists to
prevent, so the failure is written down next to the fix.

### README.md was a fourth site, and had already gone stale

The enumeration above missed it. `README.md`'s Verification section named its own
baseline — **Tin Can 0.6.4** in prose, and `@brutalsystems/tincan@0.6.4` in a
copy-paste command — and had drifted unnoticed while the vendored copies moved to
1.6.0 and then 1.9.2. Nothing failed, because it gates nothing: it is
instructions for a human, so the cost was silence rather than an inert tag.

That makes it worse than a failing pin, not better. Anyone following the README
installed a Tin Can four minors behind the one the fixture describes and watched
the contract suite pass 4/4 — which reads as confirmation that the contract holds
at a version nobody vendored.

Fixed the same way as the other two sites: the command derives `ver` from the
fixture, and the prose points at `tincan_version` rather than naming a release.
`test/workflow-npm-pin.test.ts` now includes `README.md` in the derivation loop,
and adds one assertion that its Verification section names no Tin Can version in
prose at all, because prose restates a pin as easily as a command does. Both were
watched failing against the stale README before anything was changed — the
literal-pin assertion on the command, and `expected 'Tin Can 0.6.4' to be
undefined` on the prose — and the derived command was then extracted from the
README and run end to end, installing 1.9.2 and passing the contract suite 4/4.

The prose assertion is scoped to `## Verification` on purpose. Elsewhere the
README records what was observed at a particular Tin Can — "Tin Can 0.6.0
delivers over v1, so nothing here depends on the v2 path" — which is a historical
claim and stays pinned to its version deliberately. A whole-file regex would fail
on those and teach the next person to delete the guard.

## Re-sync to Tin Can 1.9.2 — 2026-09-25

Copies are from tag `v1.9.2`.

| File | SHA-256 |
| --- | --- |
| `CANONICAL_ID.md` | `6e0dde03154956a480ae59f4d31b727ecc5a9e735c185fed6e4445f2574263a9` |
| `test/fixtures/canonical-id.json` | `b91406e068f6bec18629a4d2b9e91bc4d2e5a0487e4b6b4534fd5ba37c7f617a` |

`tincan_version: 1.9.2`, still 40 cases. Diffing `v1.7.0..v1.9.2` upstream, the
ONLY change across all three contract files is the version string in two lines —
`naming.ts` does not appear, and no fixture case or expected value moved. 1.8.0
(log chaining, arrival record), 1.9.0 (version reporting in `peers`), 1.9.1 and
1.9.2 (registration drift) do not touch the address format. Verified here rather
than taken from upstream's word: they explicitly said not to treat their summary
as a re-copy signal.

**This re-sync needed no pin edit.** The pins derive from `tincan_version`, so
updating the fixture moved CI on its own — the first cut where the failure class
that produced v0.9.0 had nothing to act on. The drift hashes still moved, which
is the third site behaving exactly as documented above.
