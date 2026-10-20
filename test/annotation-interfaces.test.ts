import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "./helpers.js";
import { MCP_TOOLS } from "../src/mcp-tools.js";

const cli = join(process.cwd(), "dist/muster.js");
const metadata = { "workflow.role": "reviewer" };
const provenance = {
  namespace: "workflow",
  session: "run-002",
  launcher: "controller",
  parent: null,
};
const options = [
  "metadata=" + JSON.stringify(metadata),
  "provenance=" + JSON.stringify(provenance),
];

test("CLI accepts structured options and preserves them after a task exits", async () => {
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "100" });
  const invoke = async (...args: string[]) =>
    (
      await promisify(execFile)(process.execPath, [cli, ...args], {
        env: f.env,
      })
    ).stdout;
  const result = JSON.parse(
    await invoke(
      "run",
      "codex",
      "--kind",
      "task",
      "--prompt",
      "review",
      "--cwd",
      f.root,
      ...options.flatMap((v) => ["--options", v]),
    ),
  );
  expect(result).toMatchObject({ metadata, provenance });
  expect(
    JSON.parse(await invoke("wait", result.id, "--timeout", "10s")),
  ).toMatchObject({ metadata, provenance, state: "exited" });
  expect(JSON.parse(await invoke("list"))[0]).toMatchObject({
    metadata,
    provenance,
  });
  expect(await invoke("list", "--format", "human")).toContain("workflow.role");
});

test("MCP discovery accepts structured options and the server returns their values", async () => {
  const schema = MCP_TOOLS.find((t) => t.name === "run")!.inputSchema.properties
    .options;
  // The published schema must not falsely reject these inputs before the
  // server gets them. Exercise the actual advertised alternatives.
  const alternatives = (
    schema.items as {
      anyOf?: ReadonlyArray<{ enum?: readonly string[]; pattern?: string }>;
    }
  ).anyOf;
  expect(alternatives).toBeDefined();
  for (const option of [...options, "auto-approve-path"])
    expect(
      alternatives!.some(
        (s) =>
          s.enum?.includes(option) ||
          (s.pattern && new RegExp(s.pattern).test(option)),
      ),
    ).toBe(true);
  expect(
    alternatives!.some(
      (s) =>
        s.enum?.includes("unknown-option") ||
        (s.pattern && new RegExp(s.pattern).test("unknown-option")),
    ),
  ).toBe(false);
  const f = await fixture({ MUSTER_FAKE_TASK_MS: "100" });
  const client = new Client({ name: "annotation-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp", "--allow-launch"],
    env: f.env,
    stderr: "pipe",
  });
  await client.connect(transport);
  const decode = (result: Record<string, unknown>) =>
    JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  try {
    const result = await client.callTool({
      name: "run",
      arguments: {
        runtime: "codex",
        kind: "task",
        prompt: "review",
        cwd: f.root,
        options,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(decode(result)).toMatchObject({ metadata, provenance });
    expect(
      decode(await client.callTool({ name: "list", arguments: {} }))[0],
    ).toMatchObject({ metadata, provenance });
    const refused = await client.callTool({
      name: "run",
      arguments: {
        runtime: "codex",
        prompt: "bad",
        cwd: f.root,
        options: ['metadata={"role":"a","role":"b"}'],
      },
    });
    expect(refused.isError).toBe(true);
  } finally {
    await client.close();
  }
});
