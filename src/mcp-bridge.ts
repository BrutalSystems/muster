// Claude has permission rules, but no MCP exposure allowlist. This stdio
// connection exposes and dispatches only the operator-selected tools, including
// when the upstream server changes its tool catalog after launch.
import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpServerSchema, mcpName, mcpTransport } from "./mcp.js";

async function main() {
  const [path, name] = process.argv.slice(2);
  if (!path || !name || !mcpName.safeParse(name).success)
    throw new Error("Invalid MCP bridge arguments");
  const definitions = JSON.parse(await readFile(path, "utf8"));
  const config = mcpServerSchema.parse(definitions[name]);
  const client = new Client(
    { name: "muster-tool-bridge", version: "1" },
    { capabilities: {} },
  );
  const server = new Server(
    { name: `muster-${name}`, version: "1" },
    { capabilities: { tools: {} } },
  );
  let shutdown: Promise<void> | undefined;
  const close = () =>
    (shutdown ??= Promise.resolve().then(async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => {
      void close().finally(() => process.exit(0));
    });
  process.stdin.once("end", () => {
    void close();
  });
  process.stdin.once("close", () => {
    void close();
  });
  server.onclose = () => {
    void close();
  };
  client.onclose = () => {
    void close();
  };
  const transport = mcpTransport(
    config,
    process.env as Record<string, string>,
    process.cwd(),
  );
  const timer = setTimeout(() => {
    void close().finally(() => process.exit(1));
  }, config.startup_timeout_sec * 1000);
  try {
    await client.connect(transport);
    if (shutdown) {
      await close();
      return;
    }
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools.filter((t) => config.tools.includes(t.name)));
      cursor = page.nextCursor;
    } while (cursor);
    return { tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (!config.tools.includes(params.name))
      return {
        isError: true,
        content: [
          { type: "text", text: "Tool not enabled for this Muster launch" },
        ],
      };
    return await client.callTool({
      name: params.name,
      arguments: params.arguments,
    });
  });
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await close();
    throw error;
  }
}
main().catch(() => {
  process.stderr.write(
    "Muster MCP connection failed; check the selected server configuration.\n",
  );
  process.exitCode = 1;
});
