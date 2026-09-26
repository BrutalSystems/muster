import { expect, test } from "vitest";
import { MCP_TOOLS, RUN_MCP_OMITTED } from "../src/mcp-tools.js";
import { runSchema } from "../src/guard.js";

const run = MCP_TOOLS.find((t) => t.name === "run")!;
const advertised = run.inputSchema.properties as Record<string, unknown>;

/**
 * The test that ends a class of bug rather than one instance of it.
 *
 * One request shape has two hand-maintained descriptions — `runSchema` and the
 * advertised MCP `run` inputSchema — and until now nothing asserted they agreed.
 * Four fields drifted across two branches: `level`, then `identity`, `model` and
 * `plugin`. And because the inputSchema is `additionalProperties: false`, an
 * omitted key is not merely undocumented: a conformant client is told it is
 * INVALID, so the flag is unreachable rather than just undiscoverable.
 *
 * Without this, the next field added to runSchema flips the same coin.
 */
test("every runSchema key is advertised by the MCP run tool, or explicitly omitted", () => {
  const missing = Object.keys(runSchema.shape).filter(
    (key) => !(key in advertised) && !RUN_MCP_OMITTED.includes(key),
  );
  expect(missing).toEqual([]);
});

test("the MCP run tool advertises nothing runSchema would reject", () => {
  // The other direction: `additionalProperties: false` on a strict Zod object
  // means an advertised key runSchema does not accept is a documented request
  // that always fails.
  const stray = Object.keys(advertised).filter(
    (key) => !(key in runSchema.shape),
  );
  expect(stray).toEqual([]);
});

test("the omission list carries only deliberate decisions", () => {
  // An entry must name a real runSchema field, so a stale one cannot sit there
  // silently excusing a field that no longer exists.
  for (const key of RUN_MCP_OMITTED) expect(key in runSchema.shape).toBe(true);
});

test("the schema stays closed, which is what makes the drift matter", () => {
  expect(run.inputSchema.additionalProperties).toBe(false);
});

test("identity, model and plugin are reachable from an MCP client", () => {
  // The three that had drifted when this test was written. Named explicitly so
  // a future refactor of the generic assertions above cannot quietly lose them.
  for (const key of ["identity", "model", "plugin"])
    expect(advertised[key]).toBeTruthy();
  expect(
    runSchema.parse({
      runtime: "opencode",
      prompt: "hi",
      identity: "work",
      model: "anthropic/claude",
      plugin: ["one"],
    }),
  ).toMatchObject({
    identity: "work",
    model: "anthropic/claude",
    plugin: ["one"],
  });
});
