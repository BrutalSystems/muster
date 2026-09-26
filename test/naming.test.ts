import { test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  slugify,
  suffixOf,
  assignNames,
  resolvePeer,
  type PeerBase,
} from "../src/naming.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/canonical-id.json", import.meta.url),
    "utf8",
  ),
);
for (const c of fixture.slugify)
  test(`slugify: ${c.case}`, () => expect(slugify(c.input)).toBe(c.output));
for (const c of fixture.suffix)
  test(`suffix: ${c.case}`, () => expect(suffixOf(c.input)).toBe(c.output));
for (const c of fixture.assign)
  test(`assign: ${c.case}`, () => {
    expect(
      assignNames(c.peers).map(({ display, canonicalId }) => ({
        display,
        canonicalId,
      })),
    ).toEqual(c.expect);
  });
for (const c of fixture.resolve)
  test(`resolve: ${c.case}`, () => {
    const result = resolvePeer(assignNames(c.peers as PeerBase[]), c.input);
    expect(result.ok).toBe(c.expect.ok);
    if (result.ok) expect(result.peer.canonicalId).toBe(c.expect.canonicalId);
    else {
      expect(result.reason).toBe(c.expect.reason);
      expect([...result.candidates].sort()).toEqual(
        [...c.expect.candidates].sort(),
      );
    }
  });
test("contract copies remain frozen", () => {
  for (const [file, expected] of [
    [
      "../CANONICAL_ID.md",
      "6e0dde03154956a480ae59f4d31b727ecc5a9e735c185fed6e4445f2574263a9",
    ],
    [
      "./fixtures/canonical-id.json",
      "b91406e068f6bec18629a4d2b9e91bc4d2e5a0487e4b6b4534fd5ba37c7f617a",
    ],
  ]) {
    expect(
      createHash("sha256")
        .update(readFileSync(new URL(file!, import.meta.url)))
        .digest("hex"),
    ).toBe(expected);
  }
});
