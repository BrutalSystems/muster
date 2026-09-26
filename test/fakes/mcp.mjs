import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'fixture-tools', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['ping', 'erase'].map(name => ({ name, description: name, inputSchema: { type: 'object' } })) }));
server.setRequestHandler(CallToolRequestSchema, async ({params}) => ({ content: [{type:'text', text: params.name === 'ping' ? 'pong' : 'not used'}] }));
await server.connect(new StdioServerTransport());
