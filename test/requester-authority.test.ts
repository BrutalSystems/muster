import { expect, test } from "vitest";
import {
  RequesterPolicyRefusal,
  assertMayAct,
} from "../src/requester-policy.js";
import { LOCAL, type RequesterId } from "../src/requester.js";

const one: RequesterId = {
  kind: "remote",
  authority: "example.peer.v1",
  subject: "one",
};
const two: RequesterId = { ...one, subject: "two" };

test("a local requester may act on anything, including remote launches", () => {
  for (const entry of [{ requester: one }, { requester: LOCAL }, {}])
    expect(() => assertMayAct(entry, LOCAL)).not.toThrow();
});

test("a remote requester may act on its own launch", () => {
  expect(() => assertMayAct({ requester: one }, one)).not.toThrow();
  // The label is not part of the key, so it cannot grant or withhold anything.
  expect(() =>
    assertMayAct({ requester: one }, { ...one, label: "renamed" }),
  ).not.toThrow();
});

test("a remote requester may not act on another's launch", () => {
  let err: RequesterPolicyRefusal | undefined;
  try {
    assertMayAct({ requester: one }, two);
  } catch (e) {
    err = e as RequesterPolicyRefusal;
  }
  expect(err).toBeInstanceOf(RequesterPolicyRefusal);
  expect(err!.ceiling).toBe("not-owner");
});

test("a remote requester may not act on a local launch", () => {
  expect(() => assertMayAct({ requester: LOCAL }, one)).toThrow(
    RequesterPolicyRefusal,
  );
  // An entry predating the field reads as local, so it is equally protected.
  expect(() => assertMayAct({}, one)).toThrow(RequesterPolicyRefusal);
});
