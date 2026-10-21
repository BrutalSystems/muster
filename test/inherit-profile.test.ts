import { expect, test } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configSchema } from "../src/config.js";
import {
  launchArgs,
  runSchema,
  LEVELS,
  paramsFingerprint,
} from "../src/guard.js";
import { assertOptionsSupported } from "../src/options.js";
import { selectMcp } from "../src/mcp.js";
import { Muster, durableId } from "../src/run.js";
import { PtyHost } from "../src/hosts/pty.js";
import { fixture, lines } from "./helpers.js";

const dangerous = configSchema.parse({ allow_dangerous_flags: true });
const request = (extra: Record<string, unknown> = {}) =>
  runSchema.parse({
    runtime: "claude",
    prompt: "hello",
    level: "open",
    options: ["inherit-profile"],
    ...extra,
  });

test("profile bypass retains Claude's setting sources and adds only explicit permission overrides", async () => {
  const f = await fixture();
  await mkdir(join(f.root, ".claude"));
  await writeFile(
    join(f.root, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { defaultMode: "bypassPermissions" },
      hooks: { SessionStart: [] },
    }),
  );
  const argv = launchArgs(
    request({
      cwd: f.root,
      options: ["inherit-profile", "accept-bypass-warning"],
      args: ["--plugin-dir", f.root],
    }),
    dangerous,
    [],
    undefined,
    f.env,
  );
  expect(argv).not.toContain("--setting-sources");
  expect(argv).not.toContain("--strict-mcp-config");
  expect(argv).toContain("--plugin-dir");
  expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
  expect(JSON.parse(argv[argv.indexOf("--settings") + 1]!)).toEqual({
    sandbox: { enabled: false },
    skipDangerousModePermissionPrompt: true,
  });
  expect(() =>
    launchArgs(
      request({ cwd: f.root, level: "normal", options: [] }),
      dangerous,
      [],
      undefined,
      f.env,
    ),
  ).toThrow(/bypass/);
  expect(() => launchArgs(request(), configSchema.parse({}))).toThrow(
    /allow_dangerous_flags/,
  );
});

test("inherit-profile refuses unsupported runtimes and restricted permissions", () => {
  for (const runtime of ["claude", "codex"] as const) {
    expect(() =>
      assertOptionsSupported(runtime, ["inherit-profile"], LEVELS.open),
    ).not.toThrow();
    for (const level of [LEVELS.read, LEVELS.work, LEVELS.normal])
      expect(() =>
        assertOptionsSupported(runtime, ["inherit-profile"], level),
      ).toThrow(/inherit-profile/);
  }
  expect(() =>
    assertOptionsSupported("opencode", ["inherit-profile"], LEVELS.open),
  ).toThrow(/inherit-profile/);
});

test("profile loading is explicit and changes the retry identity without changing legacy fingerprints", () => {
  const old = request({ options: [] });
  expect(paramsFingerprint(old, LEVELS.open, [], [])).not.toBe(
    paramsFingerprint(request(), LEVELS.open, [], []),
  );
  const cfg = configSchema.parse({ default_mcp: ["missing"] });
  expect(selectMcp(request(), cfg)).toEqual([]);
  expect(() => selectMcp(request({ mcp: ["missing"] }), cfg)).toThrow(
    /Unknown MCP/,
  );
});

for (const runtime of ["claude", "codex"] as const)
  for (const kind of ["session", "task"] as const)
    test(`${runtime} ${kind} inherits its profile and retains the immutable choice through exit`, async () => {
      const f = await fixture({
        MUSTER_FAKE_TASK_MS: "5000",
        MUSTER_FAKE_MCP: "inherited",
      });
      await writeFile(
        join(f.home, "config.toml"),
        "allow_dangerous_flags = true\n",
      );
      const m = await Muster.create({
        home: f.home,
        env: f.env,
        drivers: [new PtyHost()],
      });
      const req = {
        runtime,
        kind,
        cwd: f.root,
        prompt: "hello",
        ...(kind === "session" ? { host: "pty" } : {}),
        level: "open",
        options: ["inherit-profile"],
        requestKey: "profile",
      };
      try {
        const result = await m.run(req);
        const id = durableId(result);
        expect(result).toMatchObject({
          inherit_profile: true,
          permissions: "bypass",
          sandbox: "full-access",
          enforcement: "none",
        });
        expect((await m.list())[0]).toMatchObject({ inherit_profile: true });
        expect((await m.wait(id, { timeoutMs: 0 })).record).toMatchObject({
          inherit_profile: true,
        });
        expect(durableId(await m.run(req))).toBe(id);
        await expect(m.run({ ...req, options: [] })).rejects.toThrow(
          /request key/i,
        );
        const entry = (await m.registry.all())[0]!;
        await expect(
          m.registry.update(entry.launchId, { inherit_profile: false } as any),
        ).rejects.toThrow(/cannot be updated/);
        await expect
          .poll(async () => (await lines(join(f.root, "starts.jsonl"))).length)
          .toBe(1);
        const argv = (await lines(join(f.root, "starts.jsonl")))[0]
          .argv as string[];
        if (runtime === "codex") {
          expect(argv).not.toContain("--ignore-user-config");
          expect(argv).not.toContain("--disable");
          expect(argv.join(" ")).not.toContain(
            "mcp_servers.inherited.enabled=false",
          );
          expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
        } else {
          expect(argv).not.toContain("--strict-mcp-config");
          expect(argv).not.toContain("--setting-sources");
        }
        await m.stop(id);
        expect((await m.wait(id, { timeoutMs: 3000 })).record).toMatchObject({
          inherit_profile: true,
        });
      } finally {
        await m.close();
      }
    });

test("inherit-profile still refuses auto-trusting workspace hooks", async () => {
  const f = await fixture();
  await writeFile(
    join(f.home, "config.toml"),
    "allow_dangerous_flags = true\n",
  );
  await mkdir(join(f.root, ".claude"));
  await writeFile(
    join(f.root, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: [] } }),
  );
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  try {
    await expect(
      m.run({
        runtime: "claude",
        prompt: "hi",
        cwd: f.root,
        level: "open",
        options: ["inherit-profile", "auto-approve-path"],
      }),
    ).rejects.toThrow(/ships hooks/);
    expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
  } finally {
    await m.close();
  }
});

test("profile bypass refuses detected managed policy before reservation", async () => {
  const f = await fixture();
  await mkdir(join(f.root, ".claude"));
  await writeFile(
    join(f.root, ".claude", "remote-settings.json"),
    JSON.stringify({ sandbox: { enabled: true } }),
  );
  await writeFile(
    join(f.home, "config.toml"),
    "allow_dangerous_flags = true\n",
  );
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  try {
    await expect(
      m.run({
        runtime: "claude",
        cwd: f.root,
        prompt: "hi",
        level: "open",
        options: ["inherit-profile"],
      }),
    ).rejects.toThrow(/Managed Claude policy/);
    expect(await m.registry.all()).toEqual([]);
  } finally {
    await m.close();
  }
});

test("legacy records cannot acquire a profile choice from peer data", async () => {
  const f = await fixture();
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    const { entry } = await m.registry.reserve(
      { runtime: "claude", kind: "session", cwd: f.root },
      4,
    );
    await m.registry.update(entry.launchId, {
      status: "exited",
      peer: { inherit_profile: true },
    });
    expect((await m.list())[0]).not.toHaveProperty("inherit_profile");
    expect((await m.wait(entry.launchId)).record).not.toHaveProperty(
      "inherit_profile",
    );
    await expect(
      m.registry.update(entry.launchId, { inherit_profile: true }),
    ).rejects.toThrow(/cannot be updated/);
  } finally {
    await m.close();
  }
});
