import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { IdempotencyKeyReuse, Registry } from "../src/registry.js";
import { paramsFingerprint, runSchema } from "../src/guard.js";
import { Muster } from "../src/run.js";
import { PtyHost } from "../src/hosts/pty.js";
import { fixture, lines } from "./helpers.js";

const request = { runtime: "codex" as const, kind: "session" as const };
const idem = (key: string, fingerprint = "fp-one") => ({
  requestKey: key,
  paramsFingerprint: fingerprint,
});

async function registry() {
  const home = await mkdtemp(join(tmpdir(), "muster-idem-"));
  return { home, registry: new Registry(home) };
}

test("a repeated key returns the first reservation instead of a second", async () => {
  const { home, registry: r } = await registry();
  const first = await r.reserve({ ...request, cwd: home }, 4, idem("k1"));
  const second = await r.reserve({ ...request, cwd: home }, 4, idem("k1"));

  expect(first.deduped).toBe(false);
  expect(second.deduped).toBe(true);
  expect(second.entry.launchId).toBe(first.entry.launchId);
  expect(await r.all()).toHaveLength(1);
});

test("concurrent reservations across processes produce one entry", async () => {
  const { home } = await registry();
  const a = new Registry(home),
    b = new Registry(home);

  const results = await Promise.all([
    a.reserve({ ...request, cwd: home }, 4, idem("k2")),
    b.reserve({ ...request, cwd: home }, 4, idem("k2")),
  ]);

  expect(results.filter((r) => !r.deduped)).toHaveLength(1);
  expect(new Set(results.map((r) => r.entry.launchId)).size).toBe(1);
  expect(await a.all()).toHaveLength(1);
});

test("the same key with different parameters is refused, naming both", async () => {
  const { home, registry: r } = await registry();
  await r.reserve({ ...request, cwd: home }, 4, idem("k3", "fp-one"));

  await expect(
    r.reserve({ ...request, cwd: home }, 4, idem("k3", "fp-two")),
  ).rejects.toThrow(IdempotencyKeyReuse);
  await expect(
    r.reserve({ ...request, cwd: home }, 4, idem("k3", "fp-two")),
  ).rejects.toThrow(/fp-one.*fp-two|recorded.*offered/s);
  expect(await r.all()).toHaveLength(1);
});

test("a duplicate is answered even when the cap is full", async () => {
  const { home, registry: r } = await registry();
  const first = await r.reserve({ ...request, cwd: home }, 1, idem("k4"));

  // The cap is now full — and it is full *of the entry being asked about*.
  await expect(r.reserve({ ...request, cwd: home }, 1)).rejects.toThrow(/cap/i);

  const retry = await r.reserve({ ...request, cwd: home }, 1, idem("k4"));
  expect(retry.deduped).toBe(true);
  expect(retry.entry.launchId).toBe(first.entry.launchId);
});

test("a key is answered with a terminal outcome rather than a fresh launch", async () => {
  const { home, registry: r } = await registry();
  const first = await r.reserve({ ...request, cwd: home }, 4, idem("k5"));
  await r.update(first.entry.launchId, { status: "failed", error: "boom" });

  const retry = await r.reserve({ ...request, cwd: home }, 4, idem("k5"));
  expect(retry.deduped).toBe(true);
  expect(retry.entry).toMatchObject({ status: "failed", error: "boom" });
  expect(await r.all()).toHaveLength(1);
});

test("reservations without a key are unaffected", async () => {
  const { home, registry: r } = await registry();
  const a = await r.reserve({ ...request, cwd: home }, 4);
  const b = await r.reserve({ ...request, cwd: home }, 4);

  expect(a.deduped).toBe(false);
  expect(b.deduped).toBe(false);
  expect(b.entry.launchId).not.toBe(a.entry.launchId);
  expect(await r.all()).toHaveLength(2);
});

test("the fingerprint tracks what is launched, not how it is labelled", () => {
  const base = {
    runtime: "codex" as const,
    prompt: "review the auth flow",
    cwd: process.cwd(),
  };
  const permissions = {
    permissions: "deny" as const,
    sandbox: "read-only" as const,
  };
  const of = (extra: Record<string, unknown> = {}, mcp: string[] = []) =>
    paramsFingerprint(
      runSchema.parse({ ...base, ...extra }),
      permissions,
      mcp,
      [],
    );

  expect(of()).toBe(of());
  expect(of({}, ["a", "b"])).toBe(of({}, ["b", "a"]));
  expect(of({ requestKey: "k" })).toBe(of({ requestKey: "other" }));

  expect(of({ prompt: "review something else" })).not.toBe(of());
  expect(of({ kind: "task" })).not.toBe(of());
  expect(of({ model: "some/model" })).not.toBe(of());
  expect(of({ identity: "account-a" })).not.toBe(of());
  expect(of({ identity: "account-a" })).not.toBe(of({ identity: "account-b" }));
  expect(of({}, ["a"])).not.toBe(of());
  expect(
    paramsFingerprint(runSchema.parse(base), permissions, [], ["p"]),
  ).not.toBe(of());
});

test("one key reused across two identities is refused, not answered with the first account's launch", async () => {
  // Identity is worse than most parameters to get wrong: it selects whose
  // credentials the agent holds. A caller that sends key k with account-a and
  // then key k with account-b must be told it reused the key — being handed the
  // launch already running under account-a, reported as success, is the
  // reported-state-versus-reality failure the fingerprint exists to prevent.
  const { home, registry: r } = await registry();
  const fingerprintFor = (identity: string) =>
    paramsFingerprint(
      runSchema.parse({
        runtime: "codex",
        prompt: "ship it",
        cwd: home,
        identity,
      }),
      { permissions: "deny", sandbox: "read-only" },
      [],
      [],
    );
  expect(fingerprintFor("account-a")).not.toBe(fingerprintFor("account-b"));

  await r.reserve(
    { ...request, cwd: home },
    4,
    idem("k-identity", fingerprintFor("account-a")),
  );
  await expect(
    r.reserve(
      { ...request, cwd: home },
      4,
      idem("k-identity", fingerprintFor("account-b")),
    ),
  ).rejects.toThrow(IdempotencyKeyReuse);
  expect(await r.all()).toHaveLength(1);
});

test("a repeated launch returns the running session without starting another", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  try {
    const first = await m.run({
      runtime: "codex",
      prompt: "idempotent launch",
      cwd: f.root,
      host: "pty",
      requestKey: "launch-once",
    });
    const second = await m.run({
      runtime: "codex",
      prompt: "idempotent launch",
      cwd: f.root,
      host: "pty",
      requestKey: "launch-once",
    });

    expect(second).toEqual(first);
    // One agent process was started, not two.
    expect(await lines(join(f.root, "starts.jsonl"))).toHaveLength(1);
    expect(
      (await lines(join(f.home, "launches.jsonl"))).filter(
        (l: { event: string }) => l.event === "deduped",
      ),
    ).toHaveLength(1);

    await expect(
      m.run({
        runtime: "codex",
        prompt: "a different instruction",
        cwd: f.root,
        host: "pty",
        requestKey: "launch-once",
      }),
    ).rejects.toThrow(/different parameters/i);
    expect(await lines(join(f.root, "starts.jsonl"))).toHaveLength(1);
  } finally {
    await m.close();
  }
}, 20000);
