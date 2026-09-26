import { expect, test } from "vitest";
import { configSchema } from "../src/config.js";
import { agentBaseEnv, launchEnv } from "../src/guard.js";
import { RequesterConfigError } from "../src/requester-policy.js";
import { LOCAL, type RequesterId } from "../src/requester.js";

const remote: RequesterId = {
  kind: "remote",
  authority: "example.peer.v1",
  subject: "abc",
};
const source = {
  PATH: "/usr/bin",
  HOME: "/Users/someone",
  LANG: "en_US.UTF-8",
  TERM: "xterm",
  SECRET_API_KEY: "sk-do-not-leak",
  GH_TOKEN: "ghp-configured",
  CLAUDECODE: "1",
};
const profile = (extra: Record<string, unknown> = {}) =>
  configSchema.parse({
    requester_profiles: { p: { allowed_roots: ["/tmp"], ...extra } },
  }).requester_profiles.p!;

test("a local requester gets today's denylist environment, unchanged", () => {
  expect(agentBaseEnv(LOCAL, undefined, source)).toEqual(launchEnv(source));
  expect(agentBaseEnv(LOCAL, undefined, source).SECRET_API_KEY).toBe(
    "sk-do-not-leak",
  );
});

test("a remote requester gets the baseline and nothing it did not ask for", () => {
  const env = agentBaseEnv(remote, profile(), source);
  expect(env.PATH).toBe("/usr/bin");
  expect(env.LANG).toBe("en_US.UTF-8");
  expect(env.SECRET_API_KEY).toBeUndefined();
  expect(env.GH_TOKEN).toBeUndefined();
  expect(env.CLAUDECODE).toBeUndefined();
});

test("a configured key is admitted and an unconfigured one is not", () => {
  const env = agentBaseEnv(
    remote,
    profile({ env_allow: ["GH_TOKEN"] }),
    source,
  );
  expect(env.GH_TOKEN).toBe("ghp-configured");
  expect(env.SECRET_API_KEY).toBeUndefined();
});

test("the profile may override a baseline value", () => {
  const env = agentBaseEnv(
    remote,
    profile({ env_defaults: { PATH: "/opt/bin", LANG: "C" } }),
    source,
  );
  expect(env.PATH).toBe("/opt/bin");
  expect(env.LANG).toBe("C");
});

test("env_defaults wins over the accepting shell for a key it sets", () => {
  // A profile that pins a value and also lists the key in env_allow means the
  // value it pinned. The allow loop runs after the baseline, so before this it
  // overwrote env_defaults with the raw source value — a profile that read as
  // pinning PATH while handing over the accepting shell's.
  const env = agentBaseEnv(
    remote,
    profile({
      env_allow: ["PATH", "GH_TOKEN"],
      env_defaults: { PATH: "/opt/bin", GH_TOKEN: "ghp-pinned" },
    }),
    source,
  );
  expect(env.PATH).toBe("/opt/bin");
  expect(env.GH_TOKEN).toBe("ghp-pinned");
});

test("a composed environment missing PATH or LANG is a config error", () => {
  for (const key of ["PATH", "LANG"]) {
    const thin = { ...source, [key]: "" };
    expect(() => agentBaseEnv(remote, profile(), thin)).toThrow(
      RequesterConfigError,
    );
    expect(() => agentBaseEnv(remote, profile(), thin)).toThrow(
      new RegExp(key),
    );
  }
});

test("env_defaults reaches the agent even for a key that is neither baseline nor allow-listed", () => {
  // Without this, a profile setting a value it never delivers reads as though it
  // does — the reported-vs-enforced mismatch this feature exists to remove.
  const env = agentBaseEnv(
    remote,
    profile({ env_defaults: { LANG: "C", CARGO_HOME: "/opt/cargo" } }),
    source,
  );
  expect(env.CARGO_HOME).toBe("/opt/cargo");
});

test("env_defaults wins over the accepting environment for an allow-listed key", () => {
  const env = agentBaseEnv(
    remote,
    profile({
      env_allow: ["GH_TOKEN"],
      env_defaults: { LANG: "C", GH_TOKEN: "ghp-chosen-by-profile" },
    }),
    source,
  );
  expect(env.GH_TOKEN).toBe("ghp-chosen-by-profile");
  expect(env.GH_TOKEN).not.toBe(source.GH_TOKEN);
});
