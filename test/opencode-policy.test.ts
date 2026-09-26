import { test, expect } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { configSchema } from "../src/config.js";
import { runSchema, runtimeArgs } from "../src/guard.js";
import { mcpServerSchema, type PreparedMcp } from "../src/mcp.js";
import { pluginSchema, selectPlugins } from "../src/plugins.js";
import {
  assertOpenCodeVersion,
  openCodeConfig,
  openCodeMcpNames,
  openCodeSessionLaunch,
  openCodeTaskLaunch,
} from "../src/opencode-policy.js";
import { ampleDeadline } from "./deadline.js";

async function fakeOpenCode(extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "muster-opencode-policy-"));
  const bin = join(root, "bin");
  const calls = join(root, "calls.jsonl");
  await mkdir(bin);
  await writeFile(
    join(bin, "opencode"),
    `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
if (argv.includes("--version")) {
  if (process.env.FAKE_VERSION_FAIL === "1") {
    console.error("SECRET_VERSION_DIAGNOSTIC");
    process.exit(1);
  }
  console.log(process.env.FAKE_VERSION || "1.18.31");
  process.exit(0);
}
if (argv.join(" ") === "--pure debug config") {
  if (process.env.FAKE_DEBUG_FAIL === "1") {
    console.log("SECRET_STDOUT_DIAGNOSTIC");
    console.error("SECRET_STDERR_DIAGNOSTIC");
    process.exit(1);
  }
  if (process.env.FAKE_DEBUG_MALFORMED === "1") {
    console.log("SECRET_MALFORMED_OUTPUT");
    process.exit(0);
  }
  const inline = process.env.OPENCODE_CONFIG_CONTENT;
  if (!inline) {
    console.log(JSON.stringify({ mcp: { unselected: { enabled: true }, inherited_two: { enabled: true } } }));
    process.exit(0);
  }
  const substitute = value => {
    if (typeof value === "string") return value.replace(/\\{env:([A-Za-z_][A-Za-z0-9_]*)\\}/g, (_, name) => process.env[name] || "");
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item)]));
    return value;
  };
  const value = substitute(JSON.parse(inline));
  if (process.env.FAKE_MANAGED_OVERRIDE === "1") value.mcp.unselected = { enabled: true };
  if (process.env.FAKE_MANAGED_PERMISSION === "1") value.permission["unselected_*"] = "allow";
  console.log(JSON.stringify(value));
  process.exit(0);
}
process.exit(2);
`,
  );
  await chmod(join(bin, "opencode"), 0o755);
  return {
    root,
    calls,
    env: {
      PATH: bin,
      FAKE_CALLS: calls,
      ...extra,
    },
  };
}

function prepared(
  name: string,
  input: Parameters<typeof mcpServerSchema.parse>[0],
  excludedTools: string[] = [],
): PreparedMcp {
  return {
    name,
    required: true,
    excludedTools,
    config: mcpServerSchema.parse(input),
  };
}

test("OpenCode session launch owns server flags and uses the literal prompt", async () => {
  const fake = await fakeOpenCode();
  const config = configSchema.parse({});
  const req = runSchema.parse({
    runtime: "opencode",
    prompt: "$(touch nope)",
    args: ["--model", "local-provider/qwen3-30b"],
  });
  const launch = await openCodeSessionLaunch(
    req,
    config,
    [],
    ["unselected"],
    43127,
    fake.env,
    fake.root,
    ampleDeadline(),
  );
  expect(launch.argv).toEqual([
    "opencode",
    "--pure",
    "--hostname",
    "127.0.0.1",
    "--port",
    "43127",
    "--model",
    "local-provider/qwen3-30b",
    "--prompt",
    "$(touch nope)",
  ]);
  expect(launch).toMatchObject({
    port: 43127,
    serverUrl: "http://127.0.0.1:43127",
  });
  expect(JSON.parse(launch.envPatch.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
    share: "disabled",
    server: { hostname: "127.0.0.1", port: 43127 },
  });
});

test("OpenCode task launch is pure, streams JSON, and adds auto only for auto permissions", async () => {
  const fake = await fakeOpenCode();
  const config = configSchema.parse({});
  const deny = await openCodeTaskLaunch(
    runSchema.parse({
      runtime: "opencode",
      kind: "task",
      prompt: "review",
      args: ["--agent=review", "--variant", "high"],
    }),
    config,
    [],
    ["unselected"],
    fake.env,
    fake.root,
    ampleDeadline(),
  );
  expect(deny.argv).toEqual([
    "opencode",
    "run",
    "--format",
    "json",
    "--pure",
    "--agent=review",
    "--variant",
    "high",
    "--",
    "review",
  ]);
  const auto = await openCodeTaskLaunch(
    runSchema.parse({
      runtime: "opencode",
      kind: "task",
      prompt: "build",
      permissions: "auto",
      sandbox: "workspace-write",
    }),
    config,
    [],
    [],
    fake.env,
    fake.root,
    ampleDeadline(),
  );
  expect(auto.argv).toContain("--auto");
});

test.each(["--help", "--auto", "--session", "--attach"])(
  "OpenCode task treats leading-hyphen prompt %s as a literal message",
  async (prompt) => {
    const fake = await fakeOpenCode();
    const launch = await openCodeTaskLaunch(
      runSchema.parse({ runtime: "opencode", kind: "task", prompt }),
      configSchema.parse({}),
      [],
      [],
      fake.env,
      fake.root,
      ampleDeadline(),
    );
    expect(launch.argv.slice(-2)).toEqual(["--", prompt]);
  },
);

test("read-only overlay denies write-capable and network OpenCode actions", () => {
  const config = configSchema.parse({});
  const req = runSchema.parse({ runtime: "opencode", prompt: "review" });
  expect(openCodeConfig(req, config, [], [])).toMatchObject({
    permission: {
      edit: "deny",
      bash: "deny",
      task: "deny",
      external_directory: "deny",
      webfetch: "deny",
      websearch: "deny",
      question: "allow",
    },
  });
});

test("bypass requires the dangerous full-access combination and maps to allow", () => {
  const req = runSchema.parse({
    runtime: "opencode",
    prompt: "build",
    permissions: "bypass",
    sandbox: "full-access",
  });
  expect(() => openCodeConfig(req, configSchema.parse({}), [], [])).toThrow(
    /allow_dangerous_flags/,
  );
  expect(
    openCodeConfig(
      req,
      configSchema.parse({ allow_dangerous_flags: true }),
      [],
      [],
    ),
  ).toMatchObject({ permission: { "*": "allow" } });
  expect(() =>
    openCodeConfig(
      runSchema.parse({
        runtime: "opencode",
        prompt: "build",
        permissions: "auto",
      }),
      configSchema.parse({}),
      [],
      [],
    ),
  ).toThrow(/workspace-write/);
});

test("inherited MCPs are disabled and selected MCPs are enabled", () => {
  const config = configSchema.parse({});
  const req = runSchema.parse({ runtime: "opencode", prompt: "review" });
  const fixture = prepared("fixture", {
    command: "fixture-mcp",
    tools: ["echo"],
  });
  const overlay = openCodeConfig(req, config, [fixture], ["unselected"]) as {
    mcp: Record<string, Record<string, unknown>>;
    tools: Record<string, boolean>;
  };
  expect(overlay.mcp.unselected).toMatchObject({ enabled: false });
  expect(overlay.tools).toMatchObject({
    "unselected_*": false,
    "fixture_*": true,
  });
  expect(overlay.mcp.fixture).toMatchObject({
    type: "local",
    command: ["fixture-mcp"],
    enabled: true,
  });
});

test("selected MCP definitions avoid inherited same-name config and exclude unselected tools", () => {
  const overlay = openCodeConfig(
    runSchema.parse({ runtime: "opencode", prompt: "review" }),
    configSchema.parse({}),
    [
      prepared("fixture", { command: "fixture-mcp", tools: ["echo"] }, [
        "erase",
      ]),
    ],
    ["fixture", "muster_fixture_1"],
  ) as {
    mcp: Record<string, Record<string, unknown>>;
    tools: Record<string, boolean>;
  };
  expect(overlay.mcp.fixture).toEqual({ enabled: false });
  expect(overlay.mcp.muster_fixture_1).toEqual({ enabled: false });
  expect(overlay.mcp.muster_fixture_2).toMatchObject({
    command: ["fixture-mcp"],
    enabled: true,
  });
  expect(overlay.tools).toMatchObject({
    "fixture_*": false,
    "muster_fixture_1_*": false,
    "muster_fixture_2_*": true,
    muster_fixture_2_erase: false,
  });
});

test("OpenCode config content uses environment references instead of secret values", async () => {
  const fake = await fakeOpenCode({
    REFERENCED_SECRET: "referenced-secret-value",
    BEARER_SECRET: "bearer-secret-value",
  });
  const servers = [
    prepared("local", {
      command: "local-mcp",
      env: { INLINE_SECRET: "inline-secret-value" },
      env_vars: ["REFERENCED_SECRET"],
      tools: ["ping"],
    }),
    prepared("remote", {
      url: "https://example.test/mcp",
      bearer_token_env_var: "BEARER_SECRET",
      tools: ["ping"],
    }),
  ];
  const launch = await openCodeSessionLaunch(
    runSchema.parse({ runtime: "opencode", prompt: "review" }),
    configSchema.parse({}),
    servers,
    [],
    43127,
    fake.env,
    fake.root,
    ampleDeadline(),
  );
  const serialized = launch.envPatch.OPENCODE_CONFIG_CONTENT!;
  expect(serialized).not.toContain("inline-secret-value");
  expect(serialized).not.toContain("referenced-secret-value");
  expect(serialized).not.toContain("bearer-secret-value");
  expect(serialized).toContain("{env:");
  expect(launch.envPatch).toMatchObject({
    MUSTER_OPENCODE_MCP_6C6F63616C_494E4C494E455F534543524554:
      "inline-secret-value",
  });
});

test("fixed MCP environment references remain distinct across punctuation and case", async () => {
  const fake = await fakeOpenCode();
  const launch = await openCodeSessionLaunch(
    runSchema.parse({ runtime: "opencode", prompt: "review" }),
    configSchema.parse({}),
    [
      prepared("foo-bar", {
        command: "first-mcp",
        env: { TOKEN: "hyphen-secret", token: "lowercase-secret" },
        tools: ["ping"],
      }),
      prepared("foo_bar", {
        command: "second-mcp",
        env: { TOKEN: "underscore-secret" },
        tools: ["ping"],
      }),
    ],
    [],
    43127,
    fake.env,
    fake.root,
    ampleDeadline(),
  );
  const overlay = JSON.parse(launch.envPatch.OPENCODE_CONFIG_CONTENT!) as {
    mcp: Record<string, { environment: Record<string, string> }>;
  };
  const references = [
    ...Object.values(overlay.mcp["foo-bar"]!.environment),
    ...Object.values(overlay.mcp.foo_bar!.environment),
  ];
  expect(new Set(references).size).toBe(3);
  expect(Object.values(launch.envPatch)).toEqual(
    expect.arrayContaining([
      "hyphen-secret",
      "lowercase-secret",
      "underscore-secret",
    ]),
  );
});

test("launch config composes existing inline providers while replacing owned policy", async () => {
  const inherited = {
    provider: {
      localProvider: {
        npm: "@ai-sdk/openai-compatible",
        name: "Coldfire",
        options: { baseURL: "http://127.0.0.1:11436/v1" },
        models: { qwen: { name: "Qwen" } },
      },
    },
    model: "local-provider/qwen",
    permission: { bash: "allow" },
    mcp: {
      inline_server: {
        type: "local",
        command: ["inline-mcp"],
        enabled: true,
      },
    },
  };
  const fake = await fakeOpenCode({
    OPENCODE_CONFIG_CONTENT: JSON.stringify(inherited),
  });
  const launch = await openCodeSessionLaunch(
    runSchema.parse({ runtime: "opencode", prompt: "review" }),
    configSchema.parse({}),
    [],
    ["inline_server"],
    43127,
    fake.env,
    fake.root,
    ampleDeadline(),
  );
  const composed = JSON.parse(launch.envPatch.OPENCODE_CONFIG_CONTENT!);
  expect(composed.provider).toEqual(inherited.provider);
  expect(composed.model).toBe("local-provider/qwen");
  expect(composed.mcp.inline_server).toEqual({
    type: "local",
    command: ["inline-mcp"],
    enabled: false,
  });
  expect(composed.permission.bash).toBe("deny");
});

test("launch config fails closed on malformed existing inline config", async () => {
  const fake = await fakeOpenCode({
    OPENCODE_CONFIG_CONTENT: "SECRET_MALFORMED_INLINE",
  });
  const error = await openCodeSessionLaunch(
    runSchema.parse({ runtime: "opencode", prompt: "review" }),
    configSchema.parse({}),
    [],
    [],
    43127,
    fake.env,
    fake.root,
    ampleDeadline(),
  ).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(/inline OpenCode config/i);
  expect((error as Error).message).not.toContain("SECRET_MALFORMED_INLINE");
});

test("OpenCode MCP inspection uses pure resolved config and returns only MCP keys", async () => {
  const fake = await fakeOpenCode();
  await expect(
    openCodeMcpNames(fake.env, fake.root, ampleDeadline()),
  ).resolves.toEqual(["unselected", "inherited_two"]);
  expect(JSON.parse((await readFile(fake.calls, "utf8")).trim())).toEqual({
    argv: ["--pure", "debug", "config"],
    cwd: await realpath(fake.root),
  });
});

test.each([
  [{ FAKE_DEBUG_FAIL: "1" }, "SECRET_STDERR_DIAGNOSTIC"],
  [{ FAKE_DEBUG_MALFORMED: "1" }, "SECRET_MALFORMED_OUTPUT"],
] as const)(
  "OpenCode MCP inspection fails closed without exposing command output",
  async (extra, secret) => {
    const fake = await fakeOpenCode(extra);
    const error = await openCodeMcpNames(
      fake.env,
      fake.root,
      ampleDeadline(),
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/verify effective OpenCode MCP/i);
    expect((error as Error).message).not.toContain(secret);
  },
);

test("effective config verification rejects a managed override", async () => {
  const fake = await fakeOpenCode({ FAKE_MANAGED_OVERRIDE: "1" });
  await expect(
    openCodeSessionLaunch(
      runSchema.parse({ runtime: "opencode", prompt: "review" }),
      configSchema.parse({}),
      [],
      ["unselected"],
      43127,
      fake.env,
      fake.root,
      ampleDeadline(),
    ),
  ).rejects.toThrow(/MCP isolation.*refusing launch/i);
});

test("effective config verification rejects managed permission re-enablement", async () => {
  const fake = await fakeOpenCode({ FAKE_MANAGED_PERMISSION: "1" });
  await expect(
    openCodeSessionLaunch(
      runSchema.parse({ runtime: "opencode", prompt: "review" }),
      configSchema.parse({}),
      [],
      ["unselected"],
      43127,
      fake.env,
      fake.root,
      ampleDeadline(),
    ),
  ).rejects.toThrow(/MCP isolation.*refusing launch/i);
});

test.each([
  ["--auto"],
  ["--pure"],
  ["--hostname", "0.0.0.0"],
  ["--port", "8080"],
  ["--attach", "http://example.test"],
  ["--session", "ses_other"],
  ["--config", "other.json"],
  ["--settings", "{}"],
  ["-ma"],
] as string[][])(
  "refuses owned OpenCode runtime option %s",
  async (...args) => {
    const fake = await fakeOpenCode();
    await expect(
      openCodeSessionLaunch(
        runSchema.parse({ runtime: "opencode", prompt: "review", args }),
        configSchema.parse({}),
        [],
        [],
        43127,
        fake.env,
        fake.root,
        ampleDeadline(),
      ),
    ).rejects.toThrow(/Runtime option refused/);
  },
);

test("OpenCode version check rejects absence and old versions, then accepts the floor and newer semver", async () => {
  const empty = await mkdtemp(join(tmpdir(), "muster-opencode-missing-"));
  await expect(
    assertOpenCodeVersion({ PATH: empty }, "1.18.31", ampleDeadline()),
  ).rejects.toThrow(/OpenCode executable.*1\.18\.31/);

  const old = await fakeOpenCode({ FAKE_VERSION: "1.18.30" });
  await expect(
    assertOpenCodeVersion(old.env, "1.18.31", ampleDeadline()),
  ).rejects.toThrow(/1\.18\.30.*1\.18\.31/);

  for (const version of ["1.18.31", "1.19.0", "2.0.0"]) {
    const fake = await fakeOpenCode({ FAKE_VERSION: version });
    await expect(
      assertOpenCodeVersion(fake.env, "1.18.31", ampleDeadline()),
    ).resolves.toBeUndefined();
  }
});

test("OpenCode version errors redact executable output", async () => {
  const fake = await fakeOpenCode({ FAKE_VERSION_FAIL: "1" });
  const error = await assertOpenCodeVersion(
    fake.env,
    "1.18.31",
    ampleDeadline(),
  ).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain("SECRET_VERSION_DIAGNOSTIC");
});

test("selected plugins replace --pure and are pinned in the overlay", async () => {
  const fake = await fakeOpenCode();
  const config = configSchema.parse({
    plugins: { tincan: { path: "/opt/plugins/tincan.ts" } },
  });
  const req = runSchema.parse({
    runtime: "opencode",
    prompt: "ping",
    plugin: ["tincan"],
  });
  const launch = await openCodeSessionLaunch(
    req,
    config,
    [],
    ["unselected"],
    43127,
    fake.env,
    fake.root,
    ampleDeadline(),
    selectPlugins(req, config),
  );
  // --pure would suppress the very plugin the operator selected.
  expect(launch.argv).not.toContain("--pure");
  expect(JSON.parse(launch.envPatch.OPENCODE_CONFIG_CONTENT!).plugin).toEqual([
    "file:///opt/plugins/tincan.ts",
  ]);
});

test("selecting no plugins keeps --pure and pins an empty plugin list", async () => {
  const fake = await fakeOpenCode();
  const config = configSchema.parse({});
  const req = runSchema.parse({ runtime: "opencode", prompt: "ping" });
  const launch = await openCodeSessionLaunch(
    req,
    config,
    [],
    ["unselected"],
    43127,
    fake.env,
    fake.root,
    ampleDeadline(),
    selectPlugins(req, config),
  );
  expect(launch.argv).toContain("--pure");
  // Belt and braces: an explicit empty array also suppresses OpenCode's own
  // user- and project-level plugin discovery.
  expect(JSON.parse(launch.envPatch.OPENCODE_CONFIG_CONTENT!).plugin).toEqual(
    [],
  );
});

test("OpenCode tasks drop --pure only when plugins are selected", async () => {
  const fake = await fakeOpenCode();
  const config = configSchema.parse({
    plugins: { tincan: { path: "/opt/plugins/tincan.ts" } },
  });
  const req = runSchema.parse({
    runtime: "opencode",
    kind: "task",
    prompt: "review",
    plugin: ["tincan"],
  });
  const launch = await openCodeTaskLaunch(
    req,
    config,
    [],
    ["unselected"],
    fake.env,
    fake.root,
    ampleDeadline(),
    selectPlugins(req, config),
  );
  expect(launch.argv).not.toContain("--pure");
});

test("plugin paths expand ~ and unknown names are refused", () => {
  const config = configSchema.parse({
    default_plugins: ["tincan"],
    plugins: { tincan: { path: "~/.config/opencode/plugin/tincan.ts" } },
  });
  const selected = selectPlugins(
    runSchema.parse({ runtime: "opencode", prompt: "ping" }),
    config,
  );
  expect(selected).toEqual([
    {
      name: "tincan",
      url: pathToFileURL(join(homedir(), ".config/opencode/plugin/tincan.ts"))
        .href,
    },
  ]);
  expect(() =>
    selectPlugins(
      runSchema.parse({
        runtime: "opencode",
        prompt: "ping",
        plugin: ["nope"],
      }),
      config,
    ),
  ).toThrow("Unknown plugin: nope");
});

test("tasks take no plugin defaults; sessions do", () => {
  const config = configSchema.parse({
    default_plugins: ["tincan"],
    plugins: { tincan: { path: "/opt/plugins/tincan.ts" } },
  });
  const task = runSchema.parse({
    runtime: "opencode",
    kind: "task",
    prompt: "review",
  });
  expect(selectPlugins(task, config)).toEqual([]);
  const session = runSchema.parse({ runtime: "opencode", prompt: "ping" });
  expect(selectPlugins(session, config)).toHaveLength(1);
});

const LOCAL_PROVIDER = {
  opencode: {
    model: "muster-local/qwen3-30b-a3b",
    provider: {
      "muster-local": {
        npm: "@ai-sdk/openai-compatible",
        name: "Muster local",
        base_url: "http://127.0.0.1:4096/v1",
        api_key: "local",
        models: { "qwen3-30b-a3b": { tool_call: true } },
      },
    },
  },
};

test("configured provider and model ride in the overlay, not the user's config", async () => {
  const fake = await fakeOpenCode();
  const config = configSchema.parse(LOCAL_PROVIDER);
  const req = runSchema.parse({ runtime: "opencode", prompt: "ping" });
  const launch = await openCodeSessionLaunch(
    req,
    config,
    [],
    ["unselected"],
    43127,
    fake.env,
    fake.root,
    ampleDeadline(),
    [],
    {},
  );
  const overlay = JSON.parse(launch.envPatch.OPENCODE_CONFIG_CONTENT!);
  expect(overlay.model).toBe("muster-local/qwen3-30b-a3b");
  expect(overlay.provider["muster-local"]).toEqual({
    npm: "@ai-sdk/openai-compatible",
    name: "Muster local",
    options: { baseURL: "http://127.0.0.1:4096/v1", apiKey: "local" },
    models: { "qwen3-30b-a3b": { tool_call: true } },
  });
});

test("--model overrides the configured default", () => {
  const config = configSchema.parse(LOCAL_PROVIDER);
  const overlay = openCodeConfig(
    runSchema.parse({
      runtime: "opencode",
      prompt: "ping",
      model: "muster-local/qwen2.5-14b",
    }),
    config,
    [],
    [],
    [],
    {},
  );
  expect(overlay.model).toBe("muster-local/qwen2.5-14b");
});

test("no provider configured leaves model and provider out of the overlay", () => {
  const overlay = openCodeConfig(
    runSchema.parse({ runtime: "opencode", prompt: "ping" }),
    configSchema.parse({}),
    [],
    [],
    [],
    {},
  );
  expect(overlay).not.toHaveProperty("provider");
  expect(overlay).not.toHaveProperty("model");
});

test("api_key_env_var reads the source environment and fails loudly when unset", () => {
  const config = configSchema.parse({
    opencode: {
      provider: {
        remote: {
          base_url: "https://api.example.com/v1",
          api_key_env_var: "MUSTER_TEST_KEY",
        },
      },
    },
  });
  const req = runSchema.parse({ runtime: "opencode", prompt: "ping" });
  const overlay = openCodeConfig(req, config, [], [], [], {
    MUSTER_TEST_KEY: "s3cret",
  });
  expect(
    (overlay.provider as Record<string, { options: { apiKey: string } }>)
      .remote!.options.apiKey,
  ).toBe("s3cret");
  expect(() => openCodeConfig(req, config, [], [], [], {})).toThrow(
    "Provider remote needs MUSTER_TEST_KEY in the environment",
  );
});

test("api_key and api_key_env_var cannot be combined", () => {
  expect(() =>
    configSchema.parse({
      opencode: {
        provider: { remote: { api_key: "x", api_key_env_var: "Y" } },
      },
    }),
  ).toThrow();
});

test("a models array is shorthand for ids with no options", () => {
  const config = configSchema.parse({
    opencode: { provider: { local: { models: ["a", "b"] } } },
  });
  const overlay = openCodeConfig(
    runSchema.parse({ runtime: "opencode", prompt: "ping" }),
    config,
    [],
    [],
    [],
    {},
  );
  expect(
    (overlay.provider as Record<string, { models: unknown }>).local!.models,
  ).toEqual({ a: {}, b: {} });
});

const TINCAN_SERVER: PreparedMcp = {
  name: "tincan",
  config: mcpServerSchema.parse({ command: "tincan", tools: ["peers"] }),
  required: true,
  excludedTools: [],
};

test("selecting an MCP server drops the wildcard permission entry", () => {
  // A "*" entry suppresses MCP tools outright in OpenCode — even alongside an
  // explicit allow for the tool itself — so the built-ins are named instead.
  const overlay = openCodeConfig(
    runSchema.parse({ runtime: "opencode", prompt: "ping" }),
    configSchema.parse({}),
    [TINCAN_SERVER],
    [],
    [],
    {},
  );
  const permission = overlay.permission as Record<string, string>;
  expect(permission).not.toHaveProperty("*");
  expect(permission.tincan_).toBeUndefined();
  expect(permission["tincan_*"]).toBe("allow");
  // The sandbox must survive losing the wildcard.
  for (const denied of ["bash", "edit", "write", "task", "websearch", "skill"])
    expect(permission[denied]).toBe("deny");
  for (const allowed of ["read", "glob", "grep"])
    expect(permission[allowed]).toBe("allow");
});

test("without an MCP selection the wildcard still backstops", () => {
  const permission = openCodeConfig(
    runSchema.parse({ runtime: "opencode", prompt: "ping" }),
    configSchema.parse({}),
    [],
    ["unselected"],
    [],
    {},
  ).permission as Record<string, string>;
  expect(permission["*"]).toBe("deny");
});

test("bypass keeps the wildcard even when MCP servers are selected", () => {
  const permission = openCodeConfig(
    runSchema.parse({
      runtime: "opencode",
      prompt: "ping",
      permissions: "bypass",
      sandbox: "full-access",
    }),
    configSchema.parse({ allow_dangerous_flags: true, permissions: "bypass" }),
    [TINCAN_SERVER],
    [],
    [],
    {},
  ).permission as Record<string, string>;
  expect(permission["*"]).toBe("allow");
});

test("a plugin named by npm specifier is passed through verbatim", () => {
  const config = configSchema.parse({
    plugins: { tincan: { npm: "@brutalsystems/tincan-opencode" } },
  });
  const selected = selectPlugins(
    runSchema.parse({
      runtime: "opencode",
      prompt: "ping",
      plugin: ["tincan"],
    }),
    config,
  );
  // Not file-URL'd: OpenCode resolves and installs the specifier itself.
  expect(selected).toEqual([
    { name: "tincan", url: "@brutalsystems/tincan-opencode" },
  ]);
  const overlay = openCodeConfig(
    runSchema.parse({ runtime: "opencode", prompt: "ping" }),
    config,
    [],
    [],
    selected,
    {},
  );
  expect(overlay.plugin).toEqual(["@brutalsystems/tincan-opencode"]);
});

test("a pinned npm specifier keeps its version through to the overlay", () => {
  // README tells operators to pin a version so staleness is deliberate rather
  // than implicit in OpenCode's package cache, which keys an unpinned
  // specifier to @latest and never revisits it. Splitting the version off a
  // scoped name here would silently hand OpenCode the floating range instead.
  const config = configSchema.parse({
    plugins: { tincan: { npm: "@brutalsystems/tincan-opencode@0.7.1" } },
  });
  const selected = selectPlugins(
    runSchema.parse({
      runtime: "opencode",
      prompt: "ping",
      plugin: ["tincan"],
    }),
    config,
  );
  expect(selected).toEqual([
    { name: "tincan", url: "@brutalsystems/tincan-opencode@0.7.1" },
  ]);
  const overlay = openCodeConfig(
    runSchema.parse({ runtime: "opencode", prompt: "ping" }),
    config,
    [],
    [],
    selected,
    {},
  );
  expect(overlay.plugin).toEqual(["@brutalsystems/tincan-opencode@0.7.1"]);
});

test("a plugin with neither path nor npm says which keys it needs", () => {
  // The union rejects it before any refinement runs, so the message has to
  // come from the union itself or the operator just gets "Invalid input".
  const result = pluginSchema.safeParse({});
  expect(result.success).toBe(false);
  if (result.success) return;
  const message = result.error.issues.map((i) => i.message).join(" ");
  expect(message).toMatch(/path/);
  expect(message).toMatch(/npm/);
});

test("path and npm are mutually exclusive, and one is required", () => {
  expect(() =>
    configSchema.parse({
      plugins: { x: { path: "/a/b.ts", npm: "@scope/pkg" } },
    }),
  ).toThrow();
  expect(() => configSchema.parse({ plugins: { x: {} } })).toThrow();
  // Each form on its own is fine.
  expect(() =>
    configSchema.parse({ plugins: { x: { path: "/a/b.ts" } } }),
  ).not.toThrow();
  expect(() =>
    configSchema.parse({ plugins: { x: { npm: "@scope/pkg" } } }),
  ).not.toThrow();
});

test("a request model beats the configured default and both are legal forms", () => {
  const config = configSchema.parse({
    opencode: { model: "local/configured" },
  });
  const overlay = openCodeConfig(
    runSchema.parse({
      runtime: "opencode",
      prompt: "ping",
      model: "local/requested",
    }),
    config,
    [],
    [],
    [],
    {},
  );
  expect(overlay.model).toBe("local/requested");
});

test("a model named in args rides the argv only, and does not enter the overlay", () => {
  // The spec: for opencode an args-named model "keeps riding the argv" while the
  // overlay keeps carrying the configured default. The resolver reads it for the
  // record; it must not redirect it into the verified config.
  const config = configSchema.parse({ opencode: { model: "cfg/model" } });
  const req = runSchema.parse({
    runtime: "opencode",
    prompt: "ping",
    args: ["--model", "argv/model"],
  });
  expect(openCodeConfig(req, config, [], [], [], {}).model).toBe("cfg/model");
  expect(runtimeArgs(req)).toEqual(["--model", "argv/model"]);
});
