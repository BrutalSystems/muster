import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Muster } from "../src/run.js";
import { fixture, lines } from "./helpers.js";

async function muster() {
  const f = await fixture();
  await writeFile(
    join(f.home, "config.toml"),
    `launch_timeout_sec = 3

[projects]
work = "${f.root}"
`,
  );
  return { f, m: await Muster.create({ home: f.home, env: f.env }) };
}

test("the MCP entry point resolves a project rather than rejecting it", async () => {
  const { f, m } = await muster();
  try {
    // What src/muster.ts now passes: the raw arguments object.
    const record = await m.run({
      runtime: "codex",
      prompt: "hi",
      project: "work",
    } as unknown);
    expect(record.cwd).toBe(f.root);
  } finally {
    await m.close();
  }
});

test("a raw request naming a project resolves it", async () => {
  const { f, m } = await muster();
  try {
    const record = await m.run({
      runtime: "codex",
      prompt: "hi",
      project: "work",
    });
    expect(record.cwd).toBe(f.root);
  } finally {
    await m.close();
  }
});

test("a launch records its requester in the log", async () => {
  const { f, m } = await muster();
  try {
    await m.run(
      {
        runtime: "codex",
        prompt: "hi",
        project: "work",
      },
      // The MCP client's self-reported name is a label on a local requester,
      // which is what it always was in substance.
      { kind: "local", label: "mcp:testclient" },
    );
    const launches = await lines(join(f.home, "launches.jsonl"));
    const intentEvents = launches.filter((entry) => entry.event === "intent");
    expect(intentEvents.length).toBeGreaterThan(0);
    expect(intentEvents[0].requester).toEqual({
      kind: "local",
      label: "mcp:testclient",
    });
  } finally {
    await m.close();
  }
});
