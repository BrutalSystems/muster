import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { IdempotencyKeyReuse, Registry } from "../src/registry.js";
import { LOCAL, type RequesterId } from "../src/requester.js";

const base = { runtime: "codex" as const, kind: "session" as const };
const idem = (requestKey: string, paramsFingerprint = "fp") => ({
  requestKey,
  paramsFingerprint,
});
const one: RequesterId = {
  kind: "remote",
  authority: "example.peer.v1",
  subject: "one",
};
const two: RequesterId = { ...one, subject: "two" };

async function registry() {
  const home = await mkdtemp(join(tmpdir(), "mu-req-reg-"));
  return { home, r: new Registry(home) };
}

test("a reservation records its requester, defaulting to local", async () => {
  const { home, r } = await registry();
  const local = await r.reserve({ ...base, cwd: home }, 4);
  expect(local.entry.requester).toEqual(LOCAL);
  const remote = await r.reserve({ ...base, cwd: home }, 4, undefined, one);
  expect(remote.entry.requester).toEqual(one);
});

test("two requesters using the same key get two launches", async () => {
  const { home, r } = await registry();
  const a = await r.reserve({ ...base, cwd: home }, 4, idem("k"), one);
  const b = await r.reserve({ ...base, cwd: home }, 4, idem("k"), two);
  expect(a.deduped).toBe(false);
  expect(b.deduped).toBe(false);
  expect(b.entry.launchId).not.toBe(a.entry.launchId);
  expect(await r.all()).toHaveLength(2);
});

test("one requester reusing its own key still dedupes", async () => {
  const { home, r } = await registry();
  const a = await r.reserve({ ...base, cwd: home }, 4, idem("k"), one);
  const b = await r.reserve({ ...base, cwd: home }, 4, idem("k"), one);
  expect(b.deduped).toBe(true);
  expect(b.entry.launchId).toBe(a.entry.launchId);
});

test("a local key and a remote key of the same text do not collide", async () => {
  const { home, r } = await registry();
  await r.reserve({ ...base, cwd: home }, 4, idem("k"));
  const remote = await r.reserve({ ...base, cwd: home }, 4, idem("k"), one);
  expect(remote.deduped).toBe(false);
  expect(await r.all()).toHaveLength(2);
});

test("the requester cannot be changed after it is recorded", async () => {
  const { home, r } = await registry();
  const { entry } = await r.reserve({ ...base, cwd: home }, 4, undefined, one);
  await expect(
    r.update(entry.launchId, { requester: two } as never),
  ).rejects.toThrow(/requester/i);
  expect((await r.all())[0]!.requester).toEqual(one);
});

test("a reservation survives a new reader with its provenance intact", async () => {
  const { home, r } = await registry();
  const { entry } = await r.reserve({ ...base, cwd: home }, 4, undefined, one);
  const stored = (await new Registry(home).all())[0]!;
  expect(stored.launchId).toBe(entry.launchId);
  expect(stored.requester).toEqual(one);
});

test("key reuse with changed parameters still raises, within one requester", async () => {
  const { home, r } = await registry();
  await r.reserve({ ...base, cwd: home }, 4, idem("k", "fp-one"), one);
  await expect(
    r.reserve({ ...base, cwd: home }, 4, idem("k", "fp-two"), one),
  ).rejects.toThrow(IdempotencyKeyReuse);
  // The same key with different parameters from a *different* requester is a
  // separate launch, not a reuse: the keys live in separate namespaces.
  const other = await r.reserve(
    { ...base, cwd: home },
    4,
    idem("k", "fp-two"),
    two,
  );
  expect(other.deduped).toBe(false);
});

test("a retry of an unknown outcome reports it rather than relaunching", async () => {
  const { home, r } = await registry();
  const first = await r.reserve({ ...base, cwd: home }, 4, idem("k"), one);
  await r.update(first.entry.launchId, {
    status: "unknown",
    unknownSince: new Date().toISOString(),
  });
  const retry = await r.reserve({ ...base, cwd: home }, 4, idem("k"), one);
  expect(retry.deduped).toBe(true);
  expect(retry.entry.status).toBe("unknown");
  expect(await r.all()).toHaveLength(1);
});
