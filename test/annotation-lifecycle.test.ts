import { expect, test } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { Muster, durableId } from "../src/run.js";
import { Registry } from "../src/registry.js";
import { TmuxHost } from "../src/hosts/tmux.js";
import { testServer } from "./global-setup.js";
import { PtyHost } from "../src/hosts/pty.js";
import { fixture, lines } from "./helpers.js";
import { formatHuman } from "../src/format.js";

const metadata = {
  "workflow.role": "reviewer",
  "workflow.versions": "rules@4",
};
const provenance = {
  namespace: "workflow",
  session: "run-002",
  launcher: "controller",
  parent: "run-001",
};
const options = [
  "metadata=" + JSON.stringify(metadata),
  "provenance=" + JSON.stringify(provenance),
];
const annotations = { metadata, provenance };

for (const runtime of ["claude", "codex", "opencode"] as const)
  for (const [kind, host] of [
    ["session", "pty"],
    ["session", "tmux"],
    ["task", undefined],
  ] as const)
    test(`${runtime} ${kind} ${host ?? "worker"} keeps annotations through launch, retry, wait and exit`, async () => {
      const f = await fixture({ MUSTER_FAKE_TASK_MS: "5000" });
      const m = await Muster.create({
        home: f.home,
        env: f.env,
        drivers:
          host === "tmux"
            ? [new TmuxHost(testServer("annotations-" + runtime))]
            : [new PtyHost()],
      });
      const req = {
        runtime,
        kind,
        cwd: f.root,
        prompt: "annotated launch",
        options,
        requestKey: "annotated",
        ...(host ? { host } : {}),
      };
      try {
        const result = await m.run(req);
        expect(result).toMatchObject(annotations);
        const id = durableId(result);
        expect((await m.list())[0]).toMatchObject(annotations);
        expect((await m.wait(id, { timeoutMs: 0 })).record).toMatchObject(
          annotations,
        );
        const stored = (await m.registry.all())[0]!;
        expect(stored).toMatchObject({
          ...annotations,
          requester: { kind: "local" },
        });
        expect((await new Registry(f.home).all())[0]).toMatchObject(
          annotations,
        );
        const repeated = await m.run({
          ...req,
          options: [
            'provenance={"parent":"run-001","launcher":"controller","session":"run-002","namespace":"workflow"}',
            'metadata={ "workflow.versions":"rules@4", "workflow.role":"reviewer" }',
          ],
        });
        expect(durableId(repeated)).toBe(id);
        expect(repeated).toMatchObject(annotations);
        await expect(
          m.run({
            ...req,
            options: [options[0]!, options[1]!.replace("run-001", "run-009")],
          }),
        ).rejects.toThrow(/request key/i);
        expect(await m.registry.all()).toHaveLength(1);
        for (const patch of [
          { metadata: {} },
          { provenance: { ...provenance, parent: null } },
          { metadata: undefined },
        ])
          await expect(
            m.registry.update(stored.launchId, patch),
          ).rejects.toThrow(/cannot be updated/);
        const starts = await lines(join(f.root, "starts.jsonl"));
        expect(JSON.stringify(starts)).not.toContain("workflow.role");
        expect(JSON.stringify(starts)).not.toContain("run-002");
        await m.stop(id);
        const ended = await m.wait(id, { timeoutMs: 3000 });
        expect(ended.done).toBe(true);
        expect(ended.record).toMatchObject(annotations);
        expect((await m.list())[0]).toMatchObject(annotations);
        expect(formatHuman(ended.record, false)).toContain("workflow.role");
        expect(formatHuman(ended.record, false)).toContain("run-001");
      } finally {
        await m.close();
      }
    });

test("invalid annotations leave no reservation or launched process", async () => {
  const f = await fixture();
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    for (const option of [
      'metadata={"x":"a","x":"b"}',
      'provenance={"namespace":"workflow","session":"run-002","launcher":"controller"}',
    ])
      await expect(
        m.run({
          runtime: "codex",
          prompt: "invalid",
          cwd: f.root,
          options: [option],
        }),
      ).rejects.toThrow();
    expect(await m.registry.all()).toEqual([]);
    expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
  } finally {
    await m.close();
  }
});

test("legacy records stay unannotated and failed reservations preserve explicit roots", async () => {
  const f = await fixture();
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  try {
    const old = await m.registry.reserve(
      { runtime: "codex", kind: "task", cwd: f.root },
      4,
    );
    await m.registry.update(old.entry.launchId, { status: "exited" });
    const view = (await m.wait(old.entry.launchId)).record;
    expect(view).not.toHaveProperty("metadata");
    expect(view).not.toHaveProperty("provenance");
    await expect(
      m.registry.update(old.entry.launchId, { metadata }),
    ).rejects.toThrow(/cannot be updated/);
    const pending = await m.registry.reserve(
      {
        runtime: "codex",
        kind: "task",
        cwd: f.root,
        metadata,
        provenance: { ...provenance, parent: null },
      },
      4,
    );
    await m.registry.update(pending.entry.launchId, {
      status: "failed",
      error: "fixture failure",
    });
    expect((await m.wait(pending.entry.launchId)).record).toMatchObject({
      metadata,
      provenance: { ...provenance, parent: null },
      state: "failed",
    });
    expect(
      JSON.parse(await readFile(join(f.home, "registry.json"), "utf8"))[1],
    ).toMatchObject({ metadata, provenance: { ...provenance, parent: null } });
  } finally {
    await m.close();
  }
});

test("peer refresh data cannot invent annotations absent from the reservation", async () => {
  const f = await fixture();
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    const { entry } = await m.registry.reserve(
      { runtime: "claude", kind: "session", cwd: f.root },
      4,
    );
    await m.registry.update(entry.launchId, {
      status: "exited",
      peer: { metadata, provenance },
    });
    const listed = (await m.list())[0];
    expect(listed).not.toHaveProperty("metadata");
    expect(listed).not.toHaveProperty("provenance");
    expect((await m.wait(entry.launchId)).record).not.toHaveProperty(
      "metadata",
    );
  } finally {
    await m.close();
  }
});
