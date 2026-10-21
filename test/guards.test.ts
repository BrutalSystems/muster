import { test, expect } from "vitest";
import { writeFile, readFile, mkdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fixture, lines } from "./helpers.js";
import { Muster, durableId } from "../src/run.js";
import { PtyHost } from "../src/hosts/pty.js";

async function setup(kind = "session") {
  const f = await fixture({
    MUSTER_FAKE_VERSION: "2.1.305 (Claude Code)",
    MUSTER_FAKE_TASK_MS: "5000",
  });
  await writeFile(
    join(f.home, "config.toml"),
    "allow_dangerous_flags = true\n",
  );
  const dir = join(f.root, "private-source");
  await mkdir(dir);
  const script = join(dir, "check.sh");
  await writeFile(script, "#!/bin/sh\n# sensitive-fixture-body\nexit 0\n");
  const manifest = {
    version: 1,
    id: "local-policy",
    hooks: [
      {
        event: "PreToolUse",
        script: "check.sh",
        interpreter: "sh",
        timeout: 2,
      },
    ],
    deny: ["Bash(private-deny-pattern:*)"],
  };
  const file = join(dir, "bundle.json");
  await writeFile(file, JSON.stringify(manifest));
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  const req = {
    runtime: "claude",
    kind,
    cwd: f.root,
    prompt: "guard test",
    level: "open",
    mcp: [],
    options: ["inherit-profile", "restrict-mcp", `guard=${file}`],
    requestKey: "guard-test",
  };
  return { f, m, req, manifest, file, script };
}
for (const kind of ["session", "task"])
  test(`guarded ${kind} stages private snapshot, binds retry bytes and retains summary after exit`, async () => {
    const { f, m, req, file, script } = await setup(kind);
    let id: string | undefined;
    try {
      const result = await m.run(req);
      id = durableId(result);
      expect(result).toHaveProperty("guards.bundles.0.id", "local-policy");
      const summary = (result as any).guards;
      expect(summary.bundles[0]).toMatchObject({
        hooks: 1,
        deny_rules: 1,
        events: ["PreToolUse"],
      });
      expect(summary.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(durableId(await m.run(req))).toBe(id);
      const original = JSON.parse(await readFile(file, "utf8"));
      await writeFile(
        file,
        JSON.stringify(
          Object.fromEntries(Object.entries(original).reverse()),
          null,
          2,
        ),
      );
      expect(durableId(await m.run(req))).toBe(id);
      await expect
        .poll(async () => (await lines(join(f.root, "starts.jsonl"))).length)
        .toBeGreaterThan(0);
      const argv = (await lines(join(f.root, "starts.jsonl")))[0]
        .argv as string[];
      const settingsFile = argv[argv.indexOf("--settings") + 1]!;
      const settings = JSON.parse(await readFile(settingsFile, "utf8"));
      expect(settings).toMatchObject({
        sandbox: { enabled: false },
        disableClaudeAiConnectors: true,
        permissions: { deny: ["Bash(private-deny-pattern:*)"] },
      });
      const hook = settings.hooks.PreToolUse[0].hooks[0];
      expect(hook).toMatchObject({
        type: "command",
        onFailure: "block",
        timeout: 4,
      });
      expect((await stat(settingsFile)).mode & 0o777).toBe(0o600);
      const descriptor = JSON.parse(await readFile(hook.args[1], "utf8"));
      expect(await readFile(descriptor.args[0], "utf8")).toContain(
        "sensitive-fixture-body",
      );
      const log = await readFile(join(f.home, "launches.jsonl"), "utf8");
      for (const privateValue of [
        file,
        "private-deny-pattern",
        "sensitive-fixture-body",
      ])
        expect(log).not.toContain(privateValue);
      expect(argv.join(" ")).not.toContain(file);
      expect(argv.join(" ")).not.toContain("private-deny-pattern");
      await writeFile(script, "#!/bin/sh\nexit 2\n");
      await expect(m.run(req)).rejects.toThrow(/different parameters/);
      expect(await readFile(descriptor.args[0], "utf8")).toContain(
        "sensitive-fixture-body",
      );
      const entry = (await m.registry.all())[0]!;
      await m.registry.update(entry.launchId, {
        peer: { ...entry.peer, guards: { digest: "spoof", bundles: [] } },
      });
      expect((await m.list())[0]).toHaveProperty("guards", summary);
      expect(JSON.stringify(entry)).not.toContain("private-source");
      expect(JSON.stringify(entry)).not.toContain("private-deny-pattern");
      await expect(
        m.registry.update(entry.launchId, { guards: {} } as any),
      ).rejects.toThrow(/recorded once/);
      await m.stop(id);
      expect((await m.wait(id, { timeoutMs: 100 })).record).toHaveProperty(
        "guards",
        summary,
      );
      expect((await m.list())[0]).toHaveProperty("guards", summary);
      await expect(stat(settingsFile)).rejects.toThrow();
    } finally {
      if (id) await m.stop(id).catch(() => {});
      await m.close();
    }
  });
test("invalid guard bundles refuse without leaking source paths or creating reservations", async () => {
  const { m, req, file, manifest, script } = await setup();
  try {
    for (const invalid of [
      { ...manifest, extra: true },
      { ...manifest, hooks: [] },
      {
        ...manifest,
        hooks: [{ ...manifest.hooks[0], script: "../escape.sh" }],
      },
      { ...manifest, hooks: [{ ...manifest.hooks[0], async: true }] },
    ]) {
      await writeFile(file, JSON.stringify(invalid));
      try {
        await m.run(req);
        throw new Error("unexpected success");
      } catch (e) {
        expect((e as Error).message).toMatch(/guard/i);
        expect((e as Error).message).not.toContain(file);
      }
    }
    await writeFile(file, JSON.stringify(manifest));
    await expect(
      m.run({
        ...req,
        runtime: "codex",
        options: req.options.filter((s) => s !== "restrict-mcp"),
      }),
    ).rejects.toThrow(/guard.*Claude|Claude.*guard/i);
    expect(await m.registry.all()).toEqual([]);
  } finally {
    await m.close();
  }
});

test("guard admission rejects duplicate keys, symlinks, oversized scripts and disabled hooks", async () => {
  const { f, m, req, file, manifest, script } = await setup();
  try {
    await writeFile(
      file,
      JSON.stringify(manifest).replace(
        '"version":1',
        '"version":1,"version":1',
      ),
    );
    await expect(m.run(req)).rejects.toThrow(/Guard bundle refused/);
    await writeFile(file, JSON.stringify(manifest));
    await writeFile(script, Buffer.alloc(1024 * 1024 + 1));
    await expect(m.run(req)).rejects.toThrow(/Guard bundle refused/);
    await writeFile(script, "exit 0\n");
    const linked = join(f.root, "linked.sh");
    await symlink(script, linked);
    await writeFile(
      file,
      JSON.stringify({
        ...manifest,
        hooks: [{ ...manifest.hooks[0], script: "link.sh" }],
      }),
    );
    await symlink(script, join(f.root, "private-source", "link.sh"));
    await expect(m.run(req)).rejects.toThrow(/Guard bundle refused/);
    await writeFile(file, JSON.stringify(manifest));
    await mkdir(join(f.root, ".claude"), { recursive: true });
    await writeFile(
      join(f.root, ".claude", "settings.json"),
      JSON.stringify({ disableAllHooks: true }),
    );
    await expect(m.run(req)).rejects.toThrow(/Guard launch refused/);
    expect(await m.registry.all()).toEqual([]);
  } finally {
    await m.close();
  }
});

test("guard runtime is rechecked immediately before spawn", async () => {
  const { f, m, req } = await setup();
  await m.close();
  const bin = join(f.root, "runtime-bin");
  await mkdir(bin);
  const count = join(f.root, "version-count");
  await writeFile(
    join(bin, "claude"),
    `#!${process.execPath}\nconst fs=require('fs');const p=${JSON.stringify(count)};const old=fs.existsSync(p);fs.writeFileSync(p,'checked');console.log(old?'2.1.100 (Claude Code)':'2.1.305 (Claude Code)');`,
    { mode: 0o700 },
  );
  const instance = await Muster.create({
    home: f.home,
    env: { ...f.env, PATH: bin + ":" + f.env.PATH },
    drivers: [new PtyHost()],
  });
  try {
    await expect(
      instance.run({
        ...req,
        options: req.options.filter((s) => s !== "restrict-mcp"),
      }),
    ).rejects.toThrow(/Guard.*version/);
    const entry = (await instance.registry.all())[0]!;
    expect(entry.status).toBe("failed");
    expect(entry.root).toBeUndefined();
    await expect(
      stat(join(f.home, "guards", entry.launchId)),
    ).rejects.toThrow();
  } finally {
    await instance.close();
  }
});

test("a FIFO guard manifest is refused promptly", async () => {
  const { f, m, req, file } = await setup();
  const { execFileSync } = await import("node:child_process");
  const { open, rm } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  await rm(file);
  execFileSync("mkfifo", [file]);
  const { snapshotGuards } = await import("../src/guards.js");
  const pending = snapshotGuards(req.options, f.root).then(
    () => "launched",
    () => "refused",
  );
  const result = await Promise.race([
    pending,
    new Promise((r) => setTimeout(() => r("timeout"), 300)),
  ]);
  if (result === "timeout") {
    const fd = await open(file, constants.O_RDWR | constants.O_NONBLOCK);
    await pending;
    await fd.close();
  }
  await m.close();
  expect(result).toBe("refused");
});

test("guard cleanup failure does not strand the identity or hide ended records", async () => {
  const { f, m, req } = await setup();
  const { chmod, rm } = await import("node:fs/promises");
  let id: string | undefined;
  let directory: string | undefined;
  try {
    const run = await m.run(req);
    id = durableId(run);
    const entry = (await m.registry.all())[0]!;
    directory = join(f.home, "guards", entry.launchId);
    const identity = join(f.root, "identity-copy");
    await mkdir(identity);
    await writeFile(join(identity, "private"), "private");
    await m.registry.update(entry.launchId, { identityPath: identity });
    await chmod(directory, 0o500);
    await chmod(join(directory, "0"), 0o500);
    await m.stop(id);
    expect((await m.wait(id, { timeoutMs: 100 })).done).toBe(true);
    await expect(stat(identity)).rejects.toThrow();
    expect(await stat(directory)).toBeDefined();
    const audit = (await lines(join(f.home, "launches.jsonl"))).filter(
      (e) => e.event === "cleanup_pending",
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]).toMatchObject({
      launch_id: entry.launchId,
      artifact: "guards",
    });
  } finally {
    if (directory) {
      await chmod(directory, 0o700).catch(() => {});
      await chmod(join(directory, "0"), 0o700).catch(() => {});
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    if (id) await m.stop(id).catch(() => {});
    await m.close();
  }
});
