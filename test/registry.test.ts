import { mkdtemp } from "node:fs/promises";
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
