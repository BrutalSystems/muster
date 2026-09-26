# Releasing Muster

Muster follows Tin Can's manual release pattern: MIT license, explicit npm
contents, build and test before publishing, and annotated version tags.

## Before you start

- Push access to `BrutalSystems/muster` and publish rights on the
  `@brutalsystems` npm scope.
- Node 22.12+, tmux, and the POSIX test prerequisites listed in README.
- The npm that packs the tarball is pinned in both workflows as `NPM_VERSION`.
  Bump `.github/workflows/ci.yml` and `publish.yml` together:
  `test/workflow-npm-pin.test.ts` fails the build when the two disagree, when
  either declares a pin it does not install, or when the pin drops below the
  11.5.1 trusted-publishing floor. A half-bump is otherwise invisible — both
  files parse, both run, and the damage is a tarball that differs from the one
  CI verified. Only the runners are pinned; your own machine wants a current
  npm for the one-time `npm trust` step.
- An independently installed Tin Can **0.6.4**, the verified contract baseline.
  It is a test prerequisite, never a Muster dependency. (0.2.0 was the baseline
  through 0.7.0's earlier release attempts; it and every version through 0.5.1
  were withdrawn from the registry by Tin Can's maintainers, and 0.5.2 held the
  baseline until 0.6.4 replaced it. Do not pin 0.6.3: its publish left the
  server on the registry without the matching plugin. See
  `CONTRACT_PROVENANCE.md` — the contract itself did not change.)

## Choosing the version

Use semver for Muster's CLI, MCP schemas, launch behavior, and configuration.
Treat incompatible interface or permission-default changes as breaking changes.

From 1.0.0, ordinary semver: **major** for an incompatible interface or
permission-default change, **minor** for a feature, **patch** for a fix.

Before 1.0.0 the minor carried the breaking-change signal and features shipped
as patches — which is why 0.7.1, 0.7.2 and 0.7.4 added `muster --version`,
`--plugin`/`--model` and npm plugin specifiers without a minor bump. That
convention ended at 1.0.0; do not carry it forward when reading old releases
into new ones.

The address format is a separate, versioned agreement with Tin Can. Changes to
slugify, suffixes, collisions, or resolution require coordinated contract work;
never silently change the frozen expectations to fix a failing test. Naming
hashes do not cover listing membership or runtime state. Verify a Tin Can
upgrade deliberately, including those behaviors when relied upon.

**Do not change `tincan_version` when bumping Muster.** It records the upstream
fixture's provenance. Muster's version belongs in `package.json` and
`package-lock.json`; the copied fixture remains frozen.

## Steps

**1. Write the notes under `## Unreleased`.**

Update `RELEASE_NOTES.md` under a `## Unreleased` heading with the concrete
behavior, compatibility constraints, known limitations, and validation. Do not
include private paths, session IDs, peer-message transcripts, or credentials.

Do not write the version or date yourself: step 4 stamps the heading into
`## <version> — <date>`. `publish.yml` extracts that section and fails if it is
missing, empty, or still reads as unreleased, so a forgotten note stops the
release rather than shipping without one.

**2. Build and test.**

```sh
npm ci
npm run check
contract_dir=$(mktemp -d)
ver=$(node -p "require('./test/fixtures/canonical-id.json').tincan_version")
npm install --prefix "$contract_dir" --no-save "@brutalsystems/tincan@$ver"
MUSTER_TINCAN_BIN="$contract_dir/node_modules/.bin/tincan" npm run test:contract
```

**Do not substitute a literal version into that install.** The contract
baseline is derived from the frozen fixture's `tincan_version`, here and in
`publish.yml`, because that field is the single place recording which Tin Can
the vendored copies describe. Writing the number out again recreates the defect
that made v0.9.0 an inert tag — this document moved and the workflow did not,
and the contract step failed after the tag was pushed. `npm run check` fails if
either site hardcodes a version again.

`npm run check` builds, runs the suite, then packs and verifies the tarball
with the same script CI uses — `npm test` alone never packs, so tarball drift
would not surface here. It uses fake runtimes, no real models. The separate
contract suite must pass all four cases, comparing durable IDs and delivery
through the installed Tin Can process. A skipped or unavailable contract suite
is not release verification.

**3. Inspect the source and actual package.**

```sh
git diff --check
npm pack --dry-run
npm pack --pack-destination /path/to/release-staging
```

The package allowlist is `dist/`, the required `scripts/prepare-pty.mjs`
postinstall helper, README, both license notices, the naming specification and
provenance, and the frozen naming fixture. npm also includes `package.json`.
No implementation notes, probes, logs, credentials, source tests, or other
local state belong in the tarball. The postinstall helper must ship: node-pty's
macOS executable bit needs repair on the tested dependency version.

Install the tarball into an empty temporary prefix and run its `muster --help`.
Check that CLI/MCP entry points and the pty helper work from the package, without
a source checkout or dev dependencies. Review all files and commit metadata
that will become public, not only the latest diff. `.gitignore` cannot remove
sensitive data from existing Git history.

**4. Commit the change, then version it.**

```sh
git commit -am "<the change, plus its release notes section>"
npm version patch -m "%s — <what changed>"
```

`npm version` runs the `version` hook first, which stamps the `## Unreleased`
heading into `## <version> — <date>` and stages `RELEASE_NOTES.md` so it lands
in the version commit. It then updates both package files, commits, and creates
the annotated tag; `postversion` runs `git push origin HEAD --follow-tags`,
pushing the commit and its tag together. The tag is what triggers
`publish.yml` — a bare `git push` publishes nothing.

If `RELEASE_NOTES.md` has no `## Unreleased` section, or it is empty, the stamp
fails and no tag is created. That is deliberate: failing here is recoverable,
whereas failing in CI means deleting and re-pushing a tag.

Push only the intended branch and tag. Never use `--all` or `--mirror`: local
private implementation-history branches are not part of the public project.
Use a GitHub noreply email for commits if you do not want a personal address
published. Preserve required copyright and vendored attribution notices.

**5. Publishing happens in CI, on the tag.**

Pushing the tag from step 4 triggers `.github/workflows/publish.yml`, which
checks the tag against `package.json`, extracts the release notes, builds,
runs the ordinary and contract suites, packs, verifies the tarball contents,
smoke-tests it, publishes with `npm publish --provenance`, verifies the
published artifact matches what was tested, and creates the GitHub Release.

It authenticates over OIDC trusted publishing: `id-token: write` plus the
`npm` environment, with no stored npm token. Do not put tokens in this
repository, release notes, shell scripts, or command output; `.npmrc` and
`.env*` are ignored as a backstop.

`publishConfig.access` is public. `prepublishOnly` runs the ordinary suite,
including its build; `prepack` rebuilds the distribution. Re-running on an
already-published version skips cleanly rather than failing.

Publishing by hand should not be necessary. If you ever must, the workflow is
the specification for what has to pass first.

**6. Verify the published artifact.**

```sh
npm view @brutalsystems/muster@0.1.0 version dist.integrity
npm pack @brutalsystems/muster@0.1.0 --pack-destination /path/to/release-staging
```

Inspect and smoke-test the registry tarball, then mark the release notes as
published. If using GitHub Releases, use the same version tag and notes.
Publishing to npm and creating a GitHub release are explicit release actions;
preparing this repository does not perform either.

## Installation authority

**Installed deliberately, in the one session that should hold spawn authority —
never at user scope.** Publication does not change this rule. Keep the README's
session-scoped setup, Claude's operator-approved directory trust prerequisite,
and the Tin Can/Muster authority boundary in the release notes. Do not copy
Tin Can's global installation instructions into Muster.
