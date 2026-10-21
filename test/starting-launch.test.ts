import { test, expect } from "vitest";
import { spawn } from "node:child_process";
import { join, basename } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { Muster, durableId } from "../src/run.js";
import { TmuxHost } from "../src/hosts/tmux.js";
import { testServer } from "./global-setup.js";
import { fixture, lines } from "./helpers.js";
import { formatHuman } from "../src/format.js";
const metadata = { "workflow.role": "reviewer" };
const provenance = {
  namespace: "workflow",
  session: "example-1",
  launcher: "operator",
  parent: null,
};
const options = [
  "metadata=" + JSON.stringify(metadata),
  "provenance=" + JSON.stringify(provenance),
];

test("starting session exposes reserved display and annotations before readiness", async () => {
  const f = await fixture({ MUSTER_FAKE_ID_MS: "1500" });
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new TmuxHost(testServer("starting-display"))],
  });
  let id: string | undefined;
  const pending = m.run({
    runtime: "claude",
    cwd: f.root,
    prompt: "private prompt",
    title: "review\u0007 fixture",
    options,
  });
  try {
    await expect
      .poll(async () => {
        const rows = await m.list();
        return rows[0]?.state;
      })
      .toBe("starting");
    const row = (await m.list())[0];
    id = row.launch_id;
    expect(row).toMatchObject({
      name: "review fixture",
      title: "review fixture",
      provisional: true,
      cwd: f.root,
      metadata,
      provenance,
    });
    expect(row).not.toHaveProperty("canonical_id");
    expect(formatHuman(row)).toContain("provisional");
    expect(formatHuman(row)).toContain("workflow.role");
    const result = await pending;
    expect(result).not.toHaveProperty("provisional");
    expect((await m.list())[0]).not.toHaveProperty("provisional");
    await m.stop(durableId(result));
    expect((await m.list())[0]).not.toHaveProperty("provisional");
  } finally {
    await pending.catch(() => {});
    if (id) await m.stop(id).catch(() => {});
    await m.close();
  }
});

test("report event precedes spawn, reuses the key and does not affect its fingerprint", async () => {
  const f = await fixture({ MUSTER_FAKE_ID_MS: "1000" });
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new TmuxHost(testServer("report-launch"))],
  });
  const req = {
    runtime: "claude",
    cwd: f.root,
    prompt: "private prompt",
    requestKey: "fixture",
    options,
  };
  const events: any[] = [];
  let startsAtReport: Promise<any[]> | undefined;
  const report = (event: any) => {
    events.push(event);
    startsAtReport = lines(join(f.root, "starts.jsonl"));
  };
  let id: string | undefined;
  const pending = m.run(
    { ...req, options: [...options, "report-launch"] },
    undefined,
    report,
  );
  void pending.catch(() => {});
  try {
    await expect.poll(() => events.length).toBe(1);
    id = events[0].launch_id;
    expect(await startsAtReport).toEqual([]);
    expect(events[0]).toMatchObject({
      event: "launch-reserved",
      state: "starting",
      reused: false,
    });
    expect(JSON.stringify(events)).not.toContain("private prompt");
    const row = (await m.list())[0];
    expect(row).toMatchObject({
      name: basename(f.root) + " · claude",
      provisional: true,
      cwd: f.root,
    });
    await expect(m.run(req)).rejects.toThrow(/already launching/);
    const reused: any[] = [];
    await expect(
      m.run(
        { ...req, options: [...options, "report-launch"] },
        undefined,
        (e) => reused.push(e),
      ),
    ).rejects.toThrow(/already launching/);
    expect(reused[0]).toMatchObject({
      launch_id: id,
      reused: true,
      state: "starting",
    });
    const result = await pending;
    expect(durableId(await m.run(req))).toBe(durableId(result));
    await m.stop(id!);
    const ended: any[] = [];
    await expect(
      m.run(
        { ...req, options: [...options, "report-launch"] },
        undefined,
        (e) => ended.push(e),
      ),
    ).rejects.toThrow();
    expect(ended[0]).toMatchObject({
      launch_id: id,
      reused: true,
      state: "stopped",
    });
  } finally {
    await pending.catch(() => {});
    if (id) await m.stop(id).catch(() => {});
    await m.close();
  }
});

test("refusal before reservation reports no event and missing reporter is refused", async () => {
  const f = await fixture();
  const m = await Muster.create({ home: f.home, env: f.env });
  const events: any[] = [];
  try {
    await expect(
      m.run(
        { runtime: "invalid", prompt: "x", options: ["report-launch"] },
        undefined,
        (e) => events.push(e),
      ),
    ).rejects.toThrow();
    await expect(
      m.run({ runtime: "claude", prompt: "x", options: ["report-launch"] }),
    ).rejects.toThrow(/reporter|CLI/);
    expect(events).toEqual([]);
    expect(await m.registry.all()).toEqual([]);
  } finally {
    await m.close();
  }
});

test("CLI reports reservation on stderr while stdout still waits for readiness failure", async () => {
  const f = await fixture({ MUSTER_FAKE_ID_MS: "10000" });
  await mkdir(join(f.root, ".muster"), { recursive: true });
  await writeFile(
    join(f.root, ".muster", "config.toml"),
    "launch_timeout_sec = 2\n",
  );
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), "dist/muster.js"),
      "run",
      "claude",
      "--host",
      "tmux",
      "--cwd",
      f.root,
      "--prompt",
      "private prompt",
      "--options",
      "report-launch",
    ],
    { env: f.env },
  );
  let out = "",
    err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const closed = new Promise((r) => child.on("close", r));
  try {
    await expect
      .poll(() =>
        err.split("\n").some((l) => l.startsWith('{"event":"launch-reserved"')),
      )
      .toBe(true);
    expect(out).toBe("");
    const event = JSON.parse(
      err.split("\n").find((l) => l.startsWith('{"event":"launch-reserved"'))!,
    );
    expect(event).toMatchObject({ state: "starting", reused: false });
    expect(event.launch_id).toBeTruthy();
    expect(await closed).not.toBe(0);
    expect(out).toBe("");
  } finally {
    child.kill("SIGTERM");
    await closed;
  }
});

test("reporter failure releases only a new reservation without spawning", async () => {
  const f = await fixture();
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    await expect(
      m.run(
        {
          runtime: "claude",
          cwd: f.root,
          prompt: "x",
          options: ["report-launch"],
        },
        undefined,
        () => {
          throw Error("private reporter error");
        },
      ),
    ).rejects.toThrow("Launch reporter failed");
    const entry = (await m.registry.all())[0]!;
    expect(entry.status).toBe("failed");
    expect(entry.root).toBeUndefined();
    expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
    expect(JSON.stringify(entry)).not.toContain("private reporter error");
  } finally {
    await m.close();
  }
});

test("legacy starting rows have a provisional fallback without adding ended fields", async () => {
  const f = await fixture();
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    const { entry } = await m.registry.reserve(
      { runtime: "codex", kind: "task", cwd: f.root },
      10,
    );
    expect((await m.list())[0]).toMatchObject({
      name: basename(f.root) + " · codex",
      title: basename(f.root) + " · codex",
      provisional: true,
      cwd: f.root,
    });
    await m.registry.update(entry.launchId, { status: "failed" });
    expect((await m.list())[0]).not.toHaveProperty("provisional");
    expect((await m.list())[0]).not.toHaveProperty("title");
  } finally {
    await m.close();
  }
});
