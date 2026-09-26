import { writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Muster } from "../src/run.js";
import { setupIdentity } from "../src/identity-cli.js";
import { identityPath } from "../src/identity-store.js";
import { fixture } from "./helpers.js";

async function launched() {
  const f = await fixture();
  await writeFile(join(f.home, "config.toml"), "launch_timeout_sec = 10\n");
  await setupIdentity({ home: f.home, name: "id1", agent: "codex" });
  const dir = identityPath(f.home, "id1");
  await writeFile(join(dir, "auth.json"), "{}");
  await writeFile(join(dir, "config.toml"), "# codex\n");
  const m = await Muster.create({ home: f.home, env: f.env });
  const rec = await m.run({
    runtime: "codex",
    prompt: "hi",
    cwd: f.root,
    identity: "id1",
  });
  return { f, m, rec: rec as { id: string; canonical_id?: string } };
}

test("the copy survives while the launch is running", async () => {
  const { m } = await launched();
  try {
    const [entry] = await m.registry.all();
    expect((await stat(entry!.identityPath!)).isDirectory()).toBe(true);
    // Named after the launch id, not the agent's own session id: a session
    // record carries thread_id/session_id and no `id` field at all (see
    // identity-launch.test.ts).
    expect(entry!.identityPath).toContain(entry!.launchId);
  } finally {
    await m.close();
  }
});

test("stopping the launch removes the copy", async () => {
  const { m, rec } = await launched();
  try {
    const [before] = await m.registry.all();
    const path = before!.identityPath!;
    await m.stop(rec.canonical_id ?? rec.id);
    await expect(stat(path)).rejects.toThrow();
  } finally {
    await m.close();
  }
});

test("listing removes the copy for a terminal entry", async () => {
  const { m } = await launched();
  try {
    const [entry] = await m.registry.all();
    const path = entry!.identityPath!;
    await m.registry.update(entry!.launchId, { status: "exited" });
    await m.list();
    await expect(stat(path)).rejects.toThrow();
  } finally {
    await m.close();
  }
});

test("an entry with no copy is not a cleanup error", async () => {
  const f = await fixture();
  await writeFile(join(f.home, "config.toml"), "launch_timeout_sec = 10\n");
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    await m.run({ runtime: "codex", prompt: "hi", cwd: f.root });
    const [entry] = await m.registry.all();
    expect(entry!.identityPath).toBeUndefined();
    await expect(m.list()).resolves.toBeDefined();
  } finally {
    await m.close();
  }
});
