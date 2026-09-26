import { expect, test } from "vitest";
import {
  LOCAL,
  requesterKey,
  requesterLabel,
  requesterSchema,
  type RequesterId,
} from "../src/requester.js";

const remote: RequesterId = {
  kind: "remote",
  authority: "example.peer.v1",
  subject: "opaque-subject-1",
};

test("a local requester is the default shape", () => {
  expect(requesterSchema.parse({ kind: "local" })).toEqual({ kind: "local" });
  expect(LOCAL).toEqual({ kind: "local" });
});

test("the label never changes the policy key", () => {
  const labelled = { ...remote, label: "m4pro" };
  expect(requesterSchema.parse(labelled)).toEqual(labelled);
  expect(requesterKey(labelled)).toBe(requesterKey(remote));
});

test("the key separates authority from subject unambiguously", () => {
  const a = requesterKey({ kind: "remote", authority: "x", subject: "y:z" });
  const b = requesterKey({ kind: "remote", authority: "x:y", subject: "z" });
  expect(a).not.toBe(b);
});

test("a local key never collides with a remote one", () => {
  expect(requesterKey(LOCAL)).not.toBe(requesterKey(remote));
});

test("a malformed remote identity is rejected rather than degraded", () => {
  for (const bad of [
    { kind: "remote", authority: "", subject: "s" },
    { kind: "remote", authority: "a" },
    { kind: "remote", subject: "s" },
    { kind: "elsewhere", authority: "a", subject: "s" },
    { kind: "remote", authority: "a", subject: "s", extra: 1 },
  ])
    expect(() => requesterSchema.parse(bad)).toThrow();
});

test("a label is shown when present and the kind names it otherwise", () => {
  expect(requesterLabel(LOCAL)).toBe("local");
  expect(requesterLabel({ ...remote, label: "m4pro" })).toBe("m4pro");
  expect(requesterLabel(remote)).toBe("example.peer.v1/opaque-subject-1");
});

test("requesterSchema rejects control characters in authority", () => {
  expect(() =>
    requesterSchema.parse({
      kind: "remote",
      authority: "x\0y",
      subject: "z",
    }),
  ).toThrow();
  expect(() =>
    requesterSchema.parse({
      kind: "remote",
      authority: "x\ty",
      subject: "z",
    }),
  ).toThrow();
});

test("requesterSchema rejects control characters in subject", () => {
  expect(() =>
    requesterSchema.parse({
      kind: "remote",
      authority: "a",
      subject: "y\0z",
    }),
  ).toThrow();
  expect(() =>
    requesterSchema.parse({
      kind: "remote",
      authority: "a",
      subject: "y\nz",
    }),
  ).toThrow();
});

test("requesterKey produces different keys for identities with control characters, without schema validation", () => {
  const collider1: RequesterId = {
    kind: "remote",
    authority: "x\0y",
    subject: "z",
  };
  const collider2: RequesterId = {
    kind: "remote",
    authority: "x",
    subject: "y\0z",
  };
  expect(requesterKey(collider1)).not.toBe(requesterKey(collider2));
});
