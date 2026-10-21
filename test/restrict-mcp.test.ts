import { test, expect } from "vitest";
import TOML from "@iarna/toml";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { configSchema } from "../src/config.js";
import {
  launchArgs,
  runSchema,
  paramsFingerprint,
  LEVELS,
} from "../src/guard.js";
import { Muster, durableId } from "../src/run.js";
import { PtyHost } from "../src/hosts/pty.js";
import { fixture, lines } from "./helpers.js";
const config = configSchema.parse({ allow_dangerous_flags: true });
const request = (extra: Record<string, unknown> = {}) =>
  runSchema.parse({
    runtime: "claude",
    prompt: "restricted profile",
    level: "open",
    mcp: [],
    options: ["inherit-profile", "restrict-mcp"],
    ...extra,
  });
test("restricted profile generates exact empty MCP config without sealing rules/hooks", () => {
  const args = launchArgs(request(), config);
  expect(args).toContain("--strict-mcp-config");
  expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!)).toEqual({
    mcpServers: {},
  });
  expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toMatchObject({
    disableClaudeAiConnectors: true,
  });
  expect(args).toContain("--no-chrome");
  expect(args).not.toContain("--setting-sources");
  expect(JSON.stringify(args)).not.toContain("disableAllHooks");
});
test("restricted profile requires explicit MCP choice and supported launch mode", () => {
  for (const extra of [
    { mcp: undefined },
    { runtime: "codex" },
    { runtime: "opencode" },
    { options: ["restrict-mcp"] },
    { level: "work" },
  ])
    expect(() => launchArgs(request(extra), config)).toThrow(
      /restrict-mcp|inherit-profile/,
    );
});
test("restricted profile selection changes retry identity without changing additive defaults", () => {
  const restricted = request();
  const additive = request({ options: ["inherit-profile"] });
  expect(paramsFingerprint(restricted, LEVELS.open, [], [])).not.toBe(
    paramsFingerprint(additive, LEVELS.open, [], []),
  );
  expect(
    paramsFingerprint(
      request({ mcp: ["beta", "alpha"] }),
      LEVELS.open,
      ["beta", "alpha"],
      [],
    ),
  ).toBe(
    paramsFingerprint(
      request({ mcp: ["alpha", "beta"] }),
      LEVELS.open,
      ["alpha", "beta"],
      [],
    ),
  );
  expect(launchArgs(additive, config)).not.toContain("--strict-mcp-config");
});
for (const kind of ["session", "task"] as const)
  test(`restricted ${kind} facts are immutable and retained through retry and exit`, async () => {
    const f = await fixture({
      MUSTER_FAKE_VERSION: "2.1.305 (Claude Code)",
      MUSTER_FAKE_TASK_MS: "5000",
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
    let id: string | undefined;
    try {
      const req = {
        ...request({ cwd: f.root, kind }),
        requestKey: "restrict-test",
      };
      const result = await m.run(req);
      id = durableId(result);
      const expected = { mode: "explicit", servers: [], claude_ai: false };
      expect(result).toHaveProperty("mcp_selection", expected);
      expect(await m.run(req)).toHaveProperty("mcp_selection", expected);
      await expect(
        m.run({ ...req, options: ["inherit-profile"] }),
      ).rejects.toThrow(/different parameters/);
      const entry = (await m.registry.all())[0]!;
      await expect(
        m.registry.update(entry.launchId, {
          mcp_selection: {
            mode: "explicit",
            servers: ["muster:other"],
            claude_ai: false,
          },
        } as any),
      ).rejects.toThrow(/recorded once/);
      await expect
        .poll(async () => (await lines(join(f.root, "starts.jsonl"))).length)
        .toBeGreaterThan(0);
      const invocations = await lines(join(f.root, "starts.jsonl"));
      expect(
        invocations.some((x) => x.argv?.includes("--strict-mcp-config")),
      ).toBe(true);
      await m.stop(id);
      expect((await m.list())[0]).toHaveProperty("mcp_selection", expected);
      expect((await m.wait(id, { timeoutMs: 100 })).record).toHaveProperty(
        "mcp_selection",
        expected,
      );
    } finally {
      if (id) await m.stop(id).catch(() => {});
      await m.close();
    }
  });
test("unsupported Claude version refuses before reservation", async () => {
  const f = await fixture({ MUSTER_FAKE_VERSION: "2.1.100 (Claude Code)" });
  await writeFile(
    join(f.home, "config.toml"),
    "allow_dangerous_flags = true\n",
  );
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    await expect(m.run(request({ cwd: f.root }))).rejects.toThrow(
      /Claude.*2.1.305/,
    );
    expect(await m.registry.all()).toEqual([]);
  } finally {
    await m.close();
  }
});

test("selected server IDs and bridge names remain stable through retries and exit", async () => {
  const f = await fixture({ MUSTER_FAKE_VERSION: "2.1.305 (Claude Code)" });
  const definition = {
    command: process.execPath,
    args: [join(process.cwd(), "test/fakes/mcp.mjs")],
    tools: ["ping"],
    required: true,
  };
  await writeFile(
    join(f.home, "config.toml"),
    TOML.stringify({
      allow_dangerous_flags: true,
      mcp_servers: { alpha: definition, beta: definition },
    }),
  );
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  let id: string | undefined;
  try {
    const req = {
      ...request({ cwd: f.root, mcp: ["beta", "alpha"] }),
      requestKey: "selected",
    };
    const result = await m.run(req);
    id = durableId(result);
    const expected = {
      mode: "explicit",
      servers: ["muster:alpha", "muster:beta"],
      claude_ai: false,
    };
    expect(result).toHaveProperty("mcp_selection", expected);
    expect(durableId(await m.run({ ...req, mcp: ["alpha", "beta"] }))).toBe(id);
    await expect(m.run({ ...req, mcp: ["alpha"] })).rejects.toThrow(
      /different parameters/,
    );
    const argv = (await lines(join(f.root, "starts.jsonl")))[0]
      .argv as string[];
    expect(
      Object.keys(
        JSON.parse(argv[argv.indexOf("--mcp-config") + 1]!).mcpServers,
      ).sort(),
    ).toEqual(["alpha", "beta"]);
    const entry = (await m.registry.all())[0]!;
    await m.registry.update(entry.launchId, {
      peer: {
        ...entry.peer,
        mcp_selection: {
          mode: "explicit",
          servers: ["spoof"],
          claude_ai: true,
        },
      },
    });
    expect((await m.list())[0]).toHaveProperty("mcp_selection", expected);
    await m.stop(id);
    expect((await m.wait(id, { timeoutMs: 100 })).record).toHaveProperty(
      "mcp_selection",
      expected,
    );
  } finally {
    if (id) await m.stop(id).catch(() => {});
    await m.close();
  }
});
test("managed policy and unknown selection refuse before reservation", async () => {
  const f = await fixture({ MUSTER_FAKE_VERSION: "2.1.305 (Claude Code)" });
  await writeFile(
    join(f.home, "config.toml"),
    "allow_dangerous_flags = true\n",
  );
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    await expect(
      m.run(request({ cwd: f.root, mcp: ["missing"] })),
    ).rejects.toThrow(/missing/);
    await mkdir(join(f.root, ".claude"), { recursive: true });
    await writeFile(
      join(f.root, ".claude", "remote-settings.json"),
      JSON.stringify({ permissions: {} }),
    );
    await expect(m.run(request({ cwd: f.root }))).rejects.toThrow(
      /Managed Claude policy/,
    );
    expect(await m.registry.all()).toEqual([]);
  } finally {
    await m.close();
  }
});
