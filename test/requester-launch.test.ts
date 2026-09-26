import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { configSchema } from "../src/config.js";
import { launchArgs, runSchema } from "../src/guard.js";
import { openCodeConfig } from "../src/opencode-policy.js";
import { Muster } from "../src/run.js";
import { PtyHost } from "../src/hosts/pty.js";
import { delay } from "../src/identity/processes.js";
import {
  RequesterNotEnrolled,
  RequesterPolicyRefusal,
} from "../src/requester-policy.js";
import type { RequesterId } from "../src/requester.js";
import { fixture, lines } from "./helpers.js";
import { asSession, asTask } from "./narrow.js";

const remote: RequesterId = {
  kind: "remote",
  authority: "example.peer.v1",
  subject: "abc",
};
const otherRemote: RequesterId = { ...remote, subject: "other" };
/** Two remote requesters, both enrolled in the same profile. */
const twoRequesters = () => `
launch_timeout_sec = 3

[requester_profiles.research]
allowed_roots = ["/"]
env_allow = ["CODEX_HOME", "MUSTER_FAKE_ROOT", "MUSTER_FAKE_PYTHON", "MUSTER_TEST_HOME"]

[requester_profiles.research.env_defaults]
LANG = "en_US.UTF-8"

[[requesters]]
authority = "example.peer.v1"
subject = "abc"
profile = "research"

[[requesters]]
authority = "example.peer.v1"
subject = "other"
profile = "research"
`;
async function muster(toml: string) {
  const f = await fixture();
  await writeFile(join(f.home, "config.toml"), toml);
  return {
    f,
    m: await Muster.create({
      home: f.home,
      env: f.env,
      // One driver, so "auto" is pty and close() cleans up what it owns.
      drivers: [new PtyHost()],
    }),
  };
}
/**
 * `env_allow` is the fixture's own need, not policy colour: a composed
 * environment carries nothing it was not given, and the fake runtimes refuse to
 * start without their isolation variables. `LANG` comes from the profile so the
 * test does not depend on the shell that happened to run it.
 */
const enrolled = (profileExtra = "", globals = "") => `
launch_timeout_sec = 3
${globals}

[requester_profiles.research]
allowed_roots = ["/"]
env_allow = ["CODEX_HOME", "MUSTER_FAKE_ROOT", "MUSTER_FAKE_PYTHON", "MUSTER_TEST_HOME"]
${profileExtra}

[requester_profiles.research.env_defaults]
LANG = "en_US.UTF-8"

[[requesters]]
authority = "example.peer.v1"
subject = "abc"
profile = "research"
`;

test("an unenrolled remote requester is refused and reserves nothing", async () => {
  const { f, m } = await muster("launch_timeout_sec = 3\n");
  try {
    await expect(
      m.run(
        { runtime: "codex", prompt: "hello", cwd: f.root },
        { ...remote, subject: "stranger" },
      ),
    ).rejects.toThrow(RequesterNotEnrolled);
    expect(await m.registry.all()).toHaveLength(0);
  } finally {
    await m.close();
  }
});

test("a remote request may not name permissions or sandbox", async () => {
  const { f, m } = await muster(enrolled());
  try {
    await expect(
      m.run(
        {
          runtime: "codex",
          prompt: "hello",
          cwd: f.root,
          permissions: "deny",
        },
        remote,
      ),
    ).rejects.toThrow(RequesterPolicyRefusal);
    expect(await m.registry.all()).toHaveLength(0);
  } finally {
    await m.close();
  }
});

test("a remote request may not select MCP servers or plugins", async () => {
  // `env_allow` is only a complete allowlist if the request cannot choose what
  // else contributes to the environment: `mcpEnvironment` copies a selected
  // server's declared credentials out of the unfiltered source environment,
  // whatever `env_allow` says. Configuration is the grant, so the receiver's
  // own defaults are what a remote launch gets.
  const { f, m } = await muster(enrolled());
  try {
    for (const selection of [{ mcp: ["tincan"] }, { plugin: ["tincan"] }]) {
      const error = await m
        .run(
          { runtime: "codex", prompt: "hello", cwd: f.root, ...selection },
          remote,
        )
        .catch((e) => e as RequesterPolicyRefusal);
      expect(error).toBeInstanceOf(RequesterPolicyRefusal);
      expect((error as RequesterPolicyRefusal).ceiling).toBe(
        "not-expressible-remotely",
      );
    }
    // An empty selection is a selection: `mcp: []` is how a caller disables
    // defaults, and admitting it would make the refusal shape-dependent.
    await expect(
      m.run(
        { runtime: "codex", prompt: "hello", cwd: f.root, mcp: [] },
        remote,
      ),
    ).rejects.toThrow(RequesterPolicyRefusal);
    expect(await m.registry.all()).toHaveLength(0);
  } finally {
    await m.close();
  }
});

test("a level above the profile's ceiling is refused", async () => {
  const { f, m } = await muster(enrolled());
  try {
    await expect(
      m.run(
        { runtime: "codex", prompt: "hello", cwd: f.root, level: "work" },
        remote,
      ),
    ).rejects.toThrow(RequesterPolicyRefusal);
  } finally {
    await m.close();
  }
});

test("OpenCode is refused where kernel enforcement is required", async () => {
  const { f, m } = await muster(enrolled());
  try {
    const error = await m
      .run({ runtime: "opencode", prompt: "hello", cwd: f.root }, remote)
      .catch((e) => e as RequesterPolicyRefusal);
    expect(error).toBeInstanceOf(RequesterPolicyRefusal);
    expect((error as RequesterPolicyRefusal).ceiling).toBe("enforcement");
    expect(await m.registry.all()).toHaveLength(0);
  } finally {
    await m.close();
  }
});

/**
 * A nonsense token rather than a sentence: it can only have come from the
 * prompt, and `includes` over the whole serialized line needs no knowledge of
 * which field carried it.
 */
const TOKEN = "zqxjplover";

test("a remote launch records provenance, grade and a log with no trace of the prompt", async () => {
  const { f, m } = await muster(enrolled());
  try {
    const record = await m.run(
      { runtime: "codex", prompt: TOKEN, cwd: f.root },
      remote,
    );
    expect(record.enforcement).toBe("kernel");
    const [entry] = await m.registry.all();
    expect(entry!.requester).toEqual(remote);
    expect(entry!.enforcement).toBe("kernel");
    // A listing reports the same fact the launch result does. `list()` builds
    // its records separately, so this is not implied by the assertion above.
    expect((await m.list())[0].enforcement).toBe("kernel");
    // Not `line.prompt === undefined`: the prompt reached the log through
    // `peer.name` and `peer.canonical_id`, which the runtime slugs from its own
    // session title, and a field-by-field assertion cannot see a field it does
    // not name. One assertion over the serialized line, immune to the next
    // field someone adds to a record.
    const written = await lines(join(f.home, "launches.jsonl"));
    expect(written.length).toBeGreaterThan(0);
    expect(written.some((l) => l.event === "ready")).toBe(true);
    for (const line of written) {
      expect(JSON.stringify(line)).not.toContain(TOKEN);
      if (line.requester) expect(line.requester).toEqual(remote);
    }
  } finally {
    await m.close();
  }
}, 15000);

test("the agent gets the composed environment, not Muster's own", async () => {
  // Proof that `agentBaseEnv` is what reaches the runtime. `MUSTER_FAKE_ROOT`
  // is present in Muster's own environment and absent from this profile, and
  // the fake refuses to start without it — so the specific failure of the
  // Codex configuration probe, which runs on the composed environment, is the
  // assertion. `hostEnv` would have carried it and this would have launched.
  const { f, m } = await muster(`
launch_timeout_sec = 3

[requester_profiles.research]
allowed_roots = ["/"]
env_allow = ["CODEX_HOME"]

[requester_profiles.research.env_defaults]
LANG = "en_US.UTF-8"

[[requesters]]
authority = "example.peer.v1"
subject = "abc"
profile = "research"
`);
  try {
    await expect(
      m.run({ runtime: "codex", prompt: "hello", cwd: f.root }, remote),
    ).rejects.toThrow(/Cannot verify effective Codex MCP configuration/);
  } finally {
    await m.close();
  }
}, 15000);

test("a local launch still logs its prompt and records local provenance", async () => {
  const { f, m } = await muster("launch_timeout_sec = 3\n");
  try {
    await m.run({ runtime: "codex", prompt: TOKEN, cwd: f.root });
    const [entry] = await m.registry.all();
    expect(entry!.requester).toEqual({ kind: "local" });
    const written = await lines(join(f.home, "launches.jsonl"));
    expect(written.some((l) => l.prompt === TOKEN)).toBe(true);
    // The counterpart that keeps the remote assertion honest: the same token,
    // the same search, opposite answer. Without this the remote test would
    // still pass if nothing were ever written.
    expect(written.some((l) => JSON.stringify(l).includes(TOKEN))).toBe(true);
  } finally {
    await m.close();
  }
}, 15000);

test("a remote launch is confined to the profile's roots, not the global projects", async () => {
  const { f, m } = await muster(`
launch_timeout_sec = 3

[projects]
elsewhere = "/tmp"

[requester_profiles.research]
allowed_roots = ["/var/empty"]

[[requesters]]
authority = "example.peer.v1"
subject = "abc"
profile = "research"
`);
  try {
    // Asserting the specific refusal: `toBeInstanceOf(Error)` alone would pass
    // on a missing fake binary or a timeout and prove nothing.
    await expect(
      m.run({ runtime: "codex", prompt: "hello", cwd: f.root }, remote),
    ).rejects.toThrow(/workspace|allowed|root/i);
    expect(await m.registry.all()).toHaveLength(0);
  } finally {
    await m.close();
  }
});

test("a remote request naming no level gets the profile's, not the machine's defaults", async () => {
  // The ceiling-bypass regression. Global defaults are deliberately wider than
  // the profile here; before the effective-level fix this launched with
  // auto + workspace-write and passed every check.
  const { f, m } = await muster(
    enrolled("", 'permissions = "auto"\nsandbox = "workspace-write"'),
  );
  try {
    const record = await m.run(
      { runtime: "codex", prompt: "hello", cwd: f.root },
      remote,
    );
    expect(record.permissions).toBe("deny");
    expect(record.sandbox).toBe("read-only");
    const [entry] = await m.registry.all();
    expect(entry!.sandbox).toBe("read-only");
    // The argv the process was actually given, not the record describing it.
    // `launchArgs` resolves its own pair, so the record and the argv can
    // disagree — and a record-only assertion passes while the spawned Codex
    // holds `--approve-for-me`. This is the assertion that catches that.
    const [start] = await lines(join(f.root, "starts.jsonl"));
    expect(start.argv).toContain("--sandbox");
    expect(start.argv[start.argv.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(start.argv).not.toContain("--approve-for-me");
    expect(start.argv).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  } finally {
    await m.close();
  }
}, 15000);

test("a local launch still takes the machine's configured defaults", async () => {
  const { f, m } = await muster(`
launch_timeout_sec = 3
permissions = "auto"
sandbox = "workspace-write"
`);
  try {
    const record = await m.run({
      runtime: "codex",
      prompt: "hello",
      cwd: f.root,
    });
    expect(record.permissions).toBe("auto");
    expect(record.sandbox).toBe("workspace-write");
  } finally {
    await m.close();
  }
}, 15000);

test("the effective request, not the raw one, is what launchArgs may be given", async () => {
  // Unit-level proof of the same property, on the function that recomputes the
  // pair. Both halves are asserted: what the raw request produces under this
  // config is exactly the containment a `read` profile must not get, so the
  // second half is the reason the first half matters.
  const config = configSchema.parse({
    permissions: "auto",
    sandbox: "workspace-write",
  });
  const req = runSchema.parse({
    runtime: "codex",
    prompt: "hello",
    cwd: "/tmp",
  });
  const effective = launchArgs({ ...req, level: "read" }, config);
  expect(effective).toContain("--sandbox");
  expect(effective[effective.indexOf("--sandbox") + 1]).toBe("read-only");
  expect(effective).not.toContain("--approve-for-me");
  expect(launchArgs(req, config)).toContain("--approve-for-me");

  const claude = launchArgs(
    { ...req, runtime: "claude", level: "read" },
    config,
  );
  expect(claude[claude.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  const settings = JSON.parse(claude[claude.indexOf("--settings") + 1]!);
  expect(settings.permissions.defaultMode).toBe("dontAsk");
  expect(settings.sandbox.filesystem.denyWrite).toEqual(["/"]);
  expect(settings.permissions.deny).toContain("Write");
});

test("a levelless remote OpenCode launch is not handed --auto either", async () => {
  // The OpenCode builders recompute the pair the same way `launchArgs` does,
  // and a `tool-policy` profile is what makes them reachable remotely.
  const { f, m } = await muster(`
launch_timeout_sec = 6
permissions = "auto"
sandbox = "workspace-write"

[requester_profiles.research]
allowed_roots = ["/"]
min_enforcement = "tool-policy"
env_allow = ["MUSTER_FAKE_ROOT", "MUSTER_FAKE_PYTHON", "MUSTER_TEST_HOME"]

[requester_profiles.research.env_defaults]
LANG = "en_US.UTF-8"

[[requesters]]
authority = "example.peer.v1"
subject = "abc"
profile = "research"
`);
  try {
    const record = await m.run(
      { runtime: "opencode", prompt: "hello", cwd: f.root },
      remote,
    );
    expect(record.permissions).toBe("deny");
    expect(record.sandbox).toBe("read-only");
    expect(record.enforcement).toBe("tool-policy");
    const [start] = await lines(join(f.root, "starts.jsonl"));
    expect(start.argv).not.toContain("--auto");
  } finally {
    await m.close();
  }
}, 20000);

test("the OpenCode overlay a read level produces actually denies", () => {
  // For OpenCode the permission map delivered through OPENCODE_CONFIG_CONTENT
  // IS the containment — that is why its grade is `tool-policy` and not
  // `kernel`. Asserting only the absence of `--auto` would pass a regression
  // that kept the flag off while widening this map, so assert the map. The
  // second half is the negative control: under the same config, the request
  // without the level produces a different and permissive map, so neither
  // assertion can be true by accident.
  const config = configSchema.parse({
    permissions: "auto",
    sandbox: "workspace-write",
  });
  const req = runSchema.parse({
    runtime: "opencode",
    prompt: "hello",
    cwd: "/tmp",
  });
  const denying = openCodeConfig({ ...req, level: "read" }, config, [], [])
    .permission as Record<string, string>;
  expect(denying["*"]).toBe("deny");
  for (const tool of [
    "edit",
    "bash",
    "task",
    "webfetch",
    "websearch",
    "external_directory",
  ])
    expect(denying[tool]).toBe("deny");
  expect(denying.read).toBe("allow");

  const permissive = openCodeConfig(req, config, [], []).permission as Record<
    string,
    string
  >;
  expect(permissive).not.toEqual(denying);
  expect(permissive["*"]).toBe("ask");
  // Neither is denied here: they fall through to the `ask` fallback, which is
  // exactly the widening a `--auto`-only assertion cannot see.
  expect(permissive.edit).toBeUndefined();
  expect(permissive.bash).toBeUndefined();
});

test("a remote requester may not stop another remote requester's launch, and it survives", async () => {
  const { f, m } = await muster(twoRequesters());
  try {
    const peer = asSession(
      await m.run(
        { runtime: "codex", prompt: "owned by abc", cwd: f.root, host: "pty" },
        remote,
      ),
    );
    const error = await m
      .stop(peer.canonical_id!, otherRemote)
      .catch((e) => e as RequesterPolicyRefusal);
    expect(error).toBeInstanceOf(RequesterPolicyRefusal);
    expect((error as RequesterPolicyRefusal).ceiling).toBe("not-owner");
    // Refused before it stopped anything, not after — the launch is still
    // registered as running, not just "the call threw".
    const [entry] = await m.registry.all();
    expect(entry!.status).toBe("running");
  } finally {
    await m.close();
  }
}, 15000);

test("a remote requester may not read another remote requester's task output", async () => {
  const { f, m } = await muster(twoRequesters());
  try {
    const task = asTask(
      await m.run(
        { runtime: "codex", kind: "task", prompt: "owned by abc", cwd: f.root },
        remote,
      ),
    );
    for (let i = 0; i < 50; i++) {
      if ((await m.list("task"))[0]?.state === "exited") break;
      await delay(50);
    }
    const error = await m
      .output(task.id, otherRemote)
      .catch((e) => e as RequesterPolicyRefusal);
    expect(error).toBeInstanceOf(RequesterPolicyRefusal);
    expect((error as RequesterPolicyRefusal).ceiling).toBe("not-owner");
    // Proof there was real content to withhold, not an empty file that would
    // have made the refusal vacuous.
    expect(await m.output(task.id, remote)).toContain(
      "TASK_OUTPUT:owned by abc",
    );
  } finally {
    await m.close();
  }
}, 15000);

test("a local requester may stop a remote-owned launch, end to end", async () => {
  const { f, m } = await muster(twoRequesters());
  try {
    const peer = asSession(
      await m.run(
        { runtime: "codex", prompt: "owned by abc", cwd: f.root, host: "pty" },
        remote,
      ),
    );
    // No second argument: the same call every existing local caller makes.
    await m.stop(peer.canonical_id!);
    const [entry] = await m.registry.all();
    expect(entry!.status).toBe("stopped");
  } finally {
    await m.close();
  }
}, 15000);

test("the sandbox grants the config dir the agent will actually use", async () => {
  // Not the host's. `env_defaults` can deliver CLAUDE_CONFIG_DIR by design, and
  // an identity launch relocates it to a per-launch copy, so a grant computed
  // from Muster's own environment would name a directory the child never opens
  // — leaving its memory writes failing with EPERM exactly as in #80, while the
  // settings blob claimed a write root.
  const f = await fixture();
  const agentConfig = join(f.root, "agent-config");
  await mkdir(agentConfig);
  await writeFile(
    join(agentConfig, "settings.json"),
    JSON.stringify({
      enabledPlugins: { "conventions@example-marketplace": true },
    }),
  );
  await writeFile(
    join(f.home, "config.toml"),
    `
launch_timeout_sec = 3

[requester_profiles.research]
level = "work"
allowed_roots = ["/"]
env_allow = ["CODEX_HOME", "MUSTER_FAKE_ROOT", "MUSTER_FAKE_PYTHON", "MUSTER_TEST_HOME"]

[requester_profiles.research.env_defaults]
LANG = "en_US.UTF-8"
CLAUDE_CONFIG_DIR = "${agentConfig}"

[[requesters]]
authority = "example.peer.v1"
subject = "abc"
profile = "research"
`,
  );
  const m = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  try {
    await m.run({ runtime: "claude", prompt: "hello", cwd: f.root }, remote);
    const started = (await lines(join(f.root, "starts.jsonl")))[0];
    const argv = started.argv as string[];
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
    expect(settings.sandbox.filesystem.allowWrite).toEqual([agentConfig]);
    // The same dir, so the forwarded plugin list is the agent's own too.
    expect(settings.enabledPlugins).toEqual({
      "conventions@example-marketplace": true,
    });
  } finally {
    await m.close();
  }
}, 15000);
