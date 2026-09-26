import { expect, test } from "vitest";
import { AGENTS } from "../src/agents.js";
import { runSchema, runtimeArgs } from "../src/guard.js";
import { enforcementGrade } from "../src/enforcement.js";

/**
 * One row per agent, and the compiler refuses a runtime that is missing one.
 * Before this, the same three facts were asked for in three different places
 * by three different `runtime === ?` tests, and adding a fourth agent meant
 * finding them all by hand with nothing to say when you had missed one.
 *
 * The rows here are asserted against the behaviour they replaced, not merely
 * against themselves — a table that agrees with nothing is just a second place
 * to be wrong.
 */
test("every runtime has a complete row", () => {
  const runtimes = ["claude", "codex", "opencode"] as const;
  expect(Object.keys(AGENTS).sort()).toEqual([...runtimes].sort());
  for (const runtime of runtimes) {
    const row = AGENTS[runtime];
    expect(row.enforcement, `${runtime} enforcement`).toMatch(
      /^(kernel|tool-policy)$/,
    );
    expect(Array.isArray(row.runtimeOptions.forwarded)).toBe(true);
    expect(Array.isArray(row.runtimeOptions.consumed)).toBe(true);
  }
});

test("the rows say what the code they replace said", () => {
  // Configuration home: OpenCode genuinely has none, and `null` is the answer
  // rather than a gap.
  expect(AGENTS.claude.configHomeVar).toBe("CLAUDE_CONFIG_DIR");
  expect(AGENTS.codex.configHomeVar).toBe("CODEX_HOME");
  expect(AGENTS.opencode.configHomeVar).toBe(null);

  // Enforcement: OpenCode's permissions are tool policy, with no kernel behind
  // them. Checked through the function that callers use, not just the row.
  const sandboxed = {
    permissions: "auto",
    sandbox: "workspace-write",
  } as const;
  expect(enforcementGrade("claude", sandboxed)).toBe(AGENTS.claude.enforcement);
  expect(enforcementGrade("codex", sandboxed)).toBe(AGENTS.codex.enforcement);
  expect(enforcementGrade("opencode", sandboxed)).toBe(
    AGENTS.opencode.enforcement,
  );

  // Runtime options, through `runtimeArgs`: --effort is Claude's alone, and
  // OpenCode forwards a model where the others consume it.
  const req = (runtime: "claude" | "codex" | "opencode", args: string[]) =>
    runSchema.parse({ runtime, prompt: "hello", args });
  expect(runtimeArgs(req("claude", ["--effort", "high"]))).toEqual([
    "--effort",
    "high",
  ]);
  expect(() => runtimeArgs(req("codex", ["--effort", "high"]))).toThrow();
  expect(runtimeArgs(req("opencode", ["--model", "a/b"]))).toEqual([
    "--model",
    "a/b",
  ]);
  // Consumed, not forwarded: muster owns the model flag for these two.
  expect(runtimeArgs(req("claude", ["--model", "opus"]))).toEqual([]);
});

/**
 * Workspace trust is a slot where readiness is not, and the difference is the
 * INPUTS. Both are "one question, several mechanisms" — but trust takes the
 * same two arguments for every agent and returns nothing, while readiness needs
 * a socket path for Claude, a live RPC handle for Codex and a server URL plus a
 * port-ownership check for OpenCode. A uniform signature is honest for the
 * first and a lie for the second.
 */
test("workspace trust is a slot, and OpenCode's answer is that it has none", () => {
  expect(typeof AGENTS.claude.trustWorkspace).toBe("function");
  expect(typeof AGENTS.codex.trustWorkspace).toBe("function");
  expect(AGENTS.opencode.trustWorkspace).toBe(null);
});

/**
 * Stopping has one per-agent step and it is a pre-step, not the kill itself:
 * OpenCode is asked to abort over its own endpoint before anything is
 * signalled, because it is a server with work in flight. Claude and Codex have
 * nothing to say first. Killing the process tree afterwards is identical for
 * all three and stays where it is.
 */
test("only OpenCode has something to say before it is stopped", () => {
  expect(typeof AGENTS.opencode.beforeStop).toBe("function");
  expect(AGENTS.claude.beforeStop).toBe(null);
  expect(AGENTS.codex.beforeStop).toBe(null);
});

/**
 * Refresh is a slot for the same reason trust and beforeStop are, and readiness
 * is not: the inputs match. Every agent answers "what is this session called
 * and what is it doing" from the entry, the environment its configuration lives
 * in, and a deadline.
 */
test("every agent can report live metadata", () => {
  for (const runtime of ["claude", "codex", "opencode"] as const)
    expect(typeof AGENTS[runtime].refreshMetadata, runtime).toBe("function");
});
