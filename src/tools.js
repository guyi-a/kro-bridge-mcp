import { z } from 'zod';
import { MAX_RESULT_BYTES } from './protocol.js';
import { BridgeError, ErrorCodes } from './bridge.js';

export const TOOL_NAME = 'browser_bridge';

export const ACTIONS = Object.freeze([
  'extension_status',
  'list_sessions',
  'list_pages',
  'open_tab',
  'focus_page',
  'close_tab',
  'read_state',
  'click',
  'hover',
  'dblclick',
  'rightclick',
  'type',
  'press',
  'scroll',
  'wait_for',
  'go_back',
  'reload',
  'extract',
  'describe_element',
  'execute_script',
]);

export const TOOL_DESCRIPTION = [
  "Drive the user's real Edge browser through the Kro Browser Bridge extension.",
  "Always start with action='extension_status'; if ready=false, stop and tell the user the extension is not connected.",
  'Typical flow: extension_status -> list_sessions (pick browser_id) -> list_pages / open_tab -> read_state (get element indices) -> click/hover/dblclick/rightclick/type/press by index -> read_state again after every DOM-changing action.',
  'Element indices only stay valid until the DOM changes.',
  "Do not close the user's tabs unless explicitly asked.",
  'Hand login, CAPTCHA, SMS/email verification, payment, and consent screens back to the user.',
  'execute_script must be a single line, an IIFE with an explicit return, single quotes only, and a KB-scale return value.',
  'This protocol has no screenshot action.',
].join(' ');

export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

function requireString(input, field, action) {
  const value = input?.[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ToolError(
      ErrorCodes.INVALID_ARGUMENT,
      `${action} 需要 ${field}`,
    );
  }
  return value;
}

function requireIndex(input, action) {
  const value = input?.index;
  if (!Number.isInteger(value) || value < 1) {
    throw new ToolError(
      ErrorCodes.INVALID_ARGUMENT,
      `${action} 需要 index（>= 1）`,
    );
  }
  return value;
}

function optionalIndex(input, action) {
  const value = input?.index;
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value)) {
    throw new ToolError(
      ErrorCodes.INVALID_ARGUMENT,
      `${action} 的 index 必须是整数`,
    );
  }
  return value > 0 ? value : null;
}

function optionalInteger(input, field, fallback, action) {
  const value = input?.[field];
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value)) {
    throw new ToolError(
      ErrorCodes.INVALID_ARGUMENT,
      `${action} 的 ${field} 必须是整数`,
    );
  }
  return value;
}

function resolveTimeout(input, action) {
  const value = input?.timeout_ms;
  if (value === undefined || value === null) return 10000;
  if (!Number.isInteger(value)) {
    throw new ToolError(
      ErrorCodes.INVALID_ARGUMENT,
      `${action} 的 timeout_ms 必须是整数`,
    );
  }
  return value <= 0 ? 10000 : value;
}

function requireBrowserId(input, action) {
  return requireString(input, 'browser_id', action);
}

function requirePageId(input, action) {
  return requireString(input, 'page_id', action);
}

function requirePage(bridge, browserId, pageId, action) {
  const page = bridge.getPage(browserId, pageId);
  if (!page) {
    throw new ToolError(
      ErrorCodes.PAGE_NOT_FOUND,
      `page_id ${pageId} not found under browser_id ${browserId}，请重新 list_pages`,
    );
  }
  return page;
}

function requireBoolean(input, field, action) {
  const value = input?.[field];
  if (value !== undefined && typeof value !== 'boolean') {
    throw new ToolError(
      ErrorCodes.INVALID_ARGUMENT,
      `${action} 的 ${field} 必须是布尔值`,
    );
  }
  return value === true;
}

export async function dispatchAction(bridge, input, { signal } = {}) {
  const action = input?.action;
  if (!ACTIONS.includes(action)) {
    throw new ToolError(
      ErrorCodes.INVALID_ARGUMENT,
      `unknown action: ${String(action)}`,
    );
  }

  switch (action) {
    case 'extension_status':
      return { ok: true, status: bridge.extensionStatus() };

    case 'list_sessions':
      return { ok: true, sessions: bridge.listSessions() };

    case 'list_pages': {
      const browserId = requireBrowserId(input, action);
      return { ok: true, pages: bridge.listPages(browserId) };
    }

    case 'open_tab': {
      const browserId = requireBrowserId(input, action);
      const url = requireString(input, 'url', action);
      const active = input.active === undefined ? true : requireBoolean(input, 'active', action);
      const data = await bridge.sendCommand(
        browserId,
        'browser_open_tab',
        { browser_id: browserId, url, active },
        { signal },
      );
      return { ok: true, data };
    }

    case 'focus_page': {
      const browserId = requireBrowserId(input, action);
      const pageId = requirePageId(input, action);
      const page = requirePage(bridge, browserId, pageId, action);
      const data = await bridge.sendCommand(
        browserId,
        'browser_focus_page',
        {
          browser_id: browserId,
          page_id: pageId,
          window_id: page.windowId,
          tab_id: page.tabId,
        },
        { signal },
      );
      return { ok: true, data };
    }

    case 'close_tab': {
      const browserId = requireBrowserId(input, action);
      const pageId = requirePageId(input, action);
      const page = requirePage(bridge, browserId, pageId, action);
      const data = await bridge.sendCommand(
        browserId,
        'browser_close_tab',
        {
          browser_id: browserId,
          page_id: pageId,
          tab_id: page.tabId,
        },
        { signal },
      );
      return { ok: true, data };
    }

    case 'read_state': {
      const browserId = requireBrowserId(input, action);
      const pageId = requirePageId(input, action);
      const page = requirePage(bridge, browserId, pageId, action);
      const data = await bridge.sendCommand(
        browserId,
        'browser_read_state',
        {
          browser_id: browserId,
          page_id: pageId,
          tab_id: page.tabId,
          task_id: '',
        },
        { signal },
      );
      return { ok: true, data };
    }

    case 'click':
    case 'hover':
    case 'dblclick':
    case 'rightclick': {
      const browserId = requireBrowserId(input, action);
      const pageId = requirePageId(input, action);
      const index = requireIndex(input, action);
      const page = requirePage(bridge, browserId, pageId, action);
      const data = await bridge.sendCommand(
        browserId,
        'browser_click',
        {
          browser_id: browserId,
          page_id: pageId,
          tab_id: page.tabId,
          index,
          variant: action,
        },
        { signal },
      );
      return { ok: true, data, message: `${action} index ${index}` };
    }

    case 'type': {
      const browserId = requireBrowserId(input, action);
      const pageId = requirePageId(input, action);
      const index = requireIndex(input, action);
      const text = requireString(input, 'text', action);
      const page = requirePage(bridge, browserId, pageId, action);
      const data = await bridge.sendCommand(
        browserId,
        'browser_type',
        {
          browser_id: browserId,
          page_id: pageId,
          tab_id: page.tabId,
          index,
          text,
        },
        { signal },
      );
      return { ok: true, data };
    }

    case 'press': {
      const browserId = requireBrowserId(input, action);
      const pageId = requirePageId(input, action);
      const key = requireString(input, 'key', action);
      const index = optionalIndex(input, action);
      const page = requirePage(bridge, browserId, pageId, action);
      const args = {
        browser_id: browserId,
        page_id: pageId,
        tab_id: page.tabId,
        key,
      };
      if (index !== null) args.index = index;
      const data = await bridge.sendCommand(
        browserId,
        'browser_press',
        args,
        { signal },
      );
      return { ok: true, data };
    }

    case 'scroll': {
      const browserId = requireBrowserId(input, action);
      const pageId = requirePageId(input, action);
      const x = optionalInteger(input, 'x', 0, action);
      const y = optionalInteger(input, 'y', 0, action);
      const index = optionalIndex(input, action);
      const page = requirePage(bridge, browserId, pageId, action);
      const args = {
        browser_id: browserId,
        page_id: pageId,
        tab_id: page.tabId,
        x,
        y,
      };
      if (index !== null) args.index = index;
      const data = await bridge.sendCommand(
        browserId,
        'browser_scroll',
        args,
        { signal },
      );
      return { ok: true, data, message: `scrolled by (${x},${y})` };
    }

    case 'wait_for': {
      const browserId = requireBrowserId(input, action);
      const pageId = requirePageId(input, action);
      const timeoutMs = resolveTimeout(input, action);
      const page = requirePage(bridge, browserId, pageId, action);
      const data = await bridge.sendCommand(
        browserId,
        'browser_wait_for',
        {
          browser_id: browserId,
          page_id: pageId,
          tab_id: page.tabId,
          timeout_ms: timeoutMs,
        },
        { signal },
      );
      return { ok: true, data, message: 'wait done' };
    }

    case 'go_back': {
      const browserId = requireBrowserId(input, action);
      const pageId = requirePageId(input, action);
      const page = requirePage(bridge, browserId, pageId, action);
      const data = await bridge.sendCommand(
        browserId,
        'browser_go_back',
        {
          browser_id: browserId,
          page_id: pageId,
          tab_id: page.tabId,
        },
        { signal },
      );
      return { ok: true, data, message: 'navigated back' };
    }

    case 'reload': {
      const browserId = requireBrowserId(input, action);
      const pageId = requirePageId(input, action);
      const page = requirePage(bridge, browserId, pageId, action);
      const data = await bridge.sendCommand(
        browserId,
        'browser_reload',
        {
          browser_id: browserId,
          page_id: pageId,
          tab_id: page.tabId,
        },
        { signal },
      );
      return { ok: true, data, message: 'reloaded' };
    }

    case 'extract': {
      const browserId = requireBrowserId(input, action);
      const pageId = requirePageId(input, action);
      const index = requireIndex(input, action);
      const includeHtml = requireBoolean(input, 'include_html', action);
      const page = requirePage(bridge, browserId, pageId, action);
      const data = await bridge.sendCommand(
        browserId,
        'browser_extract',
        {
          browser_id: browserId,
          page_id: pageId,
          tab_id: page.tabId,
          index,
          include_html: includeHtml,
        },
        { signal },
      );
      return { ok: true, data };
    }

    case 'describe_element': {
      const browserId = requireBrowserId(input, action);
      const pageId = requirePageId(input, action);
      const index = requireIndex(input, action);
      const page = requirePage(bridge, browserId, pageId, action);
      const data = await bridge.sendCommand(
        browserId,
        'browser_describe_element',
        {
          browser_id: browserId,
          page_id: pageId,
          tab_id: page.tabId,
          index,
        },
        { signal },
      );
      return { ok: true, data };
    }

    case 'execute_script': {
      const browserId = requireBrowserId(input, action);
      const pageId = requirePageId(input, action);
      const script = requireString(input, 'script', action);
      const page = requirePage(bridge, browserId, pageId, action);
      const data = await bridge.sendCommand(
        browserId,
        'browser_execute_script',
        {
          browser_id: browserId,
          page_id: pageId,
          tab_id: page.tabId,
          script,
        },
        { signal },
      );
      return { ok: true, data };
    }

    default:
      throw new ToolError(
        ErrorCodes.INVALID_ARGUMENT,
        `unknown action: ${String(action)}`,
      );
  }
}

function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

export function capBridgeData(data, action, maxBytes = MAX_RESULT_BYTES) {
  const serialized = JSON.stringify(data);
  if (serialized === undefined) return data;
  const size = Buffer.byteLength(serialized);
  if (size <= maxBytes) return data;

  const stubOverhead = 512;
  const previewCap = Math.max(0, maxBytes - stubOverhead);
  let preview = truncateUtf8(serialized, previewCap);
  let kept = Buffer.byteLength(preview);

  const buildStub = () => ({
    truncated: true,
    action,
    original_size_bytes: size,
    kept_size_bytes: kept,
    note:
      `result was ${size} bytes, exceeded ${MAX_RESULT_BYTES} byte cap; ` +
      `showing first ${kept} bytes of the raw JSON. The prefix may end mid-token. ` +
      'Narrow the script (paginate, select fewer fields, limit N) instead of retrying the same call.',
    preview_json: preview,
  });

  let stub = buildStub();
  let guard = 0;

  // preview_json is embedded as a JSON string, so quotes and backslashes
  // expand during serialization. Shrink until the whole stub fits the cap.
  while (
    Buffer.byteLength(JSON.stringify(stub)) > maxBytes &&
    kept > 0 &&
    guard < 10000
  ) {
    const overflow = Buffer.byteLength(JSON.stringify(stub)) - maxBytes;
    preview = truncateUtf8(preview, Math.max(0, kept - Math.max(overflow, 1)));
    kept = Buffer.byteLength(preview);
    stub = buildStub();
    guard += 1;
  }

  return stub;
}

export function capResult(result, action) {
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized) <= MAX_RESULT_BYTES) return result;

  if (result && typeof result === 'object' && 'data' in result) {
    const capped = {
      ...result,
      data: capBridgeData(result.data, action, MAX_RESULT_BYTES - 1024),
    };
    if (Buffer.byteLength(JSON.stringify(capped)) <= MAX_RESULT_BYTES) {
      return capped;
    }
  }

  return capBridgeData(result, action);
}

export async function handleBrowserBridge(bridge, input, extra = {}) {
  try {
    const result = await dispatchAction(bridge, input, { signal: extra.signal });
    const capped = capResult(result, input?.action);
    return {
      content: [{ type: 'text', text: JSON.stringify(capped) }],
    };
  } catch (error) {
    const known = error instanceof ToolError || error instanceof BridgeError;
    const message = known
      ? error.message
      : `browser_bridge 执行失败: ${error?.message ?? String(error)}`;
    if (!known) {
      console.error(
        `[kro-bridge] tool failure action=${input?.action ?? '?'}: ` +
          `${error?.stack ?? String(error)}`,
      );
    }
    return {
      isError: true,
      content: [{ type: 'text', text: message }],
    };
  }
}

export function registerBrowserBridgeTool(server, bridge) {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Browser Bridge',
      description: TOOL_DESCRIPTION,
      inputSchema: {
        action: z
          .enum(ACTIONS)
          .describe('Action to perform. Start with extension_status.'),
        browser_id: z
          .string()
          .optional()
          .describe('Stable browser id from list_sessions.'),
        page_id: z
          .string()
          .optional()
          .describe('Page id from list_pages or open_tab.'),
        url: z.string().optional().describe('Absolute URL for open_tab.'),
        active: z
          .boolean()
          .optional()
          .describe('open_tab: foreground the new tab. Defaults true.'),
        index: z
          .number()
          .int()
          .optional()
          .describe('Element index from the latest read_state.'),
        text: z.string().optional().describe('Text to fill for type.'),
        key: z
          .string()
          .optional()
          .describe("Key for press, e.g. 'Enter', 'Tab', 'Escape'."),
        x: z
          .number()
          .int()
          .optional()
          .describe('scroll: horizontal pixels (positive = right).'),
        y: z
          .number()
          .int()
          .optional()
          .describe('scroll: vertical pixels (positive = down).'),
        timeout_ms: z
          .number()
          .int()
          .optional()
          .describe('wait_for: max wait in milliseconds. Defaults 10000.'),
        include_html: z
          .boolean()
          .optional()
          .describe('extract: include the element outerHTML.'),
        script: z
          .string()
          .optional()
          .describe('execute_script: single-line IIFE source.'),
      },
    },
    async (input, extra) => handleBrowserBridge(bridge, input, extra),
  );
}
