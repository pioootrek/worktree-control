// Owned fixture client, not a proxy. Only private IPC carries session identity.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
let client, transport, sessionId;
async function connect() {
  transport = new StreamableHTTPClientTransport(new URL(process.env.MCP_FIXTURE_ENDPOINT), {
    sessionId, requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_FIXTURE_TOKEN}` } },
  });
  client = new Client({ name: 'owned-resource-fixture', version: '1' });
  await client.connect(transport); await client.listTools(); sessionId = transport.sessionId;
}
process.on('message', message => { void (async () => {
  let result;
  if (message.command === 'disconnect') await client.close();
  else if (message.command === 'reconnect') await connect();
  else if (message.command === 'delete') { await transport.terminateSession(); await client.close(); }
  else if (message.command === 'call') result = await client.callTool(message.args);
  else return;
  process.send?.({ id: message.id, result });
})().catch(() => process.send?.({ id: message.id, error: 'Fixture operation failed.' })); });
await connect();
process.send?.({ ready: true, sessionId });
