import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { LaunchLog } from "../src/log.js";
import { lines } from "./helpers.js";

async function log() {
  const home = await mkdtemp(join(tmpdir(), "mu-log-"));
  return { home, log: new LaunchLog(home), file: join(home, "launches.jsonl") };
}
const record = {
  event: "intent",
  launch_id: "l1",
  runtime: "codex",
  cwd: "/tmp",
  prompt: "do not persist me",
  requester: { kind: "remote", authority: "a", subject: "s" },
  permissions: "deny",
  mcp: ["tincan"],
};

test("full mode keeps the prompt, as it does today", async () => {
  const { log: l, file } = await log();
  await l.write(record);
  const [written] = await lines(file);
  expect(written.prompt).toBe("do not persist me");
  expect(written.at).toBeTypeOf("string");
});

test("metadata mode drops the prompt and keeps what diagnoses a failure", async () => {
  const { log: l, file } = await log();
  await l.write(record, "metadata");
  const [written] = await lines(file);
  expect(written.prompt).toBeUndefined();
  expect(written.launch_id).toBe("l1");
  expect(written.runtime).toBe("codex");
  expect(written.cwd).toBe("/tmp");
  expect(written.permissions).toBe("deny");
  expect(written.mcp).toEqual(["tincan"]);
  expect(written.requester).toEqual({
    kind: "remote",
    authority: "a",
    subject: "s",
  });
});

test("metadata mode drops captured output and environment alike", async () => {
  const { log: l, file } = await log();
  await l.write(
    {
      ...record,
      error: "boom",
      diagnostic: "screen contents",
      env: { A: "b" },
      args: ["--model", "gpt-5"],
    },
    "metadata",
  );
  const [written] = await lines(file);
  expect(written.error).toBe("boom");
  expect(written.diagnostic).toBeUndefined();
  expect(written.env).toBeUndefined();
  // Kept: the argv allowlist cannot carry instruction text or a credential.
  expect(written.args).toEqual(["--model", "gpt-5"]);
});

test("the file rotates at its ceiling and keeps one generation at 0600", async () => {
  const { home, log: l, file } = await log();
  await writeFile(file, "x".repeat(9 * 1024 * 1024), { mode: 0o600 });
  await l.write(record);
  const rotated = await stat(join(home, "launches.jsonl.1"));
  expect(rotated.size).toBeGreaterThan(1_000_000);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await lines(file)).toHaveLength(1);
});

test("a second rotation replaces the first backup, not creating a .2", async () => {
  const { home, log: l, file } = await log();
  // First rotation
  await writeFile(file, "x".repeat(9 * 1024 * 1024), { mode: 0o600 });
  await l.write(record);
  expect(await stat(join(home, "launches.jsonl.1"))).toBeDefined();
  // Second rotation
  await writeFile(file, "y".repeat(9 * 1024 * 1024), { mode: 0o600 });
  await l.write({ ...record, launch_id: "l2" });
  // Verify only .1 exists, no .2
  const files = await readdir(home);
  expect(files.sort()).toEqual(["launches.jsonl", "launches.jsonl.1"]);
});
