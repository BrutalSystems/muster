import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The npm that packs the tarball is pinned, and pinned in two files.
 *
 * ci.yml verifies the tarball as an early warning and publish.yml packs what
 * actually ships. Unpinned they run different npm versions — whatever the
 * matrix Node bundles, against `npm@latest` — so "verified" in one job does
 * not describe what the other produces. Tin Can hit exactly this (tincan#15):
 * the same commit packed differently under npm 10 and npm 12, because forced
 * inclusion rules differ between majors.
 *
 * A half-bumped pin is invisible: both files parse, both run, and the damage
 * is a tarball that differs from the one CI verified. So the agreement gets a
 * test rather than a convention.
 */
const repoFile = (rel: string) =>
  readFileSync(join(import.meta.dirname, "..", rel), "utf8");
const CI = ".github/workflows/ci.yml";
const PUBLISH = ".github/workflows/publish.yml";

/** The workflow-level `NPM_VERSION:` value, as written. */
function npmPin(workflow: string): string | undefined {
  return /^\s*NPM_VERSION:\s*["']([^"']+)["']\s*$/m.exec(
    repoFile(workflow),
  )?.[1];
}

test("ci.yml and publish.yml pin the same npm", () => {
  const ci = npmPin(CI);
  const publish = npmPin(PUBLISH);
  // Asserted before the comparison: two undefineds are equal, and would
  // otherwise report agreement between two workflows that pin nothing.
  expect(ci, "ci.yml has no workflow-level NPM_VERSION").toBeDefined();
  expect(
    publish,
    "publish.yml has no workflow-level NPM_VERSION",
  ).toBeDefined();
  expect(publish).toBe(ci);
});

test("the pin satisfies the trusted-publishing floor of 11.5.1", () => {
  const [major, minor, patch] = (npmPin(PUBLISH) ?? "0.0.0")
    .split(".")
    .map(Number);
  const rank = (a: number, b: number, c: number) => a * 1e6 + b * 1e3 + c;
  expect(rank(major!, minor!, patch!)).toBeGreaterThanOrEqual(rank(11, 5, 1));
});

test("both workflows install the pin they declare", () => {
  for (const workflow of [CI, PUBLISH])
    expect(
      repoFile(workflow),
      `${workflow} declares NPM_VERSION but never installs it`,
    ).toContain("npm install -g npm@${{ env.NPM_VERSION }}");
});

test("no workflow installs a floating npm", () => {
  // `npm@latest` is what publish.yml used to run: unreproducible, and nothing
  // records which npm packed a given release.
  for (const workflow of [CI, PUBLISH])
    expect(
      repoFile(workflow),
      `${workflow} installs a floating npm`,
    ).not.toMatch(/npm install -g npm@(latest|\*)/);
});

test("the engines-floor matrix does not pack", () => {
  // The floor job proves the floor: pinning npm onto its Node 22 leg would
  // exercise a combination no Node 22 user has. Packing belongs in the job
  // that pins.
  const ci = repoFile(CI);
  const matrix = ci.slice(ci.indexOf("node-version:"), ci.indexOf("package:"));
  expect(matrix, "the matrix job packs a tarball").not.toContain("npm pack");
});

/**
 * The Tin Can contract pin had the same shape of defect, and cost a release to
 * find: RELEASING.md told a human which Tin Can to test against, publish.yml
 * was what actually gated the publish, and bumping the document but not the
 * workflow was invisible — both parsed, both ran, and the release failed at the
 * contract step after the tag was already pushed. 0.9.0 failed exactly that
 * way, and 1.7.0 came within one grep of repeating it.
 *
 * The agreement is no longer asserted after the fact; it is derived. Both sites
 * compute the version from the frozen fixture's `tincan_version`, which is the
 * one place that says which Tin Can these copies describe. A pin cannot lag a
 * fixture it is computed from, so these tests guard the derivation itself —
 * reintroducing a literal version anywhere is the regression.
 */
const RELEASING = "RELEASING.md";
// The contract baseline moved out of the README when the front page was cut
// down for public reading. The guard follows the content, not the filename.
const VERIFICATION = "docs/verification.md";
const LITERAL_PIN = /@brutalsystems\/tincan@[0-9]+\.[0-9]+\.[0-9]+/;
// The exact expression, not merely the word `tincan_version`: the prose around
// these commands explains the derivation and so contains that word too, which
// means a looser check passes against a site that has stopped deriving. That
// was not hypothetical — it was caught by mutating this file's own command to
// `ver="1.6.0"` and watching an earlier version of this guard stay green.
const DERIVATION = `node -p "require('./test/fixtures/canonical-id.json').tincan_version"`;

for (const file of [RELEASING, PUBLISH, VERIFICATION])
  test(`${file} derives the Tin Can version instead of restating it`, () => {
    const text = repoFile(file);
    expect(
      LITERAL_PIN.test(text),
      `${file} hardcodes a Tin Can version; derive it from the fixture's ` +
        `tincan_version instead, or the two sites can drift again`,
    ).toBe(false);
    expect(
      text,
      `${file} no longer computes the version from the fixture, so nothing ` +
        `ties it to the contract copies actually vendored`,
    ).toContain(DERIVATION);
  });

test("the derived version is the one the vendored copies describe", () => {
  // The derivation is only worth anything if the value it reads is the value
  // the contract suite needs. This is the assertion the old pin tests made
  // about two hand-written strings, kept against the single source instead.
  const fixture = JSON.parse(repoFile("test/fixtures/canonical-id.json")) as {
    tincan_version?: string;
  };
  expect(fixture.tincan_version, "the fixture names no Tin Can").toMatch(
    /^[0-9]+\.[0-9]+\.[0-9]+$/,
  );
  expect(
    repoFile(PUBLISH),
    "publish.yml must install the derived version, not a fixed one",
  ).toContain("@brutalsystems/tincan@$");
});

test("the verification page states the baseline by derivation, not by number", () => {
  // This was the third site and it went stale unnoticed: it named 0.6.4 as the
  // verified baseline while the vendored copies described 1.6.0, so anyone
  // following it verified against a Tin Can four minors behind the fixture.
  // Restated rather than derived is the same defect the two sites above were
  // cured of, and prose restates it as easily as a command does.
  //
  // Scoped to `## Verification`: the `## Tin Can compatibility` section below it
  // records what was observed at a given Tin Can, which is a historical claim
  // and stays pinned to its version on purpose.
  const text = repoFile(VERIFICATION);
  const section = text.slice(
    text.indexOf("## Verification"),
    text.indexOf("## Tin Can compatibility"),
  );
  expect(
    section,
    "docs/verification.md has no ## Verification section",
  ).not.toBe("");
  expect(
    /Tin Can \*{0,2}[0-9]+\.[0-9]+\.[0-9]+/.exec(section)?.[0],
    "the Verification section names a Tin Can version in prose, " +
      "which drifts the moment the fixture moves; point at the fixture instead",
  ).toBeUndefined();
});
