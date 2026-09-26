# Agent capabilities

Muster drives three agents. This is the list of what it has to know about each,
and where that knowledge lives today.

It exists because the knowledge is **half-organised**: `identity/`, `reach/` and
the `*-policy.ts` modules already group per-agent code, while the rest is spread
through `run.ts`, `mcp.ts`, `format.ts` and `naming.ts`. Written down before any
rearranging, so the move can be checked against a list rather than against
memory, and so "not applicable" is recorded as an answer rather than read as a
gap.

`N/A` is a real answer. OpenCode has no configuration-directory variable and no
workspace-trust gate; inventing empty ones would be worse than saying so.

## The capabilities

| #   | Capability                         | Claude                               | Codex                                             | OpenCode                                              | Lives in                                                                         |
| --- | ---------------------------------- | ------------------------------------ | ------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | **Preflight** — may this run here? | refuse unverifiable managed settings | compute `-c` overrides for unselected MCP servers | version check                                         | `claude-policy.ts`, `codex-policy.ts`, `opencode-policy.ts`; dispatched `run.ts` |
| 2   | **Model selection**                | bare id                              | bare id                                           | `PROVIDER/MODEL`                                      | `guard.ts` (`resolveModel`, `RUNTIME_OPTIONS`)                                   |
| 3   | **MCP wiring**                     | `--mcp-config` + bridge file         | `-c mcp_servers.*`                                | own config                                            | **split**: `mcp.ts` for two, `opencode-policy.ts` for the third                  |
| 4   | **Plugins**                        | N/A                                  | N/A                                               | selected per launch                                   | `plugins.ts`; dispatched `run.ts`                                                |
| 5   | **Credentials**                    | token env var                        | `auth.json`                                       | —                                                     | `identity-auth.ts`, `identity-cli.ts`                                            |
| 6   | **Workspace trust**                | `.claude.json` in the identity copy  | Codex's own file and key                          | N/A                                                   | `identity-copy.ts`; dispatched `run.ts`                                          |
| 7   | **Build and start**                | argv + inline `--settings`           | argv + `-c`                                       | start a server on an allocated port                   | `guard.ts` (`launchArgs`), `opencode-policy.ts`                                  |
| 8   | **Deliver the prompt**             | argv after `--`                      | argv after `--`                                   | HTTP request                                          | same as 7                                                                        |
| 9   | **Identify the session**           | read the record it writes            | JSON-RPC `thread/read`                            | HTTP                                                  | `identity/{claude,codex,opencode}.ts`                                            |
| 10  | **Is it alive**                    | connect to a Unix socket             | JSON-RPC call                                     | HTTP **and** confirm the port is owned by our process | `reach/{claude,codex,opencode}.ts`                                               |
| 11  | **Stop**                           | stop the process                     | stop the process                                  | abort over the endpoint first, then stop              | `run.ts` (`stopEntry`)                                                           |
| 12  | **Refresh live metadata**          | —                                    | RPC                                               | HTTP + ownership check                                | `run.ts`                                                                         |
| 13  | **Where its state lives**          | `CLAUDE_CONFIG_DIR`                  | `CODEX_HOME`                                      | N/A                                                   | `run.ts` (`configHomeVar`)                                                       |
| 14  | **Name in records**                | `claude-code`                        | `codex`                                           | `opencode`                                            | `naming.ts`                                                                      |
| 15  | **Containment strength**           | kernel                               | kernel                                            | tool-policy                                           | `enforcement.ts`                                                                 |
| 16  | **Display**                        | —                                    | —                                                 | shows a server URL                                    | `format.ts`                                                                      |

## What the shape of that table says

**Rows 9 and 10 are the model to copy.** One file per agent, parallel names, a
single question each answers its own way. Nothing about them needs redesigning.

**Rows 11, 12 and 13 are the work.** They are per-agent behaviour living inside
`run.ts` rather than beside their siblings — found by asking `runtime === ?`
partway through a 700-line method.

**Row 3 is fixed.** It used to be one capability with two homes —
`claudeMcpConfig` and `codexMcpConfig` in `mcp.ts`, OpenCode's in
`opencode-policy.ts`. Each builder now lives in its own agent's module, and
`mcp.ts` keeps only what is runtime-agnostic: selection, preparation and the
environment. The direction was chosen by what the code already wanted —
OpenCode's builder depends on two helpers private to its module and could not
move without dragging them along.

**Row 14 should not move.** `naming.ts` is a versioned agreement with Tin Can and
its copies are hash-checked in CI (`CONTRACT_PROVENANCE.md`). Relocating it would
churn the contract for no gain.

## What is in the table now

`src/agents.ts` holds rows 13 (configuration home), 15 (enforcement) and part of
2 (which runtime options are forwarded, consumed or refused). `Record<Runtime,
AgentCapabilities>` makes a fourth agent a compile error until every column is
filled.

Row 14, the wire name, stays in `naming.ts` on purpose — see the note above, and
because restating it in the table with a test asserting agreement is the pattern
this repo removed from its Tin Can pin.

Rows 9 and 10 stay as explicit dispatch, for the reason below.

Row 6 is a slot in the table, and the reason it qualifies while rows 9 and 10
do not is the INPUTS: trust answers the same question from the same two
arguments for every agent that has it, where readiness needs a socket path for
Claude, a live RPC handle for Codex and a server URL for OpenCode. A uniform
signature is honest for the first and a lie for the second.

Row 11's per-agent part is a slot: only OpenCode has anything to say before
its processes are signalled, because it is a server with work possibly in
flight. Killing the tree afterwards is identical for all three and stayed in
`run.ts`, which is the point — only the differing step moved.

Its implementation lives in `stop/opencode.ts` rather than `opencode-policy.ts`
for a mechanical reason worth remembering: that module imports `guard.ts`,
which imports the table, so a row referencing it would close an import cycle
and leave the slot `undefined` depending on evaluation order.

Row 12 is a slot too, and it was nearly abandoned on a false premise: a refresh
implementation needs `CodexRpc`, which imports `codex-policy.ts`, which looked
like a path back to `guard.ts` and so to the table. It is not — that import is
`import type` and is erased. Worth checking rather than assuming, because the
same shape genuinely does bite in row 11.

**Nothing on this list is scattered any more.** What is left where it is, is
left deliberately: the wire name in `naming.ts`, and rows 9 and 10 as explicit
dispatch because their inputs differ per agent.

## The contract, if these become plugin slots

A slot fixes the **question**, never the **mechanism**. "Is it alive" is a fair
slot; every agent must answer and each answers differently. What must not be
flattened is the **input**: OpenCode needs a server URL and a port-ownership
check, Claude a socket path, Codex a live RPC handle. A uniform signature that
hides that would trade visible branches for an abstraction that lies.
