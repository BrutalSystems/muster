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
      "609634a58df2e288542732a3c95037a3e57efcaf63a36c26f6a4a7251c4804f2",
    ],
    [
      "./fixtures/canonical-id.json",
      "bf686e97d91cba3bd3ee51ecb6d74ccf5e4978b3fcb783e441b1c01de5135285",
    ],
  ]) {
    expect(
      createHash("sha256")
        .update(readFileSync(new URL(file!, import.meta.url)))
        .digest("hex"),
    ).toBe(expected);
  }
});
