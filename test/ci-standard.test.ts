import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Self-consistency checks on this repo's own copy of the CI/CD standard.
 *
 * The three repos that carry this file are independent: nothing here reads
 * another repository, and nothing here can fail because a sibling moved. That
 * rules out catching semantic drift between copies — no self-contained check
 * can — but the drift that actually happened three times in one week was
 * mechanical: wording left over from when there were two repos, and
 * repo-specific facts written as ordinary prose where a reader cannot tell
 * them from shared standard.
 *
 * An unmarked local fact is the failure the marked form exists to prevent,
 * and the convention had a one-in-three compliance rate in the file that
 * invented it. A convention adopted without a check is an intention.
 */
const standard = readFileSync(
  join(import.meta.dirname, "..", "docs", "ci-cd-standard.md"),
  "utf8",
);
/** Blockquote markers removed, so a sentence wrapped inside one still reads
 *  as a sentence. Prose assertions run against this; line-level ones do not. */
const prose = standard.replace(/^\s*>\s?/gm, "");

/**
 * A check tuned to the sentence it caught is worthless: that sentence is
 * deleted and will not return in that form, while the same claim reworded
 * walks straight past. So risky phrases are allowlisted by JUSTIFIED USE —
 * every occurrence must match a reason recorded here, and prose nobody has
 * written yet has to justify itself rather than merely differ from the corpse.
 */
function unjustified(text: string, risky: RegExp, allowed: [RegExp, string][]) {
  return text
    .split("\n")
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => risky.test(line))
    .filter(([, line]) => !allowed.some(([ok]) => ok.test(line)))
    .map(([n, line]) => `${n}: ${line.trim()}`);
}

test("no language presupposing two repositories", () => {
  // Generalised past the phrases that were actually there: any counting word
  // qualifying the repo noun. "Two workflows per repository" is untouched,
  // because there the count qualifies the workflows.
  const twoish =
    /\b(both|either|two|the other)\s+(?:of\s+the\s+)?(repos?|repositor(?:y|ies))\b/i;
  expect(unjustified(prose, twoish, []), "language assuming two repos").toEqual(
    [],
  );
});

test("the file asserts no sameness between the copies", () => {
  // The word cannot simply be banned: the file legitimately DENIES sameness.
  // So each occurrence must be a justified use, and a new assertion is not.
  const sameness = /\b(identical|identically|in sync|say the same thing)\b/i;
  const allowed: [RegExp, string][] = [
    [/no claim that they are identical/i, "the denial this file is built on"],
  ];
  expect(
    unjustified(prose, sameness, allowed),
    "an assertion that the copies match",
  ).toEqual([]);
  // And the positive form must still be there, so the denial cannot be
  // deleted wholesale to make the check above pass.
  expect(prose).toMatch(/copies will\s+diverge/i);
});

test("every npm@latest mention is a justified use", () => {
  // The standard forbids a floating npm in the pipeline, so a present-tense
  // claim that this repo uses one is a contradiction. Four uses are justified.
  const allowed: [RegExp, string][] = [
    [/do not use/i, "the rule itself"],
    [/a repository running/i, "a hypothetical repository, not this one"],
    [
      /Before it, the release ran|no CI run had exercised/i,
      "past tense: why the pin exists",
    ],
    [
      /^npm install -g npm@latest$/,
      "the one-time npm trust step, on a person own machine",
    ],
  ];
  expect(
    unjustified(standard, /npm@latest/, allowed),
    "unjustified npm@latest mention",
  ).toEqual([]);
});

test("every repo-specific note uses the marked form", () => {
  // Prose naming this repo inside a paragraph is indistinguishable from
  // shared standard. The marked form is greppable; that is the whole point.
  const marked = /^\s*>\s\*\*Repository-specific, [a-z0-9-]+\.\*\*/;
  const offenders = standard
    .split("\n")
    .map((line, i) => [i + 1, line] as const)
    .filter(
      ([, line]) =>
        /\bmuster(?:'s)?\b/i.test(line) &&
        !marked.test(line) &&
        !line.trimStart().startsWith(">") &&
        !line.includes("BrutalSystems/muster") &&
        !line.includes("github.com/BrutalSystems"),
    );
  expect(
    offenders.map(([n, l]) => `${n}: ${l.trim()}`),
    "repo-specific prose outside a marked note",
  ).toEqual([]);
});

test("the agreed section set is present", () => {
  for (const heading of [
    "## Publishing uses OIDC, never a token",
    "### npm version floor",
    "## Fork guard",
    "## Pipeline order",
    "## `scripts/verify-tarball.mjs`",
    "## One-time setup, per package",
    "## Releasing",
  ])
    expect(standard, `missing section: ${heading}`).toContain(heading);
});

test("the fork guard is defined once, under its own heading", () => {
  // It was a sentence inside Pipeline order, and that is where a duplicated
  // paragraph hid for months. Lifting it out must not leave it in both.
  //
  // Asserting the PHRASE is absent from Pipeline order would be the obvious
  // check and the wrong one: it forbids a cross-reference, which is how a
  // reader gets from the pipeline to the section, and pushes the file toward
  // restating the condition rather than pointing at it. Assert on the
  // definition instead.
  const definition = /if:\s*github\.repository\s*==/;
  const hits = standard.split("\n").filter((line) => definition.test(line));
  expect(
    hits,
    "the fork guard condition is written more than once",
  ).toHaveLength(1);

  const all = standard.split("\n");
  const at = all.findIndex((line) => definition.test(line));
  const heading = all
    .slice(0, at)
    .reverse()
    .find((line) => line.startsWith("## "));
  expect(
    heading,
    "the fork guard definition sits under the wrong heading",
  ).toBe("## Fork guard");
});

/** The job body, from its key to the next key at the same indent. */
function job(workflow: string, name: string): string {
  const start = workflow.indexOf(`\n  ${name}:`);
  if (start < 0) return "";
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {2}\w[\w-]*:/);
  return next < 0 ? rest : rest.slice(0, next);
}

test("what the standard claims about this repo's workflows is true of them", () => {
  // The third drift class, and the one the checks above cannot see: prose
  // describing this repository's own pipeline, quietly falsified by a later
  // change to the workflows it describes. Still self-contained — it reads this
  // repo's .github/workflows and no sibling.
  const read = (p: string) =>
    readFileSync(join(import.meta.dirname, "..", p), "utf8");
  const ci = read(".github/workflows/ci.yml");
  const publish = read(".github/workflows/publish.yml");
  const pin = "npm install -g npm@${{ env.NPM_VERSION }}";

  // "A separate job pins npm and runs scripts/verify-tarball.mjs"
  expect(job(ci, "package"), "the packing job does not pin npm").toContain(pin);
  expect(job(ci, "package"), "the packing job does not pack").toContain(
    "scripts/check-tarball.mjs",
  );
  // ...and that script is what actually reaches verify-tarball, so the claim
  // "the same verification publish.yml uses" stays true through the chain.
  expect(
    read("scripts/check-tarball.mjs"),
    "the shared check does not run verify-tarball",
  ).toContain("verify-tarball.mjs");

  // "the matrix must not — pinning that leg would stop it exercising the npm
  //  a Node-floor user actually has"
  expect(job(ci, "test"), "the engines-floor matrix pins npm").not.toContain(
    "npm install -g",
  );
  for (const packs of ["npm pack", "check-tarball.mjs"])
    expect(job(ci, "test"), "the engines-floor matrix packs").not.toContain(
      packs,
    );

  // "the same script publish.yml uses"
  expect(publish, "publish.yml does not run verify-tarball.mjs").toContain(
    "verify-tarball.mjs",
  );
  expect(publish, "publish.yml does not pin npm").toContain(pin);

  // The pin section forbids a floating npm; the prose must not be contradicted
  // by the workflow it describes.
  for (const [name, wf] of [
    ["ci.yml", ci],
    ["publish.yml", publish],
  ] as const)
    expect(wf, `${name} installs a floating npm`).not.toMatch(
      /npm install -g npm@latest/,
    );
});

/**
 * The standard calls the GitHub Release mandatory (step 12) and says step 11
 * must skip rather than fail when the registry has not replicated yet. Nothing
 * made that true of step 10: GitHub skips every later step once one fails, and
 * `Confirm published` polls a registry that has in practice exceeded its
 * budget — v0.7.17 published at 03:16:04 and had not resolved by 03:21:15. The
 * package went to npm with no Release and no artifact check, and the run
 * reported failure for a publish that had succeeded. Both steps must therefore
 * survive a confirmation that timed out, while still not running when the
 * build, the tests or the publish itself failed.
 */
test("a slow registry cannot suppress the artifact check or the mandatory Release", () => {
  const publish = readFileSync(
    join(import.meta.dirname, "..", ".github/workflows/publish.yml"),
    "utf8",
  );
  const step = (name: string) => {
    const at = publish.indexOf(`- name: ${name}`);
    expect(at, `publish.yml has no step named ${name}`).toBeGreaterThan(-1);
    const next = publish.indexOf("\n      - name:", at + 1);
    return publish.slice(at, next === -1 ? undefined : next);
  };
  expect(step("Publish"), "the publish step has no id to condition on").toMatch(
    /id: publish/,
  );
  for (const name of [
    "Verify the published artifact matches what was tested",
    "Create GitHub Release",
  ]) {
    expect(step(name), `${name} is suppressed by an earlier failure`).toMatch(
      /if: \|?\s*always\(\)/,
    );
    expect(
      step(name),
      `${name} does not require the package to actually be on the registry`,
    ).toMatch(/steps\.publish\.outcome == 'success'/);
  }
});

/**
 * The standard's step 4 says "`npm ci`, build, typecheck, the unit suite". That
 * was prose describing something no workflow did: `tsconfig.json` is scoped to
 * `src/`, so building typechecked the source as a side effect and the suite not
 * at all (#74). Both workflows run it now, and this keeps the claim honest.
 */
test("the typecheck the standard claims is run by both workflows", () => {
  const read = (p: string) =>
    readFileSync(join(import.meta.dirname, "..", p), "utf8");
  expect(read("docs/ci-cd-standard.md")).toMatch(/typecheck/i);
  for (const workflow of ["ci.yml", "publish.yml"])
    expect(
      read(`.github/workflows/${workflow}`),
      `${workflow} does not run the typecheck`,
    ).toMatch(/npm run typecheck/);
  // And it has to cover the tests, not just what the build already compiles.
  expect(
    JSON.parse(read("tsconfig.check.json").replace(/^\s*\/\/.*$/gm, ""))
      .include,
  ).toContain("test/**/*.ts");
});
