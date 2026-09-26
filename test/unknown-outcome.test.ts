import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Registry } from "../src/registry.js";

/**
 * An owner that is gone. Reserving under a pid that no longer exists is how the
 * crash gap is reproduced without killing the test runner: the recovery branch
 * only cares whether the recorded owner is still the same process.
 */
async function abandoned(spawning: boolean) {
  const home = await mkdtemp(join(tmpdir(), "muster-unknown-"));
  const registry = new Registry(home);
  const { entry } = await registry.reserve(
    { runtime: "codex", kind: "session", cwd: home },
    4,
    { requestKey: "k", paramsFingerprint: "fp" },
  );
  if (spawning) await registry.update(entry.launchId, { spawning: true });
  // Rewrite the owner to a process that has certainly exited.
  await registry.update(entry.launchId, {
    owner: { pid: entry.owner.pid, start: "Thu Jan  1 00:00:00 1970" },
  });
  return { home, registry, entry };
}

test("a launch abandoned before any spawn is a failure", async () => {
  const { registry } = await abandoned(false);
  const [entry] = await registry.all();
  expect(entry!.status).toBe("failed");
  expect(entry!.error).toMatch(/before recording process/);
  expect(entry!.unknownSince).toBeUndefined();
});

test("a launch abandoned after a spawn is unknown, not failed", async () => {
  const { registry } = await abandoned(true);
  const [entry] = await registry.all();
  expect(entry!.status).toBe("unknown");
  expect(entry!.error).toMatch(/may be running untracked/);
  expect(Date.parse(entry!.unknownSince!)).toBeLessThanOrEqual(Date.now());
});

test("the moment an outcome became unknown does not move on re-reading", async () => {
  const { home, registry } = await abandoned(true);
  const first = (await registry.all())[0]!.unknownSince;
  await new Promise((r) => setTimeout(r, 25));
  expect((await new Registry(home).all())[0]!.unknownSince).toBe(first);
});

test("an unknown outcome refuses to be relaunched under the same key", async () => {
  const { registry, home } = await abandoned(true);
  const repeat = await registry.reserve(
    { runtime: "codex", kind: "session", cwd: home },
    4,
    { requestKey: "k", paramsFingerprint: "fp" },
  );
  expect(repeat.deduped).toBe(true);
  expect(repeat.entry.status).toBe("unknown");
  expect(await registry.all()).toHaveLength(1);
});
