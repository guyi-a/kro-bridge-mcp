import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { PING_PATH, PING_SIG_HEADER, PING_SIGNATURE } from '../src/protocol.js';

export function httpPing({
  port,
  method = 'GET',
  signature,
  origin,
  path = PING_PATH,
}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (signature !== undefined) headers[PING_SIG_HEADER] = signature;
    if (origin !== undefined) headers.Origin = origin;

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class FakeExtension {
  constructor(ws) {
    this.ws = ws;
    this.sessionId = null;
    this.browserId = null;
    this.label = null;
    this.extensionVersion = null;
    this.helloAck = null;
    this.commands = [];
    this.closeInfo = null;
    this.autoRespond = null;

    this._helloWaiters = [];
    this._commandWaiters = [];
    this._closeWaiters = [];
    this._consumedCommands = new Set();

    ws.on('message', (data) => this._onMessage(data));
    ws.on('close', (code, reason) => this._onClose(code, reason));
    ws.on('error', () => {
      // Tests assert close codes; keep the socket from raising unhandled errors.
    });
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame));
  }

  sendRaw(text) {
    this.ws.send(text);
  }

  sendHello(overrides = {}) {
    this.send({
      type: 'hello',
      id: overrides.id ?? 'hello-1',
      payload: {
        browser_id: overrides.browserId ?? this.browserId,
        browser_label: overrides.browserLabel ?? this.label,
        client: {
          extension_version:
            overrides.extensionVersion ?? this.extensionVersion,
        },
      },
    });
    return this.waitForHelloAck();
  }

  sendPageUpdated(page) {
    this.send({
      type: 'page_updated',
      payload: {
        browser_id: page.browserId ?? this.browserId,
        tab_id: page.tabId,
        window_id: page.windowId,
        url: page.url ?? '',
        title: page.title ?? '',
        active: page.active ?? true,
        context_role: page.contextRole ?? '',
      },
    });
  }

  sendPageClosed(page) {
    this.send({
      type: 'page_closed',
      payload: {
        browser_id: page.browserId ?? this.browserId,
        tab_id: page.tabId,
      },
    });
  }

  sendPageRemoved(page) {
    this.send({
      type: 'page_removed',
      payload: {
        browser_id: page.browserId ?? this.browserId,
        tab_id: page.tabId,
      },
    });
  }

  sendEvent(name, payload = {}) {
    this.send({
      type: 'event',
      payload: { name, ...payload },
    });
  }

  sendResult(id, payload = {}) {
    this.send({ type: 'result', id, payload });
  }

  sendError(id, payload = {}) {
    this.send({ type: 'error', id, payload });
  }

  waitForHelloAck(timeoutMs = 2000) {
    if (this.helloAck) return Promise.resolve(this.helloAck);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for hello_ack'));
      }, timeoutMs);
      timer.unref?.();

      const waiter = (ack) => {
        cleanup();
        resolve(ack);
      };
      const cleanup = () => {
        clearTimeout(timer);
        const index = this._helloWaiters.indexOf(waiter);
        if (index >= 0) this._helloWaiters.splice(index, 1);
      };
      this._helloWaiters.push(waiter);
    });
    return promise;
  }

  waitForCommand(timeoutMs = 2000, predicate = null) {
    const find = () => {
      for (let index = 0; index < this.commands.length; index += 1) {
        if (this._consumedCommands.has(index)) continue;
        if (predicate && !predicate(this.commands[index])) continue;
        this._consumedCommands.add(index);
        return this.commands[index];
      }
      return null;
    };

    const existing = find();
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for command'));
      }, timeoutMs);
      timer.unref?.();

      const waiter = () => {
        const match = find();
        if (!match) return false;
        cleanup();
        resolve(match);
        return true;
      };
      const cleanup = () => {
        clearTimeout(timer);
        const index = this._commandWaiters.indexOf(waiter);
        if (index >= 0) this._commandWaiters.splice(index, 1);
      };
      this._commandWaiters.push(waiter);
    });
  }

  waitForClose(timeoutMs = 2000) {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for close'));
      }, timeoutMs);
      timer.unref?.();

      const waiter = (info) => {
        cleanup();
        resolve(info);
      };
      const cleanup = () => {
        clearTimeout(timer);
        const index = this._closeWaiters.indexOf(waiter);
        if (index >= 0) this._closeWaiters.splice(index, 1);
      };
      this._closeWaiters.push(waiter);
    });
  }

  close(code = 1000, reason = '') {
    this.ws.close(code, reason);
  }

  terminate() {
    this.ws.terminate();
  }

  _onMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (message.type === 'hello_ack') {
      this.helloAck = message;
      this.sessionId = message.session_id ?? null;
      const waiters = this._helloWaiters.splice(0);
      for (const waiter of waiters) waiter(message);
      return;
    }

    if (message.type === 'command') {
      this.commands.push(message);
      for (const waiter of [...this._commandWaiters]) waiter();

      if (this.autoRespond) {
        Promise.resolve(this.autoRespond(message, this))
          .then((response) => {
            if (response === undefined) return;
            if (response && response.error) {
              this.sendError(message.id, response.error);
            } else {
              this.sendResult(message.id, response ?? {});
            }
          })
          .catch(() => {
            // Test callbacks own their errors.
          });
      }
    }
  }

  _onClose(code, reason) {
    this.closeInfo = { code, reason: reason.toString() };
    const waiters = this._closeWaiters.splice(0);
    for (const waiter of waiters) waiter(this.closeInfo);
  }
}

export async function connectFakeExtension({
  port,
  token,
  browserId = randomUUID(),
  label = 'Test Browser',
  extensionVersion = '1.0.0',
  origin = 'chrome-extension://fake-test',
  hello = true,
  autoRespond = null,
}) {
  let resolvedToken = token;
  if (!resolvedToken) {
    const ping = await httpPing({ port, signature: PING_SIGNATURE });
    if (!ping.json?.token) {
      throw new Error(`ping failed: ${ping.status} ${ping.body}`);
    }
    resolvedToken = ping.json.token;
  }

  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/chrome-bridge/ws?token=${encodeURIComponent(resolvedToken)}`,
    { headers: { Origin: origin } },
  );
  await withTimeout(
    once(ws, 'open'),
    2000,
    'timed out opening fake extension websocket',
  );

  const fake = new FakeExtension(ws);
  fake.browserId = browserId;
  fake.label = label;
  fake.extensionVersion = extensionVersion;
  fake.autoRespond = autoRespond;

  if (hello) {
    await fake.sendHello();
  }
  return fake;
}

export async function connectWithBadToken({
  port,
  token = 'wrong-token',
  origin = 'chrome-extension://fake-test',
}) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/chrome-bridge/ws?token=${encodeURIComponent(token)}`,
    { headers: { Origin: origin } },
  );
  ws.on('error', () => {
    // The close code is the assertion; errors are expected for rejected sockets.
  });
  const closed = once(ws, 'close').then(([code, reason]) => ({
    code,
    reason: reason.toString(),
  }));
  return await withTimeout(
    closed,
    3000,
    'timed out waiting for rejected websocket to close',
  );
}
