import { expect, test } from "vitest";
import { join } from "node:path";
import { recordedOptions } from "../src/options.js";
import { Muster, durableId } from "../src/run.js";
import { PtyHost } from "../src/hosts/pty.js";
import { fixture, lines } from "./helpers.js";

/**
 * The named options change what a launch is allowed to do — trust a folder,
 * skip the bypass warning, take work from any local session — so they are
 * recorded once at reservation and returned by run/list/wait, the way
 * `inherit_profile` is. A controller can then see whether a worker will act on
 * a message before it sends one, and an audit can see what a launch consented to.
 */
test("only the named options are recorded, once each, in a fixed order", () => {
  expect(
    recordedOptions([
      "accept-cross-session",
      'metadata={"role":"worker"}',
      "report-launch",
      "inherit-profile",
      "guard=bundle.json",
      "accept-cross-session",
    ]),
  ).toEqual(["inherit-profile", "accept-cross-session"]);
  expect(recordedOptions([])).toEqual([]);
});

for (const kind of ["session", "task"] as const)
  test(`a ${kind} reports the options it was launched with, and they cannot change`, async () => {
    const f = await fixture({ MUSTER_FAKE_TASK_MS: "5000" });
    const m = await Muster.create({
      home: f.home,
      env: f.env,
      drivers: [new PtyHost()],
    });
    const req = {
      runtime: "claude",
      kind,
      cwd: f.root,
      prompt: "hello",
      ...(kind === "session" ? { host: "pty" } : {}),
      options: ["accept-cross-session", 'metadata={"role":"worker"}'],
      requestKey: "recorded-options",
    };
    try {
      const result = await m.run(req);
      const id = durableId(result);
      expect(result).toMatchObject({
        launch_options: ["accept-cross-session"],
      });
      expect((await m.list())[0]).toMatchObject({
        launch_options: ["accept-cross-session"],
      });
      expect((await m.wait(id, { timeoutMs: 0 })).record).toMatchObject({
        launch_options: ["accept-cross-session"],
      });
      const entry = (await m.registry.all())[0]!;
      await expect(
        m.registry.update(entry.launchId, { launch_options: [] } as any),
      ).rejects.toThrow(/cannot be updated/);
      const intent = (await lines(join(f.home, "launches.jsonl"))).find(
        (e) => e.event === "intent",
      );
      expect(intent).toMatchObject({
        launch_options: ["accept-cross-session"],
      });
      await m.stop(id);
      expect((await m.wait(id, { timeoutMs: 3000 })).record).toMatchObject({
        launch_options: ["accept-cross-session"],
      });
    } finally {
      await m.close();
    }
  });

test("a launch with no named options says so rather than omitting the field", async () => {
  // Absent means a record from before the field existed; [] means none asked.
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "5000" });
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    const result = await m.run({
      runtime: "claude",
      kind: "task",
      cwd: f.root,
      prompt: "hello",
    });
    expect(result).toMatchObject({ launch_options: [] });
    await m.stop(durableId(result));
  } finally {
    await m.close();
  }
});

test("legacy records cannot acquire launch options from peer data", async () => {
  const f = await fixture();
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    const { entry } = await m.registry.reserve(
      { runtime: "claude", kind: "session", cwd: f.root },
      4,
    );
    await m.registry.update(entry.launchId, {
      status: "exited",
      peer: { launch_options: ["accept-cross-session"] } as any,
    });
    expect((await m.list())[0]).not.toHaveProperty("launch_options");
    expect((await m.wait(entry.launchId)).record).not.toHaveProperty(
      "launch_options",
    );
  } finally {
    await m.close();
  }
});
