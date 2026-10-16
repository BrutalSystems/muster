import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Registry } from "../src/registry.js";

test("registry round-trips OpenCode endpoint ownership metadata", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-registry-opencode-"));
  const registry = new Registry(home);
  const { entry } = await registry.reserve(
    { runtime: "opencode", kind: "session", cwd: home },
    1,
  );

  await registry.update(entry.launchId, {
    server_url: "http://127.0.0.1:43127",
    opencode_port: 43127,
  });

  expect((await new Registry(home).all())[0]).toMatchObject({
    runtime: "opencode",
    server_url: "http://127.0.0.1:43127",
    opencode_port: 43127,
  });
});

test("a reserved entry carries the model it launched with", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-registry-model-"));
  const registry = new Registry(home);
  const { entry } = await registry.reserve(
    {
      runtime: "claude",
      kind: "task",
      cwd: home,
      model: "opus",
      modelSource: "request",
    },
    1,
  );
  expect(entry.model).toBe("opus");
  expect(entry.modelSource).toBe("request");
  // Survives the round-trip to disk, which is the point of recording it.
  expect((await new Registry(home).all())[0]).toMatchObject({
    model: "opus",
    modelSource: "request",
  });
});

test("an explicit null is recorded, and is not the same as absent", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-registry-model-null-"));
  const registry = new Registry(home);
  const { entry } = await registry.reserve(
    {
      runtime: "claude",
      kind: "task",
      cwd: home,
      model: null,
      modelSource: null,
    },
    1,
  );
  expect(entry.model).toBeNull();
  expect("model" in entry).toBe(true);
});

test("an entry reserved without a model has no model field at all", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-registry-model-absent-"));
  const { entry } = await new Registry(home).reserve(
    { runtime: "claude", kind: "task", cwd: home },
    1,
  );
  expect("model" in entry).toBe(false);
});

test("a reserved entry can carry the identity it launched under", async () => {
  // Recorded at reserve, like the model: an entry that dies before the identity
  // patch would otherwise publish no identity at all, which `list` renders as
  // "ran on the ambient environment" — a false statement about the one question
  // #63 exists to answer.
  const home = await mkdtemp(join(tmpdir(), "muster-registry-identity-"));
  const { entry } = await new Registry(home).reserve(
    { runtime: "claude", kind: "task", cwd: home, identity: "work" },
    1,
  );
  expect(entry.identity).toBe("work");
  expect((await new Registry(home).all())[0]).toMatchObject({
    identity: "work",
  });
});

test("an entry reserved with no identity omits the field", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-registry-identity-none-"));
  const { entry } = await new Registry(home).reserve(
    { runtime: "claude", kind: "task", cwd: home },
    1,
  );
  expect("identity" in entry).toBe(false);
});

test("a reserved entry carries the lifecycle it launched with", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-registry-lifecycle-"));
  const { entry } = await new Registry(home).reserve(
    {
      runtime: "claude",
      kind: "session",
      cwd: home,
      idleTimeout: 1800,
      ttl: null,
    },
    1,
  );
  expect(entry.idleTimeout).toBe(1800);
  expect(entry.ttl).toBeNull();
  expect((await new Registry(home).all())[0]).toMatchObject({
    idleTimeout: 1800,
  });
});

test("an entry reserved without a lifecycle has neither field", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-registry-lifecycle-none-"));
  const { entry } = await new Registry(home).reserve(
    { runtime: "claude", kind: "task", cwd: home },
    1,
  );
  expect("idleTimeout" in entry).toBe(false);
});

/**
 * The lock is a bare directory, released only by the `finally` of the process
 * that made it. A process that dies inside a transaction — an unhandled EPIPE,
 * a SIGKILL from a client shutting its MCP server down — used to leave it
 * forever, and every muster command on the machine then failed with "Registry
 * locked" until a person removed it by hand.
 */
/** The start time as the lock records it: UTC, C locale. */
async function utcRef(pid: number) {
  const { stdout } = await promisify(execFile)(
    "ps",
    ["-p", String(pid), "-o", "lstart="],
    { env: { ...process.env, TZ: "UTC", LC_ALL: "C" } },
  );
  return { pid, start: stdout.trim().slice(0, 24) };
}
async function deadRef() {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},2000)"]);
  const ref = await utcRef(child.pid!);
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  return ref!;
}

test("a transaction records who holds the lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-registry-owner-"));
  const self = await utcRef(process.pid);
  // Bracket access reaches the private transaction, the only place the lock
  // is held long enough to look at.
  const seen = await new Registry(home)["transaction"](async () =>
    JSON.parse(
      await readFile(join(home, "registry.lock", "owner.json"), "utf8"),
    ),
  );
  expect(seen).toEqual(self);
  expect(existsSync(join(home, "registry.lock"))).toBe(false);
});

test("a lock whose holder has died is taken over", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-registry-dead-"));
  await mkdir(join(home, "registry.lock"));
  await writeFile(
    join(home, "registry.lock", "owner.json"),
    JSON.stringify(await deadRef()),
  );
  await expect(new Registry(home).all()).resolves.toEqual([]);
  expect(existsSync(join(home, "registry.lock"))).toBe(false);
});

test("a lock with no owner is taken over once it is old", async () => {
  // What every earlier version leaves behind: an empty directory.
  const home = await mkdtemp(join(tmpdir(), "muster-registry-legacy-"));
  const lock = join(home, "registry.lock");
  await mkdir(lock);
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(lock, old, old);
  await expect(new Registry(home).all()).resolves.toEqual([]);
  expect(existsSync(lock)).toBe(false);
});

test("a fresh lock with no owner is still respected", async () => {
  // The holder may be between mkdir and writing its owner file.
  const home = await mkdtemp(join(tmpdir(), "muster-registry-fresh-"));
  await mkdir(join(home, "registry.lock"));
  await expect(new Registry(home, 200).all()).rejects.toThrow(
    /Registry locked/,
  );
  expect(existsSync(join(home, "registry.lock"))).toBe(true);
});

test("a holder in another timezone is still recognised as alive", async () => {
  // Written by a holder whose `ps` ran in UTC, read by a waiter that may not be.
  const home = await mkdtemp(join(tmpdir(), "muster-registry-tz-"));
  await mkdir(join(home, "registry.lock"));
  await writeFile(
    join(home, "registry.lock", "owner.json"),
    JSON.stringify(await utcRef(process.pid)),
  );
  const tz = process.env.TZ;
  process.env.TZ = "Pacific/Kiritimati";
  try {
    await expect(new Registry(home, 200).all()).rejects.toThrow(
      /Registry locked/,
    );
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
  expect(existsSync(join(home, "registry.lock"))).toBe(true);
});

test("a lock held by a live process is respected, and the error names it", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-registry-live-"));
  await mkdir(join(home, "registry.lock"));
  await writeFile(
    join(home, "registry.lock", "owner.json"),
    JSON.stringify(await utcRef(process.pid)),
  );
  await expect(new Registry(home, 200).all()).rejects.toThrow(
    new RegExp(`held by pid ${process.pid}`),
  );
  expect(existsSync(join(home, "registry.lock"))).toBe(true);
});
