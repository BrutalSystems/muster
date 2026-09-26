import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { expect, test } from "vitest";
import { PtyHost } from "../src/hosts/pty.js";
import { processRef } from "../src/identity/processes.js";
import { OpenCodeHttp } from "../src/opencode-http.js";
import { Muster } from "../src/run.js";
import { fixture, lines } from "./helpers.js";
import { asSessionOf } from "./narrow.js";
import { ampleDeadline } from "./deadline.js";

async function openCodeMuster(
  extra: Record<string, string> = {},
  config?: TOML.JsonMap,
) {
  const f = await fixture(extra);
  if (config)
    await writeFile(join(f.home, "config.toml"), TOML.stringify(config));
  const muster = await Muster.create({
    home: f.home,
    env: f.env,
    drivers: [new PtyHost()],
  });
  return { f, muster };
}

test("OpenCode child starts pure with only the selected MCP enabled and launch logs redact config secrets", async () => {
  const token = "selected-token-must-not-be-logged";
  const { f, muster } = await openCodeMuster(
    { MUSTER_FAKE_OPENCODE_INHERITED_MCP: "unselected" },
    {
      host: "pty",
      mcp_servers: {
        fixture: {
          command: process.execPath,
          args: [join(process.cwd(), "test/fakes/mcp.mjs")],
          env: { FIXTURE_TOKEN: token },
          tools: ["ping"],
          required: true,
        },
      },
    },
  );
  try {
    const peer = asSessionOf(
      await muster.run({
        runtime: "opencode",
        prompt: "security review",
        cwd: f.root,
        host: "pty",
        mcp: ["fixture"],
      }),
      "opencode",
    );
    const start = (await lines(join(f.root, "starts.jsonl"))).find(
      (record) =>
        record.runtime === "opencode" && record.id === peer.session_id,
    );
    expect(start).toMatchObject({
      cwd: await realpath(f.root),
      argv: expect.arrayContaining(["--pure"]),
      mcp: {
        unselected: { enabled: false },
        fixture: { enabled: true, type: "local" },
      },
      tools: { "unselected_*": false, "fixture_*": true },
      configContentPresent: true,
    });

    const launchLog = await readFile(join(f.home, "launches.jsonl"), "utf8");
    expect(launchLog).not.toContain(token);
    expect(launchLog).not.toContain("OPENCODE_CONFIG_CONTENT");
    await muster.stop(peer.session_id);
  } finally {
    await muster.close();
  }
});

test.each([
  ["--auto"],
  ["--pure"],
  ["--hostname", "0.0.0.0"],
  ["--port", "8080"],
  ["--attach", "http://127.0.0.1:8080"],
  ["--session", "ses_other"],
  ["--config", "other.json"],
  ["--settings", "{}"],
] as string[][])(
  "refused OpenCode lifecycle/config option %s never starts the fake",
  async (...args) => {
    const { f, muster } = await openCodeMuster();
    try {
      await expect(
        muster.run({
          runtime: "opencode",
          prompt: "must not start",
          cwd: f.root,
          host: "pty",
          args,
        }),
      ).rejects.toThrow(/Runtime option refused/);
      expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
      expect(await muster.registry.all()).toEqual([]);
    } finally {
      await muster.close();
    }
  },
);

test("a managed OpenCode policy override fails closed before the child starts", async () => {
  const { f, muster } = await openCodeMuster({
    MUSTER_FAKE_OPENCODE_INHERITED_MCP: "unselected",
    MUSTER_FAKE_OPENCODE_MANAGED_OVERRIDE: "1",
  });
  try {
    await expect(
      muster.run({
        runtime: "opencode",
        prompt: "managed policy",
        cwd: f.root,
        host: "pty",
      }),
    ).rejects.toThrow(/isolation.*refusing launch/i);
    expect(await lines(join(f.root, "starts.jsonl"))).toEqual([]);
    expect((await muster.registry.all())[0]).toMatchObject({
      status: "failed",
    });
  } finally {
    await muster.close();
  }
});

test.each([
  [100, 250],
  [250, 100],
])(
  "OpenCode readiness waits for health delayed %dms and session creation delayed %dms",
  async (healthMs, sessionMs) => {
    const { f, muster } = await openCodeMuster({
      MUSTER_FAKE_OPENCODE_HEALTH_MS: String(healthMs),
      MUSTER_FAKE_OPENCODE_SESSION_MS: String(sessionMs),
    });
    const startedAt = Date.now();
    try {
      const peer = asSessionOf(
        await muster.run({
          runtime: "opencode",
          prompt: "delayed readiness",
          cwd: f.root,
          host: "pty",
        }),
        "opencode",
      );
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
        Math.max(healthMs, sessionMs) - 25,
      );
      expect(peer).toMatchObject({ runtime: "opencode", state: "idle" });
      await muster.stop(peer.session_id);
    } finally {
      await muster.close();
    }
  },
);

test.each(["health", "session", "status"])(
  "malformed OpenCode %s responses fail readiness and clean the child",
  async (response) => {
    const { f, muster } = await openCodeMuster(
      { MUSTER_FAKE_OPENCODE_MALFORMED: response },
      { host: "pty", launch_timeout_sec: 0.6 },
    );
    try {
      await expect(
        muster.run({
          runtime: "opencode",
          prompt: `malformed ${response}`,
          cwd: f.root,
          host: "pty",
        }),
      ).rejects.toThrow(/OpenCode|session|endpoint|protocol/i);
      const [start] = await lines(join(f.root, "starts.jsonl"));
      expect(start).toMatchObject({ runtime: "opencode" });
      expect(await processRef(start.pid)).toBeUndefined();
      expect((await muster.registry.all())[0]).toMatchObject({
        status: "failed",
      });
    } finally {
      await muster.close();
    }
  },
  10_000,
);

test.each([
  ["idle", "idle"],
  ["active", "busy"],
  ["retry", "busy"],
] as const)(
  "fake OpenCode %s status maps to Muster %s",
  async (status, expected) => {
    const { f, muster } = await openCodeMuster({
      MUSTER_FAKE_OPENCODE_STATUS: status,
    });
    try {
      const peer = asSessionOf(
        await muster.run({
          runtime: "opencode",
          prompt: `${status} status`,
          cwd: f.root,
          host: "pty",
        }),
        "opencode",
      );
      expect(peer.state).toBe(expected);
      await muster.stop(peer.session_id);
    } finally {
      await muster.close();
    }
  },
);

test("list observes a launched OpenCode session transition from idle through busy and retry", async () => {
  const { f, muster } = await openCodeMuster();
  try {
    const peer = asSessionOf(
      await muster.run({
        runtime: "opencode",
        prompt: "state transitions",
        cwd: f.root,
        host: "pty",
      }),
      "opencode",
    );
    expect(peer.state).toBe("idle");
    await expect(
      new OpenCodeHttp(peer.server_url).statuses(ampleDeadline()),
    ).resolves.toEqual({});
    const [start] = (await lines(join(f.root, "starts.jsonl"))).filter(
      (record) => record.id === peer.session_id,
    );

    await writeFile(
      start.statePath,
      JSON.stringify({ title: "state transitions", status: { type: "busy" } }),
    );
    expect((await muster.list("session"))[0]).toMatchObject({ state: "busy" });

    await writeFile(
      start.statePath,
      JSON.stringify({ title: "state transitions", status: { type: "idle" } }),
    );
    expect((await muster.list("session"))[0]).toMatchObject({ state: "idle" });

    await writeFile(
      start.statePath,
      JSON.stringify({
        title: "state transitions",
        status: {
          type: "retry",
          attempt: 3,
          message: "provider overloaded",
          next: ampleDeadline(),
        },
      }),
    );
    expect((await muster.list("session"))[0]).toMatchObject({ state: "busy" });
    await muster.stop(peer.session_id);
  } finally {
    await muster.close();
  }
});

test("OpenCode process exit during readiness records failure and leaves no live child", async () => {
  const { f, muster } = await openCodeMuster({
    MUSTER_FAKE_OPENCODE_HEALTH_MS: "500",
    MUSTER_FAKE_OPENCODE_EXIT_MS: "100",
  });
  try {
    await expect(
      muster.run({
        runtime: "opencode",
        prompt: "exit during readiness",
        cwd: f.root,
        host: "pty",
      }),
    ).rejects.toThrow(/process exited/i);
    const [start] = await lines(join(f.root, "starts.jsonl"));
    expect(await processRef(start.pid)).toBeUndefined();
    expect((await muster.registry.all())[0]).toMatchObject({
      status: "failed",
    });
  } finally {
    await muster.close();
  }
});
