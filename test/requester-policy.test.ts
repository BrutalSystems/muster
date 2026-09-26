import { expect, test } from "vitest";
import { configSchema } from "../src/config.js";
import {
  RequesterNotEnrolled,
  RequesterPolicyRefusal,
  assertEnforcementMeetsMinimum,
  assertLevelWithinCeiling,
  resolveRequesterPolicy,
} from "../src/requester-policy.js";
import { LOCAL, type RequesterId } from "../src/requester.js";

const remote: RequesterId = {
  kind: "remote",
  authority: "example.peer.v1",
  subject: "abc",
};
const enrolled = configSchema.parse({
  requester_profiles: {
    research: { allowed_roots: ["/tmp"] },
    wide: {
      allowed_roots: ["/tmp"],
      level: "work",
      min_enforcement: "tool-policy",
    },
  },
  requesters: [
    { authority: "example.peer.v1", subject: "abc", profile: "research" },
    { authority: "example.peer.v1", subject: "loose", profile: "wide" },
  ],
});

test("a local requester resolves to no ceiling and full logging", () => {
  expect(resolveRequesterPolicy(LOCAL, enrolled)).toEqual({
    profile: undefined,
    level: undefined,
    minEnforcement: undefined,
    logMode: "full",
  });
});

test("an unenrolled remote requester is refused, not defaulted", () => {
  expect(() =>
    resolveRequesterPolicy(
      { kind: "remote", authority: "example.peer.v1", subject: "nope" },
      enrolled,
    ),
  ).toThrow(RequesterNotEnrolled);
  expect(() => resolveRequesterPolicy(remote, configSchema.parse({}))).toThrow(
    RequesterNotEnrolled,
  );
});

test("a refusal names the authority without echoing the whole subject", () => {
  try {
    resolveRequesterPolicy(
      {
        kind: "remote",
        authority: "example.peer.v1",
        subject: "0123456789abcdef",
      },
      enrolled,
    );
    throw new Error("expected a refusal");
  } catch (e) {
    expect((e as Error).message).toContain("example.peer.v1");
    expect((e as Error).message).not.toContain("0123456789abcdef");
  }
});

test("an enrolled requester resolves its profile and metadata logging", () => {
  const p = resolveRequesterPolicy(remote, enrolled);
  expect(p.level).toBe("read");
  expect(p.minEnforcement).toBe("kernel");
  expect(p.profile?.allowed_roots).toEqual(["/tmp"]);
  expect(p.logMode).toBe("metadata");
});

test("a level at or below the ceiling is honoured and a higher one refused", () => {
  const read = resolveRequesterPolicy(remote, enrolled);
  const work = resolveRequesterPolicy(
    { ...remote, subject: "loose" },
    enrolled,
  );
  expect(() => assertLevelWithinCeiling("read", read)).not.toThrow();
  expect(() => assertLevelWithinCeiling("read", work)).not.toThrow();
  expect(() => assertLevelWithinCeiling("work", work)).not.toThrow();
  for (const bad of ["work", "open"] as const) {
    let err: RequesterPolicyRefusal | undefined;
    try {
      assertLevelWithinCeiling(bad, read);
    } catch (e) {
      err = e as RequesterPolicyRefusal;
    }
    expect(err).toBeInstanceOf(RequesterPolicyRefusal);
    expect(err!.ceiling).toBe("level");
  }
});

test("a local policy imposes no level ceiling at all", () => {
  const local = resolveRequesterPolicy(LOCAL, enrolled);
  for (const level of ["read", "work", "open"] as const)
    expect(() => assertLevelWithinCeiling(level, local)).not.toThrow();
});

test("a runtime that cannot meet the minimum grade is refused by name", () => {
  const strict = resolveRequesterPolicy(remote, enrolled);
  const loose = resolveRequesterPolicy(
    { ...remote, subject: "loose" },
    enrolled,
  );
  expect(() =>
    assertEnforcementMeetsMinimum("codex", "kernel", strict),
  ).not.toThrow();
  expect(() =>
    assertEnforcementMeetsMinimum("opencode", "tool-policy", loose),
  ).not.toThrow();

  let err: RequesterPolicyRefusal | undefined;
  try {
    assertEnforcementMeetsMinimum("opencode", "tool-policy", strict);
  } catch (e) {
    err = e as RequesterPolicyRefusal;
  }
  expect(err).toBeInstanceOf(RequesterPolicyRefusal);
  expect(err!.ceiling).toBe("enforcement");
  expect(err!.message).toContain("opencode");
  expect(err!.message).toContain("tool-policy");
  expect(err!.message).toContain("kernel");
});

test("a grade of none never satisfies any remote minimum", () => {
  const loose = resolveRequesterPolicy(
    { ...remote, subject: "loose" },
    enrolled,
  );
  expect(() => assertEnforcementMeetsMinimum("codex", "none", loose)).toThrow(
    RequesterPolicyRefusal,
  );
});
