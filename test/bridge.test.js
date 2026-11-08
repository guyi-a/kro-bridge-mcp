import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createBridge, resolvePortFromEnv } from '../src/bridge.js';
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  PING_SIGNATURE,
} from '../src/protocol.js';
import {
  ACTIONS,
  ToolError,
  capBridgeData,
  capResult,
  dispatchAction,
  handleBrowserBridge,
} from '../src/tools.js';
import {
  connectFakeExtension,
  connectWithBadToken,
  httpPing,
} from './fake-extension.js';

async function startBridge(options = {}) {
  const logs = [];
  const bridge = createBridge({
    port: 0,
    logger: (message) => logs.push(message),
    ...options,
  });
  const { port } = await bridge.start();
  return { bridge, port, logs };
}

async function waitFor(fn, timeoutMs = 2000, intervalMs = 10) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await delay(intervalMs);
  }
}

function makeStubBridge() {
  const sent = [];
  const pages = new Map([
    [
      'b1:p1',
      { pageId: 'p1', browserId: 'b1', tabId: 10, windowId: 2 },
    ],
    [
      'b2:p2',
      { pageId: 'p2', browserId: 'b2', tabId: 20, windowId: 3 },
    ],
  ]);

  return {
    sent,
    extensionStatus: () => ({
      ready: true,
      sessions_count: 1,
      browser_ids: ['b1'],
    }),
    listSessions: () => [
      { browser_id: 'b1', label: 'Edge', last_seen_at: 1 },
    ],
    listPages: (browserId) => [
      { page_id: 'p1', browser_id: browserId },
    ],
    getPage: (browserId, pageId) =>
      pages.get(`${browserId}:${pageId}`) ?? null,
    sendCommand: async (browserId, tool, args) => {
      sent.push({ browserId, tool, args });
      return { tool };
    },
  };
}

async function expectCommand(stub, action, input, tool, expectedArgs) {
  stub.sent.length = 0;
  const result = await dispatchAction(stub, { action, ...input });
  assert.equal(result.ok, true);
  assert.equal(stub.sent.length, 1, `${action} should send one command`);
  assert.equal(stub.sent[0].tool, tool);
  assert.deepEqual(stub.sent[0].args, expectedArgs);
}

describe('protocol constants', () => {
  it('matches the extension hardcoded values', () => {
    assert.equal(
      PING_SIGNATURE,
      '52a6681f244444dd5d603b204b6616ccdb738f6e59e8e53942876030a3c82e99',
    );
    assert.equal(DEFAULT_COMMAND_TIMEOUT_MS, 30000);
    assert.equal(ACTIONS.length, 20);
    assert.equal(new Set(ACTIONS).size, 20);
  });
});

describe('HTTP ping', () => {
  it('serves the exact ping payload for a valid signature', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());

    const response = await httpPing({ port, signature: PING_SIGNATURE });
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.json).sort(), [
      'instanceId',
      'ok',
      'protocolVersion',
      'server',
      'token',
      'wsPath',
    ]);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.server, 'krow-browser-bridge');
    assert.equal(response.json.protocolVersion, '1.0');
    assert.equal(response.json.wsPath, '/chrome-bridge/ws');
    assert.match(response.json.instanceId, /^[0-9a-f-]{36}$/);
    assert.match(response.json.token, /^[0-9a-f-]{36}$/);
  });

  it('rejects a missing or wrong signature with 403', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());

    for (const signature of [undefined, 'wrong']) {
      const response = await httpPing({ port, signature });
      assert.equal(response.status, 403);
      assert.deepEqual(response.json, {
        error: 'invalid client signature',
      });
    }
  });

  it('does not require a signature for HEAD and sends no body', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());

    const response = await httpPing({ port, method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.body, '');
  });

  it('answers OPTIONS with CORS headers for extension origins', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());

    const origin = 'chrome-extension://fake-test';
    const response = await httpPing({
      port,
      method: 'OPTIONS',
      origin,
    });
    assert.equal(response.status, 204);
    assert.equal(
      response.headers['access-control-allow-origin'],
      origin,
    );
    assert.match(
      response.headers['access-control-allow-headers'],
      /X-Kro-Client-Sig/,
    );
  });

  it('keeps instanceId and token stable within one bridge', async (t) => {
    const first = await startBridge();
    t.after(() => first.bridge.stop());
    const second = await startBridge();
    t.after(() => second.bridge.stop());

    const a = await httpPing({
      port: first.port,
      signature: PING_SIGNATURE,
    });
    const b = await httpPing({
      port: first.port,
      signature: PING_SIGNATURE,
    });
    const c = await httpPing({
      port: second.port,
      signature: PING_SIGNATURE,
    });

    assert.equal(a.json.instanceId, b.json.instanceId);
    assert.equal(a.json.token, b.json.token);
    assert.notEqual(a.json.instanceId, c.json.instanceId);
    assert.notEqual(a.json.token, c.json.token);
  });

  it('binds only 127.0.0.1', async (t) => {
    const { bridge } = await startBridge();
    t.after(() => bridge.stop());
    assert.equal(bridge.host, '127.0.0.1');
  });
});

describe('WebSocket authentication and hello', () => {
  it('closes a bad token with 4401 after upgrade', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());

    const close = await connectWithBadToken({ port });
    assert.equal(close.code, 4401);
    assert.equal(close.reason, 'auth failed');
    assert.equal(bridge.extensionStatus().ready, false);
    assert.equal(bridge.listSessions().length, 0);
  });

  it('accepts a valid token, sends hello_ack, and reindexes browser_id', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const browserId = randomUUID();
    const fake = await connectFakeExtension({
      port,
      browserId,
      label: 'Edge',
      extensionVersion: '1.2.3',
    });
    t.after(() => fake.close());

    assert.ok(fake.helloAck);
    assert.deepEqual(Object.keys(fake.helloAck).sort(), [
      'id',
      'payload',
      'session_id',
      'timestamp',
      'type',
    ]);
    assert.equal(fake.helloAck.type, 'hello_ack');
    assert.equal(fake.helloAck.id, 'hello-1');
    assert.equal(fake.helloAck.session_id, fake.sessionId);
    assert.equal(fake.helloAck.payload.browser_id, browserId);
    assert.equal(fake.helloAck.payload.browser_label, 'Edge');
    assert.equal(Number.isInteger(fake.helloAck.timestamp), true);

    const status = bridge.extensionStatus();
    assert.equal(status.ready, true);
    assert.equal(status.sessions_count, 1);
    assert.deepEqual(status.browser_ids, [browserId]);
    assert.deepEqual(status.extension_versions, ['1.2.3']);

    const sessions = bridge.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].browser_id, browserId);
    assert.equal(sessions[0].label, 'Edge');
    assert.equal(Number.isInteger(sessions[0].last_seen_at), true);
    assert.equal(bridge.registry.clientByBrowser(browserId) !== null, true);
  });

  it('uses hello_ack as the default ack id', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const fake = await connectFakeExtension({
      port,
      browserId: randomUUID(),
      hello: false,
    });
    t.after(() => fake.close());

    const ack = await fake.sendHello({ id: '' });
    assert.equal(ack.id, 'hello_ack');
  });

  it('acknowledges hello even without a stable browser_id', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const fake = await connectFakeExtension({
      port,
      browserId: '',
      extensionVersion: '',
      hello: false,
    });
    t.after(() => fake.close());

    const ack = await fake.sendHello();
    assert.match(ack.payload.browser_id, /^[0-9a-f-]{36}$/);
    assert.equal(bridge.extensionStatus().ready, true);
    assert.equal(
      bridge.extensionStatus().extension_versions,
      undefined,
    );
  });
});

describe('page registry', () => {
  it('creates stable page ids and updates the same tab in place', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const browserId = randomUUID();
    const fake = await connectFakeExtension({ port, browserId });
    t.after(() => fake.close());

    fake.sendPageUpdated({
      tabId: 10,
      windowId: 1,
      url: 'https://example.com/',
      title: 'Example',
      active: true,
    });

    const [page] = await waitFor(() => {
      const pages = bridge.listPages(browserId);
      return pages.length === 1 ? pages : null;
    });
    assert.match(page.page_id, /^page_[0-9a-f]{8}$/);
    assert.equal(page.browser_id, browserId);
    assert.equal(page.window_id, 1);
    assert.equal(page.tab_id, 10);
    assert.equal(page.url, 'https://example.com/');
    assert.equal(page.title, 'Example');
    assert.equal(page.active, true);
    assert.equal(page.controllable, true);
    assert.equal(Number.isInteger(page.last_seen_at), true);

    fake.sendPageUpdated({
      tabId: 10,
      windowId: 1,
      url: 'https://example.com/next',
      title: 'Next',
      active: false,
    });
    const updated = await waitFor(() => {
      const pages = bridge.listPages(browserId);
      return pages.length === 1 && pages[0].title === 'Next'
        ? pages[0]
        : null;
    });
    assert.equal(updated.page_id, page.page_id);
    assert.equal(updated.url, 'https://example.com/next');
    assert.equal(updated.active, false);

    assert.equal(bridge.listPages('another-browser').length, 0);
  });

  it('accepts event-wrapped page updates and removes closed pages', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const browserId = randomUUID();
    const fake = await connectFakeExtension({ port, browserId });
    t.after(() => fake.close());

    fake.sendEvent('page_updated', {
      browser_id: browserId,
      tab_id: 11,
      window_id: 2,
      url: 'https://example.org/',
      title: 'Event Page',
      active: true,
      context_role: 'test',
    });

    const [page] = await waitFor(() => {
      const pages = bridge.listPages(browserId);
      return pages.length === 1 ? pages : null;
    });
    assert.equal(page.tab_id, 11);
    assert.equal(page.context_role, 'test');

    fake.sendPageClosed({ tabId: 11 });
    await waitFor(() => bridge.listPages(browserId).length === 0);

    fake.sendEvent('page_updated', {
      browser_id: browserId,
      tab_id: 12,
      window_id: 2,
      url: 'https://example.net/',
      title: 'Removed Page',
      active: true,
    });
    await waitFor(() => bridge.listPages(browserId).length === 1);

    fake.sendEvent('page_removed', {
      browser_id: browserId,
      tab_id: 12,
    });
    await waitFor(() => bridge.listPages(browserId).length === 0);

    fake.sendPageUpdated({
      tabId: 13,
      windowId: 2,
      url: 'https://example.dev/',
      title: 'Direct Remove',
      active: true,
    });
    await waitFor(() => bridge.listPages(browserId).length === 1);
    fake.sendPageRemoved({ tabId: 13 });
    await waitFor(() => bridge.listPages(browserId).length === 0);
  });

  it('isolates pages by browser_id', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const browserA = randomUUID();
    const browserB = randomUUID();
    const fakeA = await connectFakeExtension({ port, browserId: browserA });
    const fakeB = await connectFakeExtension({ port, browserId: browserB });
    t.after(() => fakeA.close());
    t.after(() => fakeB.close());

    fakeA.sendPageUpdated({
      tabId: 1,
      windowId: 1,
      url: 'https://a.example/',
      title: 'A',
      active: true,
    });
    fakeB.sendPageUpdated({
      tabId: 2,
      windowId: 2,
      url: 'https://b.example/',
      title: 'B',
      active: true,
    });

    await waitFor(() => bridge.listPages(browserA).length === 1);
    await waitFor(() => bridge.listPages(browserB).length === 1);
    assert.equal(bridge.listPages(browserA)[0].browser_id, browserA);
    assert.equal(bridge.listPages(browserB)[0].browser_id, browserB);
  });

  it('prunes a disconnecting browser and its pages', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const browserId = randomUUID();
    const fake = await connectFakeExtension({ port, browserId });

    fake.sendPageUpdated({
      tabId: 1,
      windowId: 1,
      url: 'https://example.com/',
      title: 'Example',
      active: true,
    });
    await waitFor(() => bridge.listPages(browserId).length === 1);

    fake.close();
    await waitFor(() => bridge.listPages(browserId).length === 0);
    await waitFor(() => bridge.extensionStatus().ready === false);
    assert.equal(bridge.registry.clientByBrowser(browserId), null);
  });

  it('does not let a stale close erase a newer connection', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const browserId = randomUUID();
    const fakeA = await connectFakeExtension({ port, browserId });
    const fakeB = await connectFakeExtension({ port, browserId });
    t.after(() => fakeB.close());

    fakeA.sendPageUpdated({
      tabId: 1,
      windowId: 1,
      url: 'https://a.example/',
      title: 'A',
      active: true,
    });
    fakeB.sendPageUpdated({
      tabId: 2,
      windowId: 2,
      url: 'https://b.example/',
      title: 'B',
      active: true,
    });
    await waitFor(() => bridge.listPages(browserId).length === 2);

    fakeA.close();
    await delay(50);
    assert.equal(
      bridge.registry.clientByBrowser(browserId).sessionId,
      fakeB.sessionId,
    );
    assert.equal(
      bridge.listPages(browserId).some((page) => page.tab_id === 2),
      true,
    );
  });
});

describe('command transport', () => {
  it('sends the exact command envelope and resolves by id', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const fake = await connectFakeExtension({ port });
    t.after(() => fake.close());

    const promise = bridge.sendCommand(
      fake.browserId,
      'browser_read_state',
      {
        browser_id: fake.browserId,
        page_id: 'page_test',
        tab_id: 10,
        task_id: '',
      },
    );
    const command = await fake.waitForCommand();

    assert.deepEqual(Object.keys(command).sort(), [
      'id',
      'payload',
      'session_id',
      'timestamp',
      'type',
    ]);
    assert.equal(command.type, 'command');
    assert.match(command.id, /^[0-9a-f-]{36}$/);
    assert.equal(command.session_id, fake.sessionId);
    assert.equal(Number.isInteger(command.timestamp), true);
    assert.deepEqual(Object.keys(command.payload).sort(), [
      'arguments',
      'tool',
    ]);
    assert.equal(command.payload.tool, 'browser_read_state');
    assert.deepEqual(command.payload.arguments, {
      browser_id: fake.browserId,
      page_id: 'page_test',
      tab_id: 10,
      task_id: '',
    });

    fake.sendResult(command.id, { value: 'ok' });
    assert.deepEqual(await promise, { value: 'ok' });
    assert.equal(bridge.pendingCount, 0);
  });

  it('rejects when the extension returns an error frame', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const fake = await connectFakeExtension({ port });
    t.after(() => fake.close());

    const withCode = bridge.sendCommand(fake.browserId, 'browser_click', {});
    const first = await fake.waitForCommand();
    fake.sendError(first.id, { code: 'E_BAD', message: 'nope' });
    await assert.rejects(withCode, (error) => {
      assert.equal(error.code, 'EXTENSION_ERROR');
      assert.equal(error.message, 'E_BAD: nope');
      return true;
    });

    const plain = bridge.sendCommand(fake.browserId, 'browser_click', {});
    const second = await fake.waitForCommand();
    fake.sendError(second.id, { message: 'plain failure' });
    await assert.rejects(plain, (error) => {
      assert.equal(error.message, 'plain failure');
      return true;
    });
  });

  it('correlates out-of-order results', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const fake = await connectFakeExtension({ port });
    t.after(() => fake.close());

    const firstPromise = bridge.sendCommand(fake.browserId, 'tool_a', {
      n: 1,
    });
    const secondPromise = bridge.sendCommand(fake.browserId, 'tool_b', {
      n: 2,
    });
    const first = await fake.waitForCommand(
      2000,
      (command) => command.payload.tool === 'tool_a',
    );
    const second = await fake.waitForCommand(
      2000,
      (command) => command.payload.tool === 'tool_b',
    );

    fake.sendResult(second.id, { n: 2 });
    fake.sendResult(first.id, { n: 1 });

    assert.deepEqual(await firstPromise, { n: 1 });
    assert.deepEqual(await secondPromise, { n: 2 });
  });

  it('ignores unknown and late result ids', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const fake = await connectFakeExtension({ port });
    t.after(() => fake.close());

    fake.sendResult('unknown-id', { ignored: true });

    const promise = bridge.sendCommand(fake.browserId, 'tool', {});
    const command = await fake.waitForCommand();
    fake.sendResult(command.id, { first: true });
    assert.deepEqual(await promise, { first: true });

    fake.sendResult(command.id, { late: true });
    await delay(20);

    const next = bridge.sendCommand(fake.browserId, 'tool2', {});
    const nextCommand = await fake.waitForCommand();
    fake.sendResult(nextCommand.id, { second: true });
    assert.deepEqual(await next, { second: true });
  });

  it('times out and clears pending state', async (t) => {
    const { bridge, port } = await startBridge({ commandTimeoutMs: 100 });
    t.after(() => bridge.stop());
    const fake = await connectFakeExtension({ port });
    t.after(() => fake.close());

    const promise = bridge.sendCommand(fake.browserId, 'browser_slow', {});
    const command = await fake.waitForCommand();
    await assert.rejects(promise, (error) => {
      assert.equal(error.code, 'COMMAND_TIMEOUT');
      assert.match(error.message, /timed out after 100 ms/);
      return true;
    });
    assert.equal(bridge.pendingCount, 0);

    fake.sendResult(command.id, { late: true });
    await delay(20);

    const next = bridge.sendCommand(fake.browserId, 'browser_fast', {});
    const nextCommand = await fake.waitForCommand();
    fake.sendResult(nextCommand.id, { ok: true });
    assert.deepEqual(await next, { ok: true });
  });

  it('rejects pending commands immediately on disconnect', async (t) => {
    const { bridge, port } = await startBridge({ commandTimeoutMs: 5000 });
    t.after(() => bridge.stop());
    const fake = await connectFakeExtension({ port });

    const first = bridge.sendCommand(fake.browserId, 'tool_a', {});
    const second = bridge.sendCommand(fake.browserId, 'tool_b', {});
    await fake.waitForCommand();
    await fake.waitForCommand();

    const started = Date.now();
    fake.close();
    await assert.rejects(first, (error) => error.code === 'DISCONNECTED');
    await assert.rejects(second, (error) => error.code === 'DISCONNECTED');
    assert.ok(Date.now() - started < 1000);
    assert.equal(bridge.pendingCount, 0);
  });

  it('rejects all pending commands when any connection drops', async (t) => {
    const { bridge, port } = await startBridge({ commandTimeoutMs: 5000 });
    t.after(() => bridge.stop());
    const fakeA = await connectFakeExtension({ port });
    const fakeB = await connectFakeExtension({ port });
    t.after(() => fakeB.close());

    const first = bridge.sendCommand(fakeA.browserId, 'tool_a', {});
    const second = bridge.sendCommand(fakeB.browserId, 'tool_b', {});
    await fakeA.waitForCommand();
    await fakeB.waitForCommand();

    fakeA.close();
    await assert.rejects(first, (error) => error.code === 'DISCONNECTED');
    await assert.rejects(second, (error) => error.code === 'DISCONNECTED');
  });

  it('rejects an unknown browser_id', async (t) => {
    const { bridge } = await startBridge();
    t.after(() => bridge.stop());
    await assert.rejects(
      bridge.sendCommand('missing-browser', 'tool', {}),
      (error) => {
        assert.equal(error.code, 'BROWSER_NOT_CONNECTED');
        assert.match(error.message, /not connected/);
        return true;
      },
    );
  });

  it('preserves ordering for concurrent burst writes', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const fake = await connectFakeExtension({
      port,
      autoRespond: (command) => ({ echo: command.payload.tool }),
    });
    t.after(() => fake.close());

    const tools = Array.from({ length: 8 }, (_, index) => `tool_${index}`);
    const results = await Promise.all(
      tools.map((tool, index) =>
        bridge.sendCommand(fake.browserId, tool, { index }),
      ),
    );

    assert.equal(fake.commands.length, 8);
    assert.deepEqual(
      fake.commands.map((command) => command.payload.tool),
      tools,
    );
    assert.deepEqual(
      results.map((result) => result.echo),
      tools,
    );
  });

  it('survives malformed frames and ping heartbeats', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const fake = await connectFakeExtension({ port });
    t.after(() => fake.close());

    fake.sendRaw('not json');
    fake.sendRaw(JSON.stringify({ type: 'ping' }));
    fake.sendRaw(JSON.stringify({ type: 'unknown' }));

    const promise = bridge.sendCommand(fake.browserId, 'tool', {});
    const command = await fake.waitForCommand();
    fake.sendResult(command.id, { ok: true });
    assert.deepEqual(await promise, { ok: true });
  });
});

describe('port handling', () => {
  it('parses KRO_BRIDGE_PORT', () => {
    assert.equal(resolvePortFromEnv({}), 17323);
    assert.equal(resolvePortFromEnv({ KRO_BRIDGE_PORT: '0' }), 0);
    assert.equal(resolvePortFromEnv({ KRO_BRIDGE_PORT: '17323' }), 17323);
    assert.throws(
      () => resolvePortFromEnv({ KRO_BRIDGE_PORT: 'abc' }),
      (error) => error.code === 'INVALID_ARGUMENT',
    );
  });

  it('reports a clear error when the port is occupied', async (t) => {
    const blocker = createServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => blocker.close(resolve)));
    const port = blocker.address().port;

    const bridge = createBridge({ port });
    await assert.rejects(bridge.start(), (error) => {
      assert.equal(error.code, 'PORT_IN_USE');
      assert.match(error.message, /bridge server/);
      assert.match(error.message, new RegExp(String(port)));
      return true;
    });
    await bridge.stop();
  });
});

describe('action mapping', () => {
  it('maps all 20 actions to the correct extension tool and arguments', async () => {
    const stub = makeStubBridge();
    const base = { browser_id: 'b1', page_id: 'p1' };
    const pageArgs = {
      browser_id: 'b1',
      page_id: 'p1',
      tab_id: 10,
    };

    const cases = [
      [
        'open_tab',
        { browser_id: 'b1', url: 'https://example.com' },
        'browser_open_tab',
        {
          browser_id: 'b1',
          url: 'https://example.com',
          active: true,
        },
      ],
      [
        'open_tab',
        { browser_id: 'b1', url: 'https://example.com', active: false },
        'browser_open_tab',
        {
          browser_id: 'b1',
          url: 'https://example.com',
          active: false,
        },
      ],
      [
        'focus_page',
        base,
        'browser_focus_page',
        { ...pageArgs, window_id: 2 },
      ],
      ['close_tab', base, 'browser_close_tab', pageArgs],
      [
        'read_state',
        base,
        'browser_read_state',
        { ...pageArgs, task_id: '' },
      ],
      [
        'click',
        { ...base, index: 3 },
        'browser_click',
        { ...pageArgs, index: 3, variant: 'click' },
      ],
      [
        'hover',
        { ...base, index: 3 },
        'browser_click',
        { ...pageArgs, index: 3, variant: 'hover' },
      ],
      [
        'dblclick',
        { ...base, index: 3 },
        'browser_click',
        { ...pageArgs, index: 3, variant: 'dblclick' },
      ],
      [
        'rightclick',
        { ...base, index: 3 },
        'browser_click',
        { ...pageArgs, index: 3, variant: 'rightclick' },
      ],
      [
        'type',
        { ...base, index: 3, text: 'hello' },
        'browser_type',
        { ...pageArgs, index: 3, text: 'hello' },
      ],
      [
        'press',
        { ...base, key: 'Enter' },
        'browser_press',
        { ...pageArgs, key: 'Enter' },
      ],
      [
        'press',
        { ...base, key: 'Enter', index: 0 },
        'browser_press',
        { ...pageArgs, key: 'Enter' },
      ],
      [
        'press',
        { ...base, key: 'Enter', index: 4 },
        'browser_press',
        { ...pageArgs, key: 'Enter', index: 4 },
      ],
      [
        'scroll',
        { ...base, x: -10, y: 20 },
        'browser_scroll',
        { ...pageArgs, x: -10, y: 20 },
      ],
      [
        'scroll',
        { ...base, x: 0, y: 0, index: 5 },
        'browser_scroll',
        { ...pageArgs, x: 0, y: 0, index: 5 },
      ],
      [
        'wait_for',
        base,
        'browser_wait_for',
        { ...pageArgs, timeout_ms: 10000 },
      ],
      [
        'wait_for',
        { ...base, timeout_ms: 250 },
        'browser_wait_for',
        { ...pageArgs, timeout_ms: 250 },
      ],
      ['go_back', base, 'browser_go_back', pageArgs],
      ['reload', base, 'browser_reload', pageArgs],
      [
        'extract',
        { ...base, index: 2 },
        'browser_extract',
        { ...pageArgs, index: 2, include_html: false },
      ],
      [
        'extract',
        { ...base, index: 2, include_html: true },
        'browser_extract',
        { ...pageArgs, index: 2, include_html: true },
      ],
      [
        'describe_element',
        { ...base, index: 2 },
        'browser_describe_element',
        { ...pageArgs, index: 2 },
      ],
      [
        'execute_script',
        { ...base, script: '(function(){\nreturn document.title;\n})()' },
        'browser_execute_script',
        {
          ...pageArgs,
          script: '(function(){\nreturn document.title;\n})()',
        },
      ],
    ];

    for (const [action, input, tool, expectedArgs] of cases) {
      await expectCommand(stub, action, input, tool, expectedArgs);
    }
  });

  it('answers local actions without sending commands', async () => {
    const stub = makeStubBridge();

    assert.deepEqual(await dispatchAction(stub, { action: 'extension_status' }), {
      ok: true,
      status: {
        ready: true,
        sessions_count: 1,
        browser_ids: ['b1'],
      },
    });
    assert.deepEqual(await dispatchAction(stub, { action: 'list_sessions' }), {
      ok: true,
      sessions: [{ browser_id: 'b1', label: 'Edge', last_seen_at: 1 }],
    });
    assert.deepEqual(
      await dispatchAction(stub, { action: 'list_pages', browser_id: 'b1' }),
      {
        ok: true,
        pages: [{ page_id: 'p1', browser_id: 'b1' }],
      },
    );
    assert.equal(stub.sent.length, 0);
  });

  it('rejects invalid inputs without sending a command', async () => {
    const stub = makeStubBridge();
    const cases = [
      [{ action: 'unknown' }, /unknown action/],
      [{ action: 'list_pages' }, /browser_id/],
      [{ action: 'read_state', browser_id: 'b1' }, /page_id/],
      [
        { action: 'click', browser_id: 'b1', page_id: 'p1' },
        /index/,
      ],
      [
        { action: 'click', browser_id: 'b1', page_id: 'p1', index: 0 },
        /index/,
      ],
      [
        {
          action: 'type',
          browser_id: 'b1',
          page_id: 'p1',
          index: 1,
        },
        /text/,
      ],
      [
        {
          action: 'type',
          browser_id: 'b1',
          page_id: 'p1',
          index: 1,
          text: '',
        },
        /text/,
      ],
      [
        { action: 'press', browser_id: 'b1', page_id: 'p1' },
        /key/,
      ],
      [
        { action: 'extract', browser_id: 'b1', page_id: 'p1' },
        /index/,
      ],
      [
        {
          action: 'execute_script',
          browser_id: 'b1',
          page_id: 'p1',
        },
        /script/,
      ],
      [
        {
          action: 'read_state',
          browser_id: 'b1',
          page_id: 'missing',
        },
        /page_id/,
      ],
      [{ action: 'open_tab', browser_id: 'b1' }, /url/],
    ];

    for (const [input, pattern] of cases) {
      stub.sent.length = 0;
      await assert.rejects(dispatchAction(stub, input), (error) => {
        assert.ok(error instanceof ToolError);
        assert.match(error.message, pattern);
        return true;
      });
      assert.equal(
        stub.sent.length,
        0,
        `no command should be sent for ${input.action}`,
      );
    }
  });

  it('does not retry a stale page_id', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const fake = await connectFakeExtension({ port });
    t.after(() => fake.close());

    await assert.rejects(
      dispatchAction(bridge, {
        action: 'read_state',
        browser_id: fake.browserId,
        page_id: 'page_missing',
      }),
      (error) => {
        assert.ok(error instanceof ToolError);
        assert.equal(error.code, 'PAGE_NOT_FOUND');
        return true;
      },
    );
    await delay(30);
    assert.equal(fake.commands.length, 0);
  });
});

describe('result capping', () => {
  it('caps oversized payloads with the reference stub shape', () => {
    const big = { text: 'x'.repeat(40000) };
    const capped = capBridgeData(big, 'extract');
    assert.equal(capped.truncated, true);
    assert.equal(capped.action, 'extract');
    assert.ok(capped.original_size_bytes > 32768);
    assert.ok(capped.kept_size_bytes <= 32256);
    assert.equal(typeof capped.preview_json, 'string');
    assert.match(capped.note, /32768/);
  });

  it('does not split UTF-8 characters', () => {
    for (const text of ['中'.repeat(20000), '😀'.repeat(10000)]) {
      const capped = capBridgeData({ text }, 'extract');
      assert.ok(Buffer.byteLength(capped.preview_json) <= 32256);
      assert.equal(capped.preview_json.includes('�'), false);
    }
  });

  it('leaves small payloads unchanged', () => {
    assert.deepEqual(capBridgeData({ a: 1 }, 'x'), { a: 1 });
  });

  it('keeps the final result JSON under 32 KiB', () => {
    const big = { text: 'x'.repeat(40000) };
    const cappedResult = capResult({ ok: true, data: big }, 'read_state');
    assert.ok(Buffer.byteLength(JSON.stringify(cappedResult)) <= 32768);
    assert.equal(cappedResult.data.truncated, true);

    const pages = {
      ok: true,
      pages: Array.from({ length: 5000 }, (_, index) => ({
        page_id: `page_${index}`,
        title: 'x'.repeat(50),
      })),
    };
    const cappedPages = capResult(pages, 'list_pages');
    assert.ok(Buffer.byteLength(JSON.stringify(cappedPages)) <= 32768);
    assert.equal(cappedPages.truncated, true);
  });

  it('caps an oversized extension payload end-to-end', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const fake = await connectFakeExtension({
      port,
      autoRespond: () => ({ text: 'x'.repeat(40000) }),
    });
    t.after(() => fake.close());

    const result = await handleBrowserBridge(bridge, {
      action: 'open_tab',
      browser_id: fake.browserId,
      url: 'https://example.com',
    });
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.ok(Buffer.byteLength(text) <= 32768);
    const parsed = JSON.parse(text);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.truncated, true);
  });
});

describe('end-to-end tool call', () => {
  it('reads page state through the tool, bridge, and fake extension', async (t) => {
    const { bridge, port } = await startBridge();
    t.after(() => bridge.stop());
    const fake = await connectFakeExtension({ port });
    t.after(() => fake.close());

    fake.sendPageUpdated({
      tabId: 10,
      windowId: 1,
      url: 'https://example.com/',
      title: 'Example',
      active: true,
    });
    const [page] = await waitFor(() => {
      const pages = bridge.listPages(fake.browserId);
      return pages.length === 1 ? pages : null;
    });

    const call = handleBrowserBridge(bridge, {
      action: 'read_state',
      browser_id: fake.browserId,
      page_id: page.page_id,
    });
    const command = await fake.waitForCommand();
    assert.equal(command.payload.tool, 'browser_read_state');
    assert.deepEqual(command.payload.arguments, {
      browser_id: fake.browserId,
      page_id: page.page_id,
      tab_id: 10,
      task_id: '',
    });
    fake.sendResult(command.id, { value: 'ok' });

    const result = await call;
    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.data, { value: 'ok' });
  });
});

describe('stdout hygiene', () => {
  it('never calls console.log or writes to stdout in source files', () => {
    for (const file of [
      'server.js',
      'src/protocol.js',
      'src/bridge.js',
      'src/tools.js',
    ]) {
      const source = readFileSync(
        new URL(`../${file}`, import.meta.url),
        'utf8',
      );
      assert.doesNotMatch(
        source,
        /console\.log\s*\(/,
        `${file} must not write to stdout`,
      );
      assert.doesNotMatch(
        source,
        /process\.stdout\.write/,
        `${file} must not write to stdout`,
      );
    }
  });
});
