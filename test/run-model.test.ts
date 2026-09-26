import { test, expect } from "vitest";
import { fixture } from "./helpers.js";
import { asSession, asTask } from "./narrow.js";
import { Muster } from "../src/run.js";
import { PtyHost } from "../src/hosts/pty.js";
import { Registry } from "../src/registry.js";

async function muster() {
  const f = await fixture();
  return {
    f,
    m: await Muster.create({
      home: f.home,
      env: f.env,
      drivers: [new PtyHost()],
    }),
  };
}

test("a task launch reports the model on its handle and in list", async () => {
  const { f, m } = await muster();
  try {
    const handle = asTask(
      await m.run({
        runtime: "claude",
        kind: "task",
        prompt: "ping",
        cwd: f.root,
        model: "opus",
      }),
    );
    expect(handle).toMatchObject({ model: "opus", model_source: "request" });
    const listed = (await m.list("task")).find((r: any) => r.id === handle.id);
    expect(listed).toMatchObject({ model: "opus", model_source: "request" });
  } finally {
    await m.close();
  }
}, 15000);

test("naming no model records an explicit null, not an absent field", async () => {
  const { f, m } = await muster();
  try {
    const handle = asTask(
      await m.run({
        runtime: "claude",
        kind: "task",
        prompt: "ping",
        cwd: f.root,
      }),
    );
    expect(handle.model).toBeNull();
    expect(handle.model_source).toBeNull();
    expect(Object.hasOwn(handle, "model")).toBe(true);
  } finally {
    await m.close();
  }
}, 15000);

test("an entry written before the field projects without it", async () => {
  const { f, m } = await muster();
  try {
    const { entry } = await new Registry(f.home).reserve(
      { runtime: "claude", kind: "task", cwd: f.root },
      4,
    );
    const listed: any = (await m.list("task")).find(
      (r: any) => r.id === entry.id,
    );
    expect(listed).toBeDefined();
    expect(Object.hasOwn(listed, "model")).toBe(false);
    expect(Object.hasOwn(listed, "model_source")).toBe(false);
  } finally {
    await m.close();
  }
}, 15000);

test("a malformed model is refused before anything is reserved", async () => {
  const { f, m } = await muster();
  try {
    await expect(
      m.run({
        runtime: "claude",
        kind: "task",
        prompt: "ping",
        cwd: f.root,
        model: "anthropic/opus",
      }),
    ).rejects.toThrow(/bare model id/);
    // The point of resolving at the pre-reserve seam: no half-record left behind.
    expect(await new Registry(f.home).all()).toHaveLength(0);
  } finally {
    await m.close();
  }
}, 15000);

test("a task launched with no identity omits the field rather than nulling it", async () => {
  const { f, m } = await muster();
  try {
    const handle = asTask(
      await m.run({
        runtime: "claude",
        kind: "task",
        prompt: "ping",
        cwd: f.root,
      }),
    );
    // Absent, not null: this launch ran on the ambient environment, which is a
    // complete answer. Contrast `model`, which IS null here.
    expect(Object.hasOwn(handle, "identity")).toBe(false);
    expect(handle.model).toBeNull();
  } finally {
    await m.close();
  }
}, 15000);

test("list omits identity for a launch that had none", async () => {
  const { f, m } = await muster();
  try {
    const handle = asTask(
      await m.run({
        runtime: "claude",
        kind: "task",
        prompt: "ping",
        cwd: f.root,
      }),
    );
    const listed: any = (await m.list("task")).find(
      (r: any) => r.id === handle.id,
    );
    expect(Object.hasOwn(listed, "identity")).toBe(false);
  } finally {
    await m.close();
  }
}, 15000);

test("a recorded identity reaches list", async () => {
  const { f, m } = await muster();
  try {
    const handle = asTask(
      await m.run({
        runtime: "claude",
        kind: "task",
        prompt: "ping",
        cwd: f.root,
      }),
    );
    // The entry is the source of truth; patch it the way a real identity launch
    // does at src/run.ts, then confirm the projection reports it.
    const registry = new Registry(f.home);
    const [entry] = await registry.all();
    await registry.update(entry!.launchId, { identity: "codex-personal" });
    const listed: any = (await m.list("task")).find(
      (r: any) => r.id === handle.id,
    );
    expect(listed.identity).toBe("codex-personal");
  } finally {
    await m.close();
  }
}, 15000);

test("a session launch reports its model, as its listing already does", async () => {
  // `run` and `list` build different records. `list` already reported a
  // session's model while `run` did not, so the same launch described itself
  // two ways depending on which command you asked.
  const { f, m } = await muster();
  try {
    const peer = asSession(
      await m.run({
        runtime: "claude",
        prompt: "test peer",
        cwd: f.root,
        host: "pty",
        model: "opus",
      }),
    );
    try {
      expect(peer).toMatchObject({ model: "opus", model_source: "request" });
      const listed = (await m.list()).find(
        (r: any) => r.canonical_id === peer.canonical_id,
      );
      expect(listed).toMatchObject({ model: "opus", model_source: "request" });
    } finally {
      await m.stop(peer.canonical_id);
    }
  } finally {
    await m.close();
  }
}, 20000);
