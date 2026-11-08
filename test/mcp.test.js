import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createBridge } from '../src/bridge.js';
import { ACTIONS, registerBrowserBridgeTool } from '../src/tools.js';

async function waitFor(fn, timeoutMs = 5000, intervalMs = 20) {
  const started = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await delay(intervalMs);
  }
}

async function setup(t) {
  const bridge = createBridge({ port: 0, logger: () => {} });
  await bridge.start();

  const server = new McpServer({
    name: 'kro-bridge-mcp-test',
    version: '0.0.0',
  });
  registerBrowserBridgeTool(server, bridge);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({
    name: 'kro-bridge-mcp-test-client',
    version: '0.0.0',
  });
  await client.connect(clientTransport);

  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    await bridge.stop();
  });

  return { bridge, server, client };
}

describe('MCP server', () => {
  it('lists exactly one browser_bridge tool with all 20 actions', async (t) => {
    const { client } = await setup(t);
    const tools = await client.listTools();

    assert.equal(tools.tools.length, 1);
    const tool = tools.tools[0];
    assert.equal(tool.name, 'browser_bridge');

    const enumValues = tool.inputSchema?.properties?.action?.enum;
    assert.ok(Array.isArray(enumValues));
    assert.equal(enumValues.length, 20);
    assert.deepEqual([...enumValues].sort(), [...ACTIONS].sort());
  });

  it('answers extension_status locally with ready=false', async (t) => {
    const { client } = await setup(t);
    const result = await client.callTool({
      name: 'browser_bridge',
      arguments: { action: 'extension_status' },
    });

    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.status, {
      ready: false,
      sessions_count: 0,
      browser_ids: [],
    });
  });

  it('returns isError for a stale page_id', async (t) => {
    const { client } = await setup(t);
    const result = await client.callTool({
      name: 'browser_bridge',
      arguments: {
        action: 'read_state',
        browser_id: 'missing-browser',
        page_id: 'page_missing',
      },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /page_id/);
  });

  it('starts server.js without writing to stdout and exits cleanly', async (t) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, KRO_BRIDGE_PORT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    t.after(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    });

    await waitFor(
      () =>
        stderr.includes('listening on 127.0.0.1') &&
        stderr.includes('tool browser_bridge registered'),
    );
    assert.equal(stdout, '');
    assert.match(stderr, /tool browser_bridge registered/);

    child.stdin.end();
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });
});
