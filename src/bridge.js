import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  PING_PATH,
  PING_SIG_HEADER,
  PING_SIGNATURE,
  WS_CLOSE_AUTH_FAILED,
  WS_PATH,
  buildCommandFrame,
  buildHelloAck,
  buildPingPayload,
  extensionErrorDetail,
  framePayload,
  newPageId,
  normalizeFrameType,
  nowMs,
  parseFrame,
} from './protocol.js';

export const ErrorCodes = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  BROWSER_NOT_CONNECTED: 'BROWSER_NOT_CONNECTED',
  PAGE_NOT_FOUND: 'PAGE_NOT_FOUND',
  COMMAND_TIMEOUT: 'COMMAND_TIMEOUT',
  EXTENSION_ERROR: 'EXTENSION_ERROR',
  DISCONNECTED: 'DISCONNECTED',
  SHUTDOWN: 'SHUTDOWN',
  PORT_IN_USE: 'PORT_IN_USE',
});

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

const CORS_ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || origin === '') return false;
  return (
    CORS_ALLOWED_ORIGINS.has(origin) ||
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('edge-extension://')
  );
}

function prefix(value) {
  return typeof value === 'string' ? value.slice(0, 8) : '';
}

function toInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function pageToJson(page) {
  const out = {
    page_id: page.pageId,
    browser_id: page.browserId,
    window_id: page.windowId,
    tab_id: page.tabId,
    url: page.url,
    title: page.title,
    active: page.active,
    controllable: page.controllable,
    last_seen_at: page.lastSeenAt,
  };
  if (page.contextRole) out.context_role = page.contextRole;
  return out;
}

export function resolvePortFromEnv(env = process.env) {
  const raw = env.KRO_BRIDGE_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new BridgeError(
      ErrorCodes.INVALID_ARGUMENT,
      `KRO_BRIDGE_PORT must be an integer between 0 and 65535, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

export class Registry {
  constructor() {
    this.instanceId = randomUUID();
    this.token = randomUUID();
    this.clientsBySession = new Map();
    this.clientsByBrowser = new Map();
    this.pages = new Map();
    this.pageKey = new Map();
  }

  pingPayload() {
    return buildPingPayload({
      instanceId: this.instanceId,
      token: this.token,
    });
  }

  registerClient(label = 'Chrome Extension') {
    const client = {
      sessionId: randomUUID(),
      browserId: randomUUID(),
      label,
      extensionVersion: '',
      ws: null,
      connectedAt: nowMs(),
      lastSeenAt: nowMs(),
      closed: false,
    };
    this.clientsBySession.set(client.sessionId, client);
    this.clientsByBrowser.set(client.browserId, client);
    return client;
  }

  unregisterClient(sessionId) {
    const client = this.clientsBySession.get(sessionId);
    if (!client) return null;

    this.clientsBySession.delete(sessionId);
    if (this.clientsByBrowser.get(client.browserId) === client) {
      this.clientsByBrowser.delete(client.browserId);
    }

    // If another live connection already owns this stable browser id, keep
    // its pages. This guards against a late close from a replaced socket.
    const stillOwned = [...this.clientsBySession.values()].some(
      (candidate) => candidate.browserId === client.browserId,
    );
    if (!stillOwned) {
      for (const [pageId, page] of this.pages) {
        if (page.browserId !== client.browserId) continue;
        this.pages.delete(pageId);
        this.pageKey.delete(this._pageKey(page.browserId, page.tabId));
      }
    }
    return client;
  }

  setBrowserId(sessionId, browserId, label, extensionVersion) {
    const client = this.clientsBySession.get(sessionId);
    if (!client) return null;

    if (this.clientsByBrowser.get(client.browserId) === client) {
      this.clientsByBrowser.delete(client.browserId);
    }
    client.browserId = browserId;
    if (label) client.label = label;
    if (extensionVersion) client.extensionVersion = extensionVersion;
    client.lastSeenAt = nowMs();
    this.clientsByBrowser.set(browserId, client);
    return client;
  }

  clientByBrowser(browserId) {
    return this.clientsByBrowser.get(browserId) ?? null;
  }

  listSessions() {
    return [...this.clientsBySession.values()].map((client) => ({
      browser_id: client.browserId,
      label: client.label,
      last_seen_at: client.lastSeenAt,
    }));
  }

  extensionVersions() {
    return [...this.clientsBySession.values()]
      .map((client) => client.extensionVersion)
      .filter(Boolean);
  }

  _pageKey(browserId, tabId) {
    return `${browserId}\u0000${tabId}`;
  }

  upsertPage(browserId, windowId, tabId, url, title, active, contextRole) {
    const key = this._pageKey(browserId, tabId);
    const existingId = this.pageKey.get(key);
    if (existingId) {
      const existing = this.pages.get(existingId);
      if (existing) {
        existing.windowId = windowId;
        existing.url = url;
        existing.title = title;
        existing.active = active;
        existing.contextRole = contextRole;
        existing.lastSeenAt = nowMs();
        return { ...existing };
      }
    }

    let pageId = newPageId();
    while (this.pages.has(pageId)) pageId = newPageId();

    const page = {
      pageId,
      browserId,
      windowId,
      tabId,
      url,
      title,
      active,
      controllable: true,
      contextRole,
      lastSeenAt: nowMs(),
    };
    this.pages.set(pageId, page);
    this.pageKey.set(key, pageId);
    return { ...page };
  }

  removePage(browserId, tabId) {
    const key = this._pageKey(browserId, tabId);
    const pageId = this.pageKey.get(key);
    if (!pageId) return false;
    this.pageKey.delete(key);
    this.pages.delete(pageId);
    return true;
  }

  getPage(browserId, pageId) {
    const page = this.pages.get(pageId);
    if (!page || page.browserId !== browserId) return null;
    return { ...page };
  }

  listPages(browserId) {
    const out = [];
    for (const page of this.pages.values()) {
      if (page.browserId === browserId) out.push({ ...page });
    }
    return out;
  }
}

export class Bridge {
  constructor({
    port = DEFAULT_PORT,
    host = DEFAULT_HOST,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    logger = (message) => console.error(message),
  } = {}) {
    if (host !== DEFAULT_HOST) {
      throw new BridgeError(
        ErrorCodes.INVALID_ARGUMENT,
        `bridge must bind to ${DEFAULT_HOST}, refusing host ${host}`,
      );
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new BridgeError(
        ErrorCodes.INVALID_ARGUMENT,
        `port must be an integer between 0 and 65535, got ${port}`,
      );
    }
    if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs <= 0) {
      throw new BridgeError(
        ErrorCodes.INVALID_ARGUMENT,
        `commandTimeoutMs must be a positive integer, got ${commandTimeoutMs}`,
      );
    }

    this.host = host;
    this.port = port;
    this.commandTimeoutMs = commandTimeoutMs;
    this.logger = logger;
    this.registry = new Registry();
    this.httpServer = null;
    this.wss = null;
    this.connections = new Map();
    this.pending = new Map();
    this.started = false;
    this.closing = false;
  }

  get pendingCount() {
    return this.pending.size;
  }

  async start() {
    if (this.started) return { host: this.host, port: this.port };
    if (this.closing) {
      throw new BridgeError(ErrorCodes.SHUTDOWN, 'bridge is shutting down');
    }

    const server = http.createServer((req, res) => this._handleHttp(req, res));
    const wss = new WebSocketServer({ noServer: true });
    this.httpServer = server;
    this.wss = wss;

    server.on('upgrade', (req, socket, head) => {
      this._handleUpgrade(req, socket, head);
    });
    wss.on('error', (error) => {
      this.logger(`[kro-bridge] websocket server error: ${error.message}`);
    });

    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
            reject(
              new BridgeError(
                ErrorCodes.PORT_IN_USE,
                `Cannot listen on ${this.host}:${this.port} (${error.code}). ` +
                  'Another bridge server may already own 17323, and only one kro-bridge-mcp instance may run. ' +
                  'Stop the other process or choose another port with KRO_BRIDGE_PORT. ' +
                  'Check: netstat -ano | findstr :17323',
              ),
            );
            return;
          }
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.port, this.host);
      });
    } catch (error) {
      try {
        wss.close();
      } catch {
        // ignore
      }
      this.httpServer = null;
      this.wss = null;
      throw error;
    }

    this.port = server.address().port;
    this.started = true;
    server.on('error', (error) => {
      this.logger(`[kro-bridge] http server error: ${error.message}`);
    });
    this.logger(`[kro-bridge] listening on ${this.host}:${this.port}`);
    return { host: this.host, port: this.port };
  }

  async stop() {
    if (this.closing) return;
    this.closing = true;

    this._rejectAllPending(
      new BridgeError(ErrorCodes.SHUTDOWN, 'browser bridge is shutting down'),
    );

    for (const { ws } of this.connections.values()) {
      try {
        ws.close(1001, 'server shutting down');
      } catch {
        // ignore
      }
    }
    this.connections.clear();

    const server = this.httpServer;
    this.httpServer = null;
    const wss = this.wss;
    this.wss = null;

    if (server) {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        try {
          server.closeAllConnections?.();
        } catch {
          // ignore
        }
        server.close(done);
        setTimeout(done, 1000).unref?.();
      });
    }

    if (wss) {
      try {
        wss.close();
      } catch {
        // ignore
      }
    }

    this.started = false;
  }

  extensionStatus() {
    const sessions = this.registry.listSessions();
    const status = {
      ready: sessions.length > 0,
      sessions_count: sessions.length,
      browser_ids: sessions.map((session) => session.browser_id),
    };
    const versions = this.registry.extensionVersions();
    if (versions.length > 0) status.extension_versions = versions;
    return status;
  }

  listSessions() {
    return this.registry.listSessions();
  }

  listPages(browserId) {
    return this.registry.listPages(browserId).map(pageToJson);
  }

  getPage(browserId, pageId) {
    return this.registry.getPage(browserId, pageId);
  }

  async sendCommand(browserId, tool, args, { timeoutMs = this.commandTimeoutMs, signal } = {}) {
    if (typeof browserId !== 'string' || browserId === '') {
      throw new BridgeError(ErrorCodes.INVALID_ARGUMENT, 'browser_id is required');
    }
    if (typeof tool !== 'string' || tool === '') {
      throw new BridgeError(ErrorCodes.INVALID_ARGUMENT, 'tool is required');
    }

    const client = this.registry.clientByBrowser(browserId);
    if (!client) {
      throw new BridgeError(
        ErrorCodes.BROWSER_NOT_CONNECTED,
        `browser_id ${browserId} is not connected; call extension_status and list_sessions again`,
      );
    }

    const connection = this.connections.get(client.sessionId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      throw new BridgeError(
        ErrorCodes.DISCONNECTED,
        'browser websocket is not available; call extension_status again',
      );
    }

    const id = randomUUID();
    const frame = buildCommandFrame({
      id,
      sessionId: client.sessionId,
      tool,
      args,
    });

    return await new Promise((resolve, reject) => {
      const entry = {
        id,
        resolve,
        reject,
        timer: null,
        sessionId: client.sessionId,
        tool,
        settled: false,
        abortCleanup: null,
      };

      const settle = (error, payload) => this._settle(entry, error, payload);

      entry.timer = setTimeout(() => {
        settle(
          new BridgeError(
            ErrorCodes.COMMAND_TIMEOUT,
            `browser bridge command ${tool} timed out after ${timeoutMs} ms`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, entry);

      if (signal) {
        if (signal.aborted) {
          settle(new BridgeError(ErrorCodes.INVALID_ARGUMENT, 'command aborted'));
          return;
        }
        const onAbort = () => {
          settle(new BridgeError(ErrorCodes.INVALID_ARGUMENT, 'command aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.abortCleanup = () => signal.removeEventListener('abort', onAbort);
      }

      this._sendFrame(client, frame).catch((error) => {
        settle(
          new BridgeError(
            ErrorCodes.DISCONNECTED,
            `send command failed: ${error.message}`,
          ),
        );
      });
    });
  }

  _settle(entry, error, payload) {
    if (entry.settled) return;
    entry.settled = true;
    this.pending.delete(entry.id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.abortCleanup?.();
    if (error) entry.reject(error);
    else entry.resolve(payload);
  }

  _rejectAllPending(error) {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      if (entry.settled) continue;
      entry.settled = true;
      if (entry.timer) clearTimeout(entry.timer);
      entry.abortCleanup?.();
      entry.reject(error);
    }
  }

  _handleHttp(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${this.host}`);
    } catch {
      this._sendJson(res, 400, { error: 'bad request' });
      return;
    }

    this._applyCors(res, req.headers.origin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === PING_PATH && (req.method === 'GET' || req.method === 'HEAD')) {
      if (req.method === 'GET') {
        const signature = req.headers[PING_SIG_HEADER.toLowerCase()];
        if (signature !== PING_SIGNATURE) {
          this._sendJson(res, 403, { error: 'invalid client signature' });
          return;
        }
      }

      if (req.method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end();
        return;
      }

      this._sendJson(res, 200, this.registry.pingPayload());
      return;
    }

    this._sendJson(res, 404, { error: 'not found' });
  }

  _applyCors(res, origin) {
    if (!isAllowedOrigin(origin)) return;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-Kro-Client-Sig, X-Bridge-Token',
    );
    res.setHeader('Access-Control-Max-Age', '600');
  }

  _sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  _handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, `http://${this.host}`);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (url.pathname !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', (error) => {
        this.logger(`[kro-bridge] websocket error: ${error.message}`);
      });

      if (token !== this.registry.token) {
        ws.close(WS_CLOSE_AUTH_FAILED, 'auth failed');
        const timer = setTimeout(() => {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
        }, 2000);
        timer.unref?.();
        return;
      }

      this._attachClient(ws);
    });
  }

  _attachClient(ws) {
    const client = this.registry.registerClient('Chrome Extension');
    client.ws = ws;
    this.connections.set(client.sessionId, {
      ws,
      writeChain: Promise.resolve(),
    });

    ws.on('message', (data) => this._handleMessage(client, data));
    ws.on('close', () => this._detachClient(client));
    ws.on('error', (error) => {
      this.logger(
        `[kro-bridge] connection error sid=${prefix(client.sessionId)}: ${error.message}`,
      );
    });

    this.logger(`[kro-bridge] extension connected sid=${prefix(client.sessionId)}`);
  }

  _detachClient(client) {
    if (client.closed) return;
    client.closed = true;
    this.connections.delete(client.sessionId);
    this.registry.unregisterClient(client.sessionId);
    this._rejectAllPending(
      new BridgeError(
        ErrorCodes.DISCONNECTED,
        'browser websocket disconnected mid-command',
      ),
    );
    this.logger(`[kro-bridge] extension disconnected sid=${prefix(client.sessionId)}`);
  }

  _handleMessage(client, data) {
    const message = parseFrame(data);
    if (!message) {
      this.logger(`[kro-bridge] ignored malformed frame sid=${prefix(client.sessionId)}`);
      return;
    }

    const type = normalizeFrameType(message);
    const payload = framePayload(message);

    switch (type) {
      case 'hello':
        this._handleHello(client, message, payload);
        break;
      case 'page_updated':
        this._handlePageUpdated(payload);
        break;
      case 'page_closed':
      case 'page_removed':
        this._handlePageRemoved(payload);
        break;
      case 'result':
        this._deliverResult(message, payload);
        break;
      case 'error':
        this._deliverError(message, payload);
        break;
      case 'ping':
        break;
      default:
        break;
    }
  }

  _handleHello(client, message, payload) {
    const browserId =
      typeof payload.browser_id === 'string' ? payload.browser_id : '';
    const browserLabel =
      typeof payload.browser_label === 'string' ? payload.browser_label : '';
    let extensionVersion = '';
    if (payload.client && typeof payload.client === 'object') {
      extensionVersion =
        typeof payload.client.extension_version === 'string'
          ? payload.client.extension_version
          : '';
    }

    if (browserId) {
      this.registry.setBrowserId(
        client.sessionId,
        browserId,
        browserLabel,
        extensionVersion,
      );
    }

    const ackId =
      typeof message.id === 'string' && message.id !== ''
        ? message.id
        : 'hello_ack';
    const ack = buildHelloAck({
      id: ackId,
      sessionId: client.sessionId,
      browserId: client.browserId,
      browserLabel: client.label,
    });

    this._sendFrame(client, ack).catch((error) => {
      this.logger(
        `[kro-bridge] hello_ack failed sid=${prefix(client.sessionId)}: ${error.message}`,
      );
    });

    this.logger(
      `[kro-bridge] hello sid=${prefix(client.sessionId)} ` +
        `browser=${prefix(client.browserId)} version=${extensionVersion || '-'}`,
    );
  }

  _handlePageUpdated(payload) {
    const browserId =
      typeof payload.browser_id === 'string' ? payload.browser_id : '';
    const tabId = toInteger(payload.tab_id);
    const windowId = toInteger(payload.window_id);
    if (!browserId || tabId === null || windowId === null) return;

    this.registry.upsertPage(
      browserId,
      windowId,
      tabId,
      typeof payload.url === 'string' ? payload.url : '',
      typeof payload.title === 'string' ? payload.title : '',
      payload.active === true,
      typeof payload.context_role === 'string' ? payload.context_role : '',
    );
  }

  _handlePageRemoved(payload) {
    const browserId =
      typeof payload.browser_id === 'string' ? payload.browser_id : '';
    const tabId = toInteger(payload.tab_id);
    if (!browserId || tabId === null) return;
    this.registry.removePage(browserId, tabId);
  }

  _deliverResult(message, payload) {
    if (typeof message.id !== 'string' || message.id === '') return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this._settle(entry, null, payload);
  }

  _deliverError(message, payload) {
    if (typeof message.id !== 'string' || message.id === '') return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this._settle(
      entry,
      new BridgeError(ErrorCodes.EXTENSION_ERROR, extensionErrorDetail(payload)),
    );
  }

  _sendFrame(client, frame) {
    const connection = this.connections.get(client.sessionId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new BridgeError(ErrorCodes.DISCONNECTED, 'browser websocket is not available'),
      );
    }

    const data = JSON.stringify(frame);
    const run = () =>
      new Promise((resolve, reject) => {
        connection.ws.send(data, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

    const next = connection.writeChain.then(run, run);
    connection.writeChain = next.catch(() => {});
    return next;
  }
}

export function createBridge(options = {}) {
  return new Bridge(options);
}
