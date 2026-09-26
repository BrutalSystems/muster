import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  configSchema,
  loadConfig,
  unknownConfigKeys,
} from "../src/config.js";
import { RequesterConfigError } from "../src/requester-policy.js";

async function config(toml: string) {
  const home = await mkdtemp(join(tmpdir(), "mu-cfg-"));
  await writeFile(join(home, "config.toml"), toml);
  return loadConfig(home);
}

const profile = `
[requester_profiles.research]
allowed_roots = ["/tmp"]
`;

test("both sections default to empty, so nothing changes unconfigured", () => {
  const parsed = configSchema.parse({});
  expect(parsed.requester_profiles).toEqual({});
  expect(parsed.requesters).toEqual([]);
});

test("a profile defaults to the most restrictive settings", async () => {
  const c = await config(profile);
  expect(c.requester_profiles.research).toEqual({
    allowed_roots: ["/tmp"],
    level: "read",
    min_enforcement: "kernel",
    env_allow: [],
    env_defaults: {},
    identities: [],
  });
});

test("allowed_roots is required and must be non-empty", async () => {
  await expect(
    config("[requester_profiles.research]\nallowed_roots = []\n"),
  ).rejects.toThrow();
  await expect(config("[requester_profiles.research]\n")).rejects.toThrow();
});

test("open is not expressible in a remote profile", async () => {
  await expect(config(`${profile}level = "open"\n`)).rejects.toThrow();
});

test("an enrolment must name a profile that exists", async () => {
  // The class, not just "it threw": the spec lists this under
  // RequesterConfigError so a transport maps it to a stable code without
  // matching message text, and `rejects.toThrow(/missing/)` alone is satisfied
  // by a zod parse failure that happens to mention the word.
  const error = await config(
    `${profile}
[[requesters]]
authority = "example.peer.v1"
subject = "abc"
profile = "missing"
`,
  ).catch((e) => e as Error);
  expect(error).toBeInstanceOf(RequesterConfigError);
  expect((error as Error).message).toMatch(/missing/);
});

test("two enrolments of the same subject are an error, not a precedence rule", async () => {
  const error = await config(
    `${profile}
[[requesters]]
authority = "example.peer.v1"
subject = "abc"
profile = "research"

[[requesters]]
authority = "example.peer.v1"
subject = "abc"
profile = "research"
`,
  ).catch((e) => e as Error);
  expect(error).toBeInstanceOf(RequesterConfigError);
  expect((error as Error).message).toMatch(/duplicate/i);
});

test("a complete enrolment loads, label included", async () => {
  const c = await config(
    `${profile}
[[requesters]]
authority = "example.peer.v1"
subject = "abc"
label = "m4pro"
profile = "research"
`,
  );
  expect(c.requesters).toEqual([
    {
      authority: "example.peer.v1",
      subject: "abc",
      label: "m4pro",
      profile: "research",
    },
  ]);
});

/**
 * A config written for a newer Muster must not brick an older one. The schema
 * refused every key it did not know, so adding `terminal` in 0.11.0 made EVERY
 * command on 0.10.0 fail with `unrecognized_keys` — not a warning, a dead CLI,
 * including `list` and `stop`. Unknown top-level keys are now reported and
 * ignored.
 *
 * Values are still refused. An ignored bad VALUE would be the dangerous
 * direction: `sandbox = "workspce-write"` silently dropped would launch under
 * the default instead of the pair the operator wrote.
 */
test("an unknown top-level key is ignored, not fatal", async () => {
  const parsed = await config(`
max_concurrent = 7
terminal_from_the_future = "ghostty"
some_other_new_key = true
`);
  expect(parsed.max_concurrent).toBe(7);
  expect(unknownConfigKeys({ max_concurrent: 7, terminal_from_the_future: "x" })).toEqual([
    "terminal_from_the_future",
  ]);
  expect(unknownConfigKeys({ max_concurrent: 7 })).toEqual([]);
});

test("a malformed value is still refused", async () => {
  await expect(config(`sandbox = "workspce-write"\n`)).rejects.toThrow();
  await expect(config(`max_concurrent = "many"\n`)).rejects.toThrow();
  // A nested policy table stays strict: an unknown key inside a requester
  // profile is a policy statement that would not apply, and the safe answer
  // there is to refuse rather than to proceed with something unintended.
  await expect(
    config(`
[requester_profiles.research]
allowed_roots = ["/"]
levle = "work"

[[requesters]]
authority = "a"
subject = "b"
profile = "research"
`),
  ).rejects.toThrow();
});
