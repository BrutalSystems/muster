import { test, expect } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture, lines } from "./helpers.js";
import { asSession } from "./narrow.js";
import { testServer } from "./global-setup.js";
import { Muster } from "../src/run.js";
import { PtyHost } from "../src/hosts/pty.js";
import { TmuxHost } from "../src/hosts/tmux.js";
import { delay } from "../src/identity/processes.js";
const contract = process.env.MUSTER_CONTRACT === "1" ? test : test.skip;
for (const host of ["tmux", "pty"] as const)
  for (const runtime of ["codex", "claude"] as const) {
    contract(
      `installed Tin Can resolves and delivers to ${runtime} launched through ${host}`,
      async () => {
        const f = await fixture();
        const driver =
          host === "tmux"
            ? new TmuxHost(testServer("contract-" + runtime))
            : new PtyHost();
        const m = await Muster.create({
          home: f.home,
          env: f.env,
          drivers: [driver],
        });
        const peer = asSession(
          await m.run({
            runtime,
            prompt: "contract peer",
            cwd: f.root,
            host,
          }),
        );
        const env = {
          ...f.env,
          TINCAN_HOME: join(f.root, "tincan-isolated"),
          ASDF_DATA_DIR: process.env.ASDF_DATA_DIR ?? join(homedir(), ".asdf"),
          ASDF_NODEJS_VERSION: process.version.slice(1),
        };
        delete (env as any).CLAUDE_CODE_MESSAGING_SOCKET;
        if (runtime === "codex")
          (env as any).CLAUDE_CODE_MESSAGING_SOCKET =
            "/unused-test-context-marker";
        const client = new Client({ name: "muster-contract", version: "1" });
        const transport = new StdioClientTransport({
          command: process.env.MUSTER_TINCAN_BIN ?? "tincan",
          args: [],
          env,
          stderr: "pipe",
        });
        let stderr = "";
        transport.stderr?.on("data", (d) => (stderr += d.toString()));
        try {
          try {
            await client.connect(transport);
          } catch (e) {
            throw new Error(
              `Installed Tin Can prerequisite failed: ${e}; ${stderr}`,
            );
          }
          const response = await client.callTool({
            name: "peers",
            arguments: {},
          });
          expect(response.isError).not.toBe(true);
          const listing = JSON.parse((response.content as any)[0].text);
          const found = listing.peers.filter(
            (p: any) => p.canonical_id === peer.canonical_id,
          );
          expect(found).toHaveLength(1);
          const field = runtime === "codex" ? "thread_id" : "session_id";
          expect(
            found[0][field],
            "Tin Can >=0.2.0 must expose the durable identity",
          ).toBe(peer[field]);
          const sent = await client.callTool({
            name: "send_peer",
            arguments: {
              peer: peer.canonical_id,
              message: "MUSTER_CONTRACT_DELIVERY",
            },
          });
          expect(sent.isError).not.toBe(true);
          // Tin Can 1.0.0 replaced `delivered` with `outcome`. `delivered:
          // false` conflated "you addressed it wrong" with "that session is
          // gone"; `rejected` and `failed` separate them.
          expect(JSON.parse((sent.content as any)[0].text).outcome).toBe(
            "accepted",
          );
          let receipts: any[] = [];
          for (let i = 0; i < 20; i++) {
            receipts = await lines(join(f.root, "receipts.jsonl"));
            if (receipts.length) break;
            await delay(50);
          }
          expect(receipts).toHaveLength(1);
          expect(receipts[0].uuid).toBe(peer[field]);
          expect(JSON.stringify(receipts[0])).toContain(
            "MUSTER_CONTRACT_DELIVERY",
          );
        } finally {
          await client.close();
          await m.stop(peer.canonical_id);
          await m.close();
        }
      },
      20000,
    );
  }
