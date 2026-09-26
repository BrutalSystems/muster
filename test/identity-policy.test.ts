import { expect, test } from "vitest";
import { configSchema } from "../src/config.js";
import {
  RequesterPolicyRefusal,
  resolveIdentityForRequest,
  resolveRequesterPolicy,
} from "../src/requester-policy.js";
import { LOCAL, type RequesterId } from "../src/requester.js";

const remote: RequesterId = {
  kind: "remote",
  authority: "example.peer.v1",
  subject: "abc",
};
const config = (identities: string[]) =>
  configSchema.parse({
    requester_profiles: { p: { allowed_roots: ["/tmp"], identities } },
    requesters: [
      { authority: "example.peer.v1", subject: "abc", profile: "p" },
    ],
  });
const policyFor = (identities: string[]) =>
  resolveRequesterPolicy(remote, config(identities));

test("identities defaults to empty", () => {
  expect(
    configSchema.parse({
      requester_profiles: { p: { allowed_roots: ["/tmp"] } },
    }).requester_profiles.p!.identities,
  ).toEqual([]);
});

test("a local requester may name any identity, or none", () => {
  const local = resolveRequesterPolicy(LOCAL, config([]));
  expect(resolveIdentityForRequest("anything", local)).toBe("anything");
  expect(resolveIdentityForRequest(undefined, local)).toBeUndefined();
});

test("a remote requester naming an identity its profile does not grant is refused", () => {
  let err: RequesterPolicyRefusal | undefined;
  try {
    resolveIdentityForRequest("claude-work", policyFor([]));
  } catch (e) {
    err = e as RequesterPolicyRefusal;
  }
  expect(err).toBeInstanceOf(RequesterPolicyRefusal);
  expect(err!.ceiling).toBe("identity");
});

test("a remote requester may name one its profile grants", () => {
  expect(resolveIdentityForRequest("a", policyFor(["a", "b"]))).toBe("a");
  expect(() => resolveIdentityForRequest("c", policyFor(["a", "b"]))).toThrow(
    RequesterPolicyRefusal,
  );
});

test("a profile granting exactly one identity makes it the default", () => {
  expect(resolveIdentityForRequest(undefined, policyFor(["only"]))).toBe(
    "only",
  );
});

test("a profile granting several requires the request to choose", () => {
  let err: RequesterPolicyRefusal | undefined;
  try {
    resolveIdentityForRequest(undefined, policyFor(["a", "b"]));
  } catch (e) {
    err = e as RequesterPolicyRefusal;
  }
  expect(err).toBeInstanceOf(RequesterPolicyRefusal);
  expect(err!.ceiling).toBe("identity");
});

test("a profile granting none leaves the launch on the ambient environment", () => {
  expect(resolveIdentityForRequest(undefined, policyFor([]))).toBeUndefined();
});
