import { createHash, randomUUID } from 'node:crypto';

// Protocol constants are hardcoded on the extension side. Do not change them.
export const PING_CLIENT_ID = 'kro-browser-bridge';
export const PING_SALT = 'kro-2026';
export const PING_SIG_HEADER = 'X-Kro-Client-Sig';
export const PING_PATH = '/chrome-bridge/ping';
export const WS_PATH = '/chrome-bridge/ws';
export const SERVER_NAME = 'krow-browser-bridge';
export const PROTOCOL_VERSION = '1.0';
export const WS_CLOSE_AUTH_FAILED = 4401;

export const PING_SIGNATURE = createHash('sha256')
  .update(`${PING_CLIENT_ID}:${PING_SALT}`)
  .digest('hex');

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 17323;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const MAX_RESULT_BYTES = 32 * 1024;

export function nowMs() {
  return Date.now();
}

export function randomId() {
  return randomUUID();
}

export function newPageId() {
  return `page_${randomUUID().slice(0, 8)}`;
}

export function parseFrame(raw) {
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function framePayload(msg) {
  const payload = msg?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  return payload;
}

export function normalizeFrameType(msg) {
  const type = typeof msg?.type === 'string' ? msg.type : '';
  if (type === 'event') {
    const name = framePayload(msg).name;
    if (name === 'page_updated') return 'page_updated';
    if (name === 'page_closed' || name === 'page_removed') return 'page_removed';
  }
  return type;
}

export function buildPingPayload({ instanceId, token }) {
  return {
    ok: true,
    server: SERVER_NAME,
    instanceId,
    protocolVersion: PROTOCOL_VERSION,
    wsPath: WS_PATH,
    token,
  };
}

export function buildHelloAck({ id, sessionId, browserId, browserLabel }) {
  return {
    type: 'hello_ack',
    id: id || 'hello_ack',
    session_id: sessionId,
    timestamp: nowMs(),
    payload: {
      browser_id: browserId,
      browser_label: browserLabel,
    },
  };
}

export function buildCommandFrame({ id, sessionId, tool, args }) {
  return {
    type: 'command',
    id,
    session_id: sessionId,
    timestamp: nowMs(),
    payload: {
      tool,
      arguments: args,
    },
  };
}

export function extensionErrorDetail(payload) {
  const message = typeof payload?.message === 'string' ? payload.message : '';
  const code = typeof payload?.code === 'string' ? payload.code : '';
  if (code && message) return `${code}: ${message}`;
  if (code) return code;
  return message || 'browser bridge command failed';
}
