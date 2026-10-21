import { test, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
// Invalid output must not silently pass a tool call; runtime plain-text stdout does.
test.each([
  [
    `process.stdout.write('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecision":"allow"}}')`,
    2,
  ],
  [
    'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:{private:true}}}))',
    2,
  ],
  [
    'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow"}}))',
    0,
  ],
  ["process.stdout.write('{bad json')", 2],
  ["process.stdout.write(JSON.stringify({unexpected:'private'}))", 2],
  ["process.stderr.write('private failure');process.exit(1)", 2],
  ["process.stderr.write('private denial');process.exit(2)", 2],
  [
    "process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'private reason'}}))",
    2,
  ],
  ["process.exit(0)", 0],
  ["setTimeout(()=>{},10000)", 2],
])(
  "guard runner handles %s without exposing hook text",
  async (script, expected) => {
    const root = await mkdtemp(join(tmpdir(), "guard-runner-"));
    await writeFile(join(root, "script.cjs"), script);
    const descriptor = join(root, "hook.json");
    await writeFile(
      descriptor,
      JSON.stringify({
        command: process.execPath,
        args: [join(root, "script.cjs")],
        timeout: 2,
      }),
    );
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "dist/guard-hook.js"), descriptor],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdin.end("{}");
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const code = await new Promise((r) => child.on("exit", r));
    expect(code).toBe(expected);
    expect(out).not.toContain("private");
  },
);
