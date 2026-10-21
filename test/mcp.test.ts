import { test, expect } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { once } from "node:events";
import { fixture, lines } from "./helpers.js";
import { asSession, asTask } from "./narrow.js";
import { Muster } from "../src/run.js";
import { configSchema, loadConfig } from "../src/config.js";
import { runSchema } from "../src/guard.js";

const definition = {
  command: process.execPath,
  args: [join(process.cwd(), "test/fakes/mcp.mjs")],
  tools: ["ping"],
  required: true,
};
async function setup(extra = {}) {
  const f = await fixture({ MUSTER_FAKE_MCP: "inherited" });
  await writeFile(
    join(f.home, "config.toml"),
    TOML.stringify({
      default_mcp: ["fixture"],
      mcp_servers: { fixture: definition },
      ...extra,
    }),
  );
  return { f, m: await Muster.create({ home: f.home, env: f.env }) };
}
test("MCP is optional and shipped defaults require no server", () => {
  expect(configSchema.parse({}).default_mcp).toEqual([]);
  expect(configSchema.parse({}).mcp_servers).toEqual({});
});
test("MCP selection accepts explicit none and rejects unsafe names", () => {
  expect(
    runSchema.parse({ runtime: "codex", prompt: "test", mcp: [] }).mcp,
  ).toEqual([]);
  expect(() =>
    runSchema.parse({ runtime: "codex", prompt: "test", mcp: ["bad.name"] }),
  ).toThrow();
});
for (const runtime of ["codex", "claude"] as const) {
  test(`${runtime} receives only selected MCP definitions and tool permissions`, async () => {
    const { f, m } = await setup();
    const peer = asSession(
      await m.run({
        runtime,
        prompt: "MCP configured",
        cwd: f.root,
        host: "pty",
        // Sealed: a normal claude launch takes no default MCP (pinned below).
        level: "read",
      }),
    );
    try {
      expect(peer.mcp).toEqual(["fixture"]);
      const args = (await lines(join(f.root, "starts.jsonl")))[0]
        .argv as string[];
      if (runtime === "codex") {
        const overrides = args
          .filter((_, i) => args[i - 1] === "-c")
          .join("\n");
        expect(overrides).toContain("mcp_servers.inherited.enabled=false");
        const cfg = TOML.parse(overrides) as any;
        expect(cfg.mcp_servers.fixture).toMatchObject({
          command: process.execPath,
          enabled: true,
          required: true,
          enabled_tools: ["ping"],
        });
      } else {
        const bridge = JSON.parse(args[args.indexOf("--mcp-config") + 1]!)
          .mcpServers.fixture;
        expect(bridge.command).toBe(process.execPath);
        expect(bridge.args[0]).toMatch(/mcp-bridge.js$/);
        expect(bridge.args[2]).toBe("fixture");
        expect(
          JSON.parse(await readFile(bridge.args[1], "utf8")).fixture.tools,
        ).toEqual(["ping"]);
        const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
        expect(settings.permissions.allow).toContain("mcp__fixture__ping");
        expect(settings.permissions.deny).toContain("mcp__fixture__erase");
      }
      expect((await m.list())[0].mcp).toEqual(["fixture"]);
      expect((await lines(join(f.home, "launches.jsonl")))[0].mcp).toEqual([
        "fixture",
      ]);
    } finally {
      await m.stop(peer.canonical_id);
      await m.close();
    }
  }, 15_000);
  test(`${runtime} explicit empty MCP selection clears defaults`, async () => {
    const { f, m } = await setup({
      mcp_servers: { fixture: { ...definition, command: "/missing/mcp" } },
    });
    const peer = asSession(
      await m.run({
        runtime,
        prompt: "no tools",
        cwd: f.root,
        host: "pty",
        mcp: [],
      }),
    );
    try {
      expect(peer.mcp).toEqual([]);
    } finally {
      await m.stop(peer.canonical_id);
      await m.close();
    }
  });
}
test("a normal claude session takes the profile's MCP servers, not muster's defaults", async () => {
  const { f, m } = await setup();
  const peer = asSession(
    await m.run({
      runtime: "claude",
      prompt: "normal",
      cwd: f.root,
      host: "pty",
    }),
  );
  try {
    expect(peer.mcp).toEqual([]);
    expect(peer.permissions).toBe("normal");
    const args = (await lines(join(f.root, "starts.jsonl")))[0]
      .argv as string[];
    for (const flag of [
      "--setting-sources",
      "--strict-mcp-config",
      "--settings",
      "--mcp-config",
      "--permission-mode",
    ])
      expect(args).not.toContain(flag);
  } finally {
    await m.stop(peer.canonical_id);
    await m.close();
  }
});
test("a normal claude launch adds a named MCP server beside the profile's", async () => {
  const { f, m } = await setup();
  const peer = asSession(
    await m.run({
      runtime: "claude",
      prompt: "normal plus",
      cwd: f.root,
      host: "pty",
      mcp: ["fixture"],
    }),
  );
  try {
    expect(peer.mcp).toEqual(["fixture"]);
    const args = (await lines(join(f.root, "starts.jsonl")))[0]
      .argv as string[];
    expect(args).toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
  } finally {
    await m.stop(peer.canonical_id);
    await m.close();
  }
});
test("unknown requested server fails before launching an agent", async () => {
  const { f, m } = await setup();
  try {
    await expect(
      m.run({
        runtime: "claude",
        prompt: "missing",
        cwd: f.root,
        mcp: ["missing"],
      }),
    ).rejects.toThrow(/Unknown MCP server.*missing/);
    expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
  } finally {
    await m.close();
  }
});
test("optional unavailable default is skipped; explicit request makes it required", async () => {
  const { f, m } = await setup({
    mcp_servers: {
      fixture: { ...definition, command: "/missing/mcp", required: false },
    },
  });
  const peer = asSession(
    await m.run({
      runtime: "claude",
      prompt: "optional",
      cwd: f.root,
      host: "pty",
      level: "read",
    }),
  );
  try {
    expect(peer.mcp).toEqual([]);
    expect(peer.mcp_warnings?.[0]).toContain("fixture");
    await expect(
      m.run({
        runtime: "claude",
        prompt: "required",
        cwd: f.root,
        host: "pty",
        mcp: ["fixture"],
      }),
    ).rejects.toThrow(/MCP server.*fixture/);
  } finally {
    await m.stop(peer.canonical_id);
    await m.close();
  }
});
test("missing permitted tool fails with a named diagnostic before agent startup", async () => {
  const { f, m } = await setup({
    mcp_servers: { fixture: { ...definition, tools: ["missing_tool"] } },
  });
  try {
    await expect(
      m.run({
        runtime: "codex",
        prompt: "missing tool",
        cwd: f.root,
        host: "pty",
      }),
    ).rejects.toThrow(/fixture.*missing_tool/);
    expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
  } finally {
    await m.close();
  }
});
test("MCP config loading does not rewrite the operator configuration", async () => {
  const { f, m } = await setup();
  const path = join(f.home, "config.toml");
  const original = await readFile(path, "utf8");
  expect((await loadConfig(f.home)).mcp_servers.fixture?.tools).toEqual([
    "ping",
  ]);
  expect(await readFile(path, "utf8")).toBe(original);
  await m.close();
});
test("MCP preflight is bounded and never logs server stderr secrets", async () => {
  const { f, m } = await setup({
    mcp_servers: {
      fixture: {
        command: process.execPath,
        args: [
          "-e",
          'console.error("SECRET_FIXTURE_VALUE");setInterval(()=>{},1000)',
        ],
        tools: ["ping"],
        required: true,
        startup_timeout_sec: 0.2,
      },
    },
  });
  const started = Date.now();
  try {
    await expect(
      m.run({
        runtime: "claude",
        prompt: "timeout",
        cwd: f.root,
        host: "pty",
        level: "read",
      }),
    ).rejects.toThrow(/fixture.*startup/);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(
      await readFile(join(f.home, "launches.jsonl"), "utf8"),
    ).not.toContain("SECRET_FIXTURE_VALUE");
    expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
  } finally {
    await m.close();
  }
});
test("task defaults stay empty but tasks can explicitly select MCP", async () => {
  const { f, m } = await setup();
  try {
    const plain = await m.run({
      runtime: "claude",
      prompt: "task none",
      cwd: f.root,
      kind: "task",
    });
    expect(plain.mcp).toEqual([]);
    const selected = asTask(
      await m.run({
        runtime: "codex",
        prompt: "task selected",
        cwd: f.root,
        kind: "task",
        mcp: ["fixture"],
      }),
    );
    expect(selected.mcp).toEqual(["fixture"]);
    expect((await m.list()).find((p) => p.id === selected.id)?.mcp).toEqual([
      "fixture",
    ]);
  } finally {
    await m.close();
  }
});

test("explicit MCP environment references survive launcher filtering without entering logs", async () => {
  const f = await fixture({ MCP_FIXTURE_AUTH: "fixture-secret" });
  await writeFile(
    join(f.home, "config.toml"),
    TOML.stringify({
      mcp_servers: {
        fixture: { ...definition, env_vars: ["MCP_FIXTURE_AUTH"] },
      },
    }),
  );
  const m = await Muster.create({ home: f.home, env: f.env });
  const peer = asSession(
    await m.run({
      runtime: "claude",
      prompt: "env test",
      cwd: f.root,
      host: "pty",
      mcp: ["fixture"],
    }),
  );
  try {
    expect(peer.mcp).toEqual(["fixture"]);
    expect(
      await readFile(join(f.home, "launches.jsonl"), "utf8"),
    ).not.toContain("fixture-secret");
  } finally {
    await m.stop(peer.canonical_id);
    await m.close();
  }
});

test("HTTP MCP preflight and adapters forward a referenced bearer token", async () => {
  const { createServer } = await import("node:http");
  const { prepareMcp, selectMcp } = await import("../src/mcp.js");
  const { claudeMcpConfig } = await import("../src/claude-policy.js");
  const { codexMcpConfig } = await import("../src/codex-policy.js");
  const auth: (string | undefined)[] = [];
  const http = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    auth.push(req.headers.authorization);
    let body = "";
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "http-fixture", version: "1" },
          }
        : { tools: [{ name: "ping", inputSchema: { type: "object" } }] };
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(http.address() as any).port}/mcp`;
    const config = configSchema.parse({
      mcp_servers: {
        remote: { url, bearer_token_env_var: "FIXTURE_TOKEN", tools: ["ping"] },
      },
    });
    const selected = selectMcp(
      runSchema.parse({ runtime: "claude", prompt: "remote", mcp: ["remote"] }),
      config,
    );
    const env = { ...process.env, FIXTURE_TOKEN: "fixture-token" } as Record<
      string,
      string
    >;
    const result = await prepareMcp(
      selected,
      env,
      process.cwd(),
      Date.now() + 3000,
    );
    expect(result.summary.mcp).toEqual(["remote"]);
    expect(auth.length).toBeGreaterThanOrEqual(2);
    expect(auth.every((value) => value === "Bearer fixture-token")).toBe(true);
    expect(
      claudeMcpConfig(result.servers, "/private/tmp/bridge-test.json"),
    ).toMatchObject({
      mcpServers: {
        remote: { type: "stdio", env: { FIXTURE_TOKEN: "${FIXTURE_TOKEN}" } },
      },
    });
    expect(codexMcpConfig(result.servers[0]!)).toMatchObject({
      url,
      bearer_token_env_var: "FIXTURE_TOKEN",
    });
  } finally {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

test("Codex config verification failures do not leak inline MCP credentials", async () => {
  const f = await fixture({ MUSTER_FAKE_MCP_FAIL_CONFIG: "1" });
  await writeFile(
    join(f.home, "config.toml"),
    TOML.stringify({
      mcp_servers: {
        fixture: {
          ...definition,
          env: { FIXTURE_SECRET: "secret-inline-value" },
        },
      },
    }),
  );
  const m = await Muster.create({ home: f.home, env: f.env });
  try {
    await expect(
      m.run({
        runtime: "codex",
        prompt: "config failure",
        cwd: f.root,
        mcp: ["fixture"],
      }),
    ).rejects.toThrow(/Cannot verify effective Codex MCP configuration/);
    expect(
      await readFile(join(f.home, "launches.jsonl"), "utf8"),
    ).not.toContain("secret-inline-value");
    expect(await readFile(join(f.home, "registry.json"), "utf8")).not.toContain(
      "secret-inline-value",
    );
  } finally {
    await m.close();
  }
});

test("Codex selected definitions never merge with inherited same-name settings", async () => {
  const f = await fixture({ MUSTER_FAKE_MCP: "fixture,muster_fixture_1" });
  await writeFile(
    join(f.home, "config.toml"),
    TOML.stringify({ mcp_servers: { fixture: definition } }),
  );
  const m = await Muster.create({ home: f.home, env: f.env });
  const peer = asSession(
    await m.run({
      runtime: "codex",
      prompt: "isolated definition",
      cwd: f.root,
      host: "pty",
      mcp: ["fixture"],
    }),
  );
  try {
    const args = (await lines(join(f.root, "starts.jsonl")))[0]
      .argv as string[];
    const config = TOML.parse(
      args.filter((_, i) => args[i - 1] === "-c").join("\n"),
    ) as any;
    expect(config.mcp_servers.fixture.enabled).toBe(false);
    expect(config.mcp_servers.muster_fixture_1.enabled).toBe(false);
    expect(config.mcp_servers.muster_fixture_2).toMatchObject({
      enabled: true,
      command: definition.command,
    });
    expect(peer.mcp).toEqual(["fixture"]);
  } finally {
    await m.stop(peer.canonical_id);
    await m.close();
  }
});

test("Claude MCP bridge exposes only selected tools and rejects unlisted calls", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/sdk/client/stdio.js");
  const f = await fixture();
  const spec = join(f.root, "bridge.json");
  await writeFile(spec, JSON.stringify({ fixture: definition }));
  const client = new Client({ name: "bridge-test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), "dist/mcp-bridge.js"), spec, "fixture"],
        stderr: "pipe",
      }),
    );
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "ping",
    ]);
    expect(
      await client.callTool({ name: "ping", arguments: {} }),
    ).toMatchObject({ content: [{ type: "text", text: "pong" }] });
    expect(
      await client.callTool({ name: "erase", arguments: {} }),
    ).toMatchObject({ isError: true });
    expect(
      await client.callTool({ name: "newly_advertised_tool", arguments: {} }),
    ).toMatchObject({ isError: true });
  } finally {
    await client.close();
  }
});

/**
 * The same gate on Muster's own server. Registering it where every Claude
 * session sees it is only safe because the default exposes nothing that can
 * start, stop or change a run — and a client can call a tool it was never
 * shown, so the call side is checked, not just the listing.
 */
test("Muster's own MCP server is read-only by default and rejects launch calls", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/sdk/client/stdio.js");
  const f = await fixture();
  const connect = async (args: string[]) => {
    const client = new Client({ name: "gate-test", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), "dist/muster.js"), ...args],
        env: f.env,
        stderr: "pipe",
      }),
    );
    return client;
  };
  const readOnly = await connect(["mcp"]);
  try {
    expect(
      (await readOnly.listTools()).tools.map((t) => t.name).sort(),
    ).toEqual(["list", "output"]);
    expect(
      await readOnly.callTool({ name: "list", arguments: {} }),
    ).not.toMatchObject({ isError: true });
    const refused = await readOnly.callTool({
      name: "run",
      arguments: { runtime: "claude", prompt: "should not start", cwd: f.root },
    });
    expect(refused).toMatchObject({ isError: true });
    expect((refused.content as any)[0].text).toContain("--allow-launch");
    for (const name of ["stop", "title", "newly_advertised_tool"])
      expect(
        await readOnly.callTool({
          name,
          arguments: { id: "x", title: "x" },
        }),
      ).toMatchObject({ isError: true });
    // Nothing was launched: the fake runtime records every start.
    expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
  } finally {
    await readOnly.close();
  }
  const granted = await connect(["mcp", "--allow-launch"]);
  try {
    expect((await granted.listTools()).tools.map((t) => t.name).sort()).toEqual(
      ["list", "output", "run", "stop", "title"],
    );
  } finally {
    await granted.close();
  }
}, 20000);

test("MCP bridge exits promptly on parent stdin EOF without a kill signal", async () => {
  const { spawn } = await import("node:child_process");
  const f = await fixture();
  const spec = join(f.root, "bridge.json");
  await writeFile(spec, JSON.stringify({ fixture: definition }));
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "dist/mcp-bridge.js"), spec, "fixture"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stderr.resume();
  const exited = once(child, "exit");
  try {
    const response = once(child.stdout, "data");
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "eof-test", version: "1" },
        },
      }) + "\n",
    );
    await response;
    child.stdin.end();
    let timer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("leaked"), 750);
      }),
    ]).finally(() => clearTimeout(timer));
    expect(result).not.toBe("leaked");
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
});

test("OpenCode MCP adapters preserve references but never inline environment secrets", async () => {
  const { openCodeMcpConfig } = await import("../src/opencode-policy.js");
  const local = openCodeMcpConfig({
    name: "fixture",
    required: true,
    excludedTools: [],
    config: (await import("../src/mcp.js")).mcpServerSchema.parse({
      command: "fixture-mcp",
      args: ["serve"],
      env: { FIXED_TOKEN: "fixed-secret" },
      env_vars: ["REFERENCED_TOKEN"],
      tools: ["ping"],
      startup_timeout_sec: 3,
    }),
  });
  expect(local).toMatchObject({
    type: "local",
    command: ["fixture-mcp", "serve"],
    environment: {
      FIXED_TOKEN:
        "{env:MUSTER_OPENCODE_MCP_66697874757265_46495845445F544F4B454E}",
      REFERENCED_TOKEN: "{env:REFERENCED_TOKEN}",
    },
    timeout: 3000,
    enabled: true,
  });
  expect(JSON.stringify(local)).not.toContain("fixed-secret");

  const remote = openCodeMcpConfig({
    name: "remote",
    required: true,
    excludedTools: [],
    config: (await import("../src/mcp.js")).mcpServerSchema.parse({
      url: "https://example.test/mcp",
      bearer_token_env_var: "REMOTE_TOKEN",
      tools: ["ping"],
    }),
  });
  expect(remote).toMatchObject({
    type: "remote",
    url: "https://example.test/mcp",
    headers: { Authorization: "Bearer {env:REMOTE_TOKEN}" },
    enabled: true,
  });
});

test("MCP bridge closes upstream after initialization rejection", async () => {
  const { spawn } = await import("node:child_process");
  const f = await fixture();
  const spec = join(f.root, "rejected.json");
  const reject = `process.stdin.on('data', data => {const m=JSON.parse(data.toString().trim()); if(m.id!==undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32600,message:'rejected'}})+'\\n');});process.stdin.on('end',()=>process.exit(0));setInterval(()=>{},1000);`;
  await writeFile(
    spec,
    JSON.stringify({ fixture: { ...definition, args: ["-e", reject] } }),
  );
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "dist/mcp-bridge.js"), spec, "fixture"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdout.resume();
  child.stderr.resume();
  const exited = once(child, "exit");
  try {
    let timer: ReturnType<typeof setTimeout>;
    const result = await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("leaked"), 1000);
      }),
    ]).finally(() => clearTimeout(timer));
    expect(result).toEqual([1, null]);
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
});

for (const runtime of ["claude", "codex"] as const)
  test(`${runtime} inherit-profile adds explicit MCP without shadowing a profile name`, async () => {
    const { f, m } = await setup({ allow_dangerous_flags: true });
    // The fake Codex enumerator declares this name as already present.
    const req = {
      runtime,
      prompt: "profile plus explicit MCP",
      cwd: f.root,
      host: "pty",
      level: "open",
      options: ["inherit-profile"],
      mcp: ["fixture"],
    };
    f.env.MUSTER_FAKE_MCP = "fixture";
    const profile = await Muster.create({ home: f.home, env: f.env });
    try {
      const peer = asSession(await profile.run(req));
      const argv = (await lines(join(f.root, "starts.jsonl")))[0]
        .argv as string[];
      if (runtime === "claude") {
        const servers = JSON.parse(
          argv[argv.indexOf("--mcp-config") + 1]!,
        ).mcpServers;
        expect(servers).not.toHaveProperty("fixture");
        const names = Object.keys(servers);
        expect(names).toHaveLength(1);
        expect(names[0]).toMatch(/^muster_[a-f0-9-]+_fixture$/);
        expect(servers[names[0]!].args.at(-1)).toBe("fixture");
        expect(argv).not.toContain("--strict-mcp-config");
      } else {
        expect(argv.join(" ")).toContain("mcp_servers.muster_fixture_1=");
        expect(argv.join(" ")).not.toContain(
          "mcp_servers.fixture.enabled=false",
        );
      }
      await profile.stop(peer.canonical_id);
    } finally {
      await profile.close();
      await m.close();
    }
  });
