#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridge, resolvePortFromEnv } from './src/bridge.js';
import { registerBrowserBridgeTool } from './src/tools.js';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

function log(message) {
  console.error(message);
}

export async function startServer({ port = resolvePortFromEnv(), logger = log } = {}) {
  const bridge = createBridge({ port, logger });
  await bridge.start();

  try {
    const server = new McpServer({
      name: 'kro-bridge-mcp',
      version: packageJson.version,
    });
    registerBrowserBridgeTool(server, bridge);
    await server.connect(new StdioServerTransport());
    logger('[kro-bridge] MCP stdio connected; tool browser_bridge registered');
    return { bridge, server };
  } catch (error) {
    await bridge.stop().catch(() => {});
    throw error;
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
const isMain = entry !== '' && entry === import.meta.url;

if (isMain) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    console.error(
      `[kro-bridge] Node.js >= 20 is required, current ${process.version}`,
    );
    process.exit(1);
  }

  let handles = null;
  let shuttingDown = false;

  const shutdown = async (exitCode) => {
    if (shuttingDown) return;
    shuttingDown = true;

    const force = setTimeout(() => process.exit(1), 2000);
    force.unref?.();

    try {
      if (handles?.server) await handles.server.close();
      if (handles?.bridge) await handles.bridge.stop();
    } catch (error) {
      console.error(`[kro-bridge] shutdown error: ${error.message}`);
    }

    clearTimeout(force);
    process.exit(exitCode);
  };

  process.on('SIGINT', () => {
    void shutdown(0);
  });
  process.on('SIGTERM', () => {
    void shutdown(0);
  });
  process.stdin.on('end', () => {
    void shutdown(0);
  });
  process.stdin.on('close', () => {
    void shutdown(0);
  });
  process.on('uncaughtException', (error) => {
    console.error(
      `[kro-bridge] uncaught exception: ${error.stack ?? error.message}`,
    );
    void shutdown(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(
      `[kro-bridge] unhandled rejection: ${reason?.stack ?? String(reason)}`,
    );
    void shutdown(1);
  });

  Promise.resolve()
    .then(() => startServer())
    .then((result) => {
      handles = result;
    })
    .catch((error) => {
      console.error(`[kro-bridge] startup failed: ${error.message}`);
      process.exit(1);
    });
}
