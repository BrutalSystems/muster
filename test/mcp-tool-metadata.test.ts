import { test, expect } from "vitest";
import { ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { MCP_TOOLS, READ_ONLY_TOOLS } from "../src/mcp-tools.js";

/**
 * What a generic MCP host reads before calling a tool: a display title, and
 * annotations it may act on — `destructiveHint` above all, which is what makes
 * a host confirm `stop` before it ends someone's session.
 */
test("every tool parses as an MCP Tool, with a title and annotations", () => {
  for (const tool of MCP_TOOLS) {
    expect(() => ToolSchema.parse(tool), tool.name).not.toThrow();
    expect(tool.title, tool.name).toMatch(/\S/);
    expect(tool.annotations.title, tool.name).toBe(tool.title);
  }
});

test("annotations say what each tool does to the machine", () => {
  const hints = Object.fromEntries(
    MCP_TOOLS.map(({ name, annotations: { title, ...rest } }) => [name, rest]),
  );
  expect(hints).toEqual({
    run: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    list: { readOnlyHint: true, openWorldHint: false },
    stop: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    output: { readOnlyHint: true, openWorldHint: false },
    title: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  });
});

test("the read-only set is exactly the tools annotated read-only", () => {
  const readOnly = MCP_TOOLS.filter((t) => t.annotations.readOnlyHint).map(
    (t) => t.name,
  );
  expect(readOnly).toEqual([...READ_ONLY_TOOLS]);
});
