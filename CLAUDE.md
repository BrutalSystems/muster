# Working in this repo

## Vocabulary — these are instructions, not topics to discuss

**"cut a release" / "cut"** means the whole release, through publication to npm.
Not tagging and stopping to confirm. See below for what that involves here, and
pick the bump yourself — this repo documents the answer.

**"and update globally"** means: wait for the publish run to finish, then
install the version just shipped so the `muster` on `PATH` is that version, on
whichever machines run it. Verify with `muster --version` and report what it
printed. Install only after the run completes — the registry lags a publish by
a minute or two, and an install that races it silently fetches the previous
version.

## The tag is what publishes

`package.json` shows `version` and `postversion` scripts and nothing about
publishing, so reading the scripts alone leads to "this tags but does not ship".
That is wrong. A pushed `v*.*.*` tag triggers `.github/workflows/publish.yml`,
which publishes over OIDC trusted publishing. There is no separate `npm publish`
step and no stored token. A bare `git push` publishes nothing.

## Cutting one

1. **Write the notes under `## Unreleased` in `RELEASE_NOTES.md` and commit
   them.** This is a prerequisite, not a step inside the release:
   `scripts/stamp-release-notes.mjs` exits 1 when that section is missing or
   empty rather than inventing content, so nothing is releasable until it
   exists.
2. `npm version <bump> -m "%s — <what changed>"`. The `version` hook stamps
   `## Unreleased` into `## <version> — <date>` and stages it; `postversion`
   pushes the commit and tag together.

`publish.yml` builds the release body with `--notes-file` from that section, so
the GitHub Release carries the full notes and the `-m` message becomes the tag
and commit subject. (Sibling repos without a `RELEASE_NOTES.md` use
`--notes-from-tag`, where omitting `-m` leaves the release body empty. That
failure mode does not exist here.)

**Choosing the bump** — from [RELEASING.md](./RELEASING.md): while muster is
`0.x`, the **minor is the breaking-change signal**. Bump minor only for an
incompatible interface or permission-default change; use a patch for everything
else, new features included. `muster --version`, `--plugin`/`--model` and npm
plugin specifiers all shipped as patches. This convention is specific to this
repo — the sibling repos version differently, so do not carry a rule in either
direction.

## Installing it afterwards

`postinstall` runs `scripts/prepare-pty.mjs`, which builds node-pty. npm skips
install scripts by default, and the failure is silent: `muster --version`
reports the new version while node-pty is unbuilt and the pty host cannot
launch. Either allow the scripts once —

```sh
npm install -g --allow-scripts=@brutalsystems/muster,node-pty @brutalsystems/muster@<version>
```

— or set `npm config set allow-scripts=@brutalsystems/muster,node-pty
--location=user` on that machine so later installs keep working. Note that is
user-level config shared by every project on the machine, and the key holds a
single comma-separated value that `npm config set` replaces wholesale: read it
before writing it.

## The local gate

`npm run check` is the gate, and CI runs the same script: the typecheck, the
suite, and `scripts/check-tarball.mjs`. `npm test` alone does not catch tarball
drift, because the suite imports source and never packs. Run `check`, not
`test`, before saying something passes.

## A type-only change cannot go red under vitest

When the deliverable is a **type** — a new field on `Entry`, a widened
`Pick<>`, a property added to `TaskHandle` or `SessionPeer` — the test written
for it passes before the implementation exists. Vitest strips types, and the
runtime usually already does the right thing: `Registry.reserve` spreads
`...req`, so a field it does not yet declare still lands on the entry and
round-trips to disk.

The red for those steps is `npm run typecheck` (`tsc -p tsconfig.check.json`),
which the suite has been checked against since `c4ad2b9`. Watch it fail with
the TS2353/TS2339 errors naming the new field, then watch it pass. A plan step
that writes "Expected: FAIL" against a vitest command for a type change is
wrong about its own gate, and a task that stops at the green vitest run has
proved nothing.
