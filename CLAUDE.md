# Working in this repo

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

**Choosing the bump** is in [RELEASING.md](./RELEASING.md): from 1.0.0,
ordinary semver, with a **minor** for a feature and a **patch** for a fix. The
`0.x` rule, under which features shipped as patches, ended at 1.0.0. Do not
read old releases into new ones, and do not carry a rule over from the sibling
repos, which version differently.

## Installing it afterwards

npm skips install scripts by default, and muster's `postinstall` builds
node-pty. Skipping it fails silently: `muster --version` reports the new
version while the pty host cannot launch. The README's quick start carries the
install line that allows them; use that, not a bare `npm install -g`.

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
