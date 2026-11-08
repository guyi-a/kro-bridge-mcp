# 交接说明 · 实现 kro-bridge-mcp

> 读者：在本仓库根目录下新开的 Claude Code。
> 先读 `AGENTS.md`（项目规则与不变量），本文件是**任务说明书**。
> 目标：让 Claude Code 能操作已安装的 **Kro Browser Bridge** 扩展。

---

## 0. 一句话

写一个**本地 Node MCP server**：它对 Kro 扩展扮演兼容的 bridge 服务端，对 Claude Code 扮演 MCP server，中间只做协议转发；不调用 LLM，不做决策。

---

## 1. 背景与现状

- 用户 Edge 里已安装 **Kro Browser Bridge** 扩展；截图上显示 `Disconnected`、`Port: Auto detect`。
- 已有一套参考实现完整实现了这套 bridge 的**服务端**，监听 `127.0.0.1:17323`，扩展会自动探测并连接。
- 但参考实现的 `browser_bridge` 是它自己 Agent 的内部工具，**Claude Code 调不到**。
- 因此需要本项目：复刻它的协议，把浏览器动作暴露成 MCP 工具。Claude Code 这边直接获得 `open_tab / read_state / click / type / execute_script` 等能力。
- 扩展负责执行（通过 Chrome/Edge 的 `tabs` / `scripting` API）；登录态、已打开 tab 都是用户真实浏览器里的，天然可用。

**重要边界：** 你不需要启动参考实现，也不要把本项目做成另一个 Agent。它只是一个“协议管子”。

---

## 2. 交付物

1. 可运行的 MCP server（`npm start` 由 Claude Code 以 stdio 拉起）。
2. 协议级自动化测试（模拟扩展，不依赖真实浏览器）。
3. `README.md`：安装、启动、注册 MCP、测试、已知限制。
4. 注册到 Claude Code 的说明（建议用户级）。
5. 一份真实环境测试记录（见第 7 节）。

不要修改参考实现目录，也不要动无关项目目录。

---

## 3. 信息从哪来

协议以参考实现为准。参考实现的源码不随本仓库分发；实现所需的常量、帧格式和动作参数已经记录在 `AGENTS.md` 第 4 节和本文件第 4 节。

---

## 4. 协议规范（照此实现）

### 4.1 发现与鉴权

**常量**

```js
PingClientID    = "kro-browser-bridge"
PingSalt        = "kro-2026"
PingSigHeader   = "X-Kro-Client-Sig"
PingPath        = "/chrome-bridge/ping"
WSPath          = "/chrome-bridge/ws"
ServerName      = "krow-browser-bridge"
ProtocolVersion = "1.0"
WSCloseAuthFailed = 4401

PingSignature = sha256Hex(PingClientID + ":" + PingSalt)
```

**HTTP ping**

- `GET /chrome-bridge/ping`
  - 校验请求头 `X-Kro-Client-Sig === PingSignature`，不匹配返回 403 `{"error":"invalid client signature"}`。
- `HEAD /chrome-bridge/ping`
  - 不校验签名，返回 200，用于扩展探活。
- 响应体：

```json
{
  "ok": true,
  "server": "krow-browser-bridge",
  "instanceId": "<每个进程一个 UUID>",
  "protocolVersion": "1.0",
  "wsPath": "/chrome-bridge/ws",
  "token": "<每个进程一个 UUID，WS 鉴权用>"
}
```

注意字段名是 **camelCase**（`instanceId / protocolVersion / wsPath`），和动作参数的 snake_case 不同。

**WebSocket**

- `GET /chrome-bridge/ws?token=<token>`
- token 不匹配：先完成 upgrade，然后以 close code **4401** 关闭，reason `auth failed`。
- 允许任意 Origin（扩展的 Origin 是 `chrome-extension://...`）。
- 服务端为每条连接分配 `session_id`（UUID）。

### 4.2 帧格式

所有帧都是 JSON 文本。

**扩展 → 服务端：hello**

```json
{
  "type": "hello",
  "id": "<可选>",
  "payload": {
    "browser_id": "<扩展的稳定浏览器 id>",
    "browser_label": "<可读名称>",
    "client": { "extension_version": "x.y.z" }
  }
}
```

服务端回：

```json
{
  "type": "hello_ack",
  "id": "<原 id，缺省用 hello_ack>",
  "session_id": "<服务端分配的 UUID>",
  "timestamp": 1700000000000,
  "payload": {
    "browser_id": "<扩展上报的值>",
    "browser_label": "<可读名称>"
  }
}
```

**扩展 → 服务端：页面事件**

两种形状都要接受（参考实现会先把 `type:"event"` + `payload.name` 归一化）：

```json
{
  "type": "event",
  "payload": {
    "name": "page_updated",
    "browser_id": "...",
    "tab_id": 123,
    "window_id": 456,
    "url": "https://...",
    "title": "...",
    "active": true,
    "context_role": ""
  }
}
```

或直接：

```json
{
  "type": "page_updated",
  "payload": { "browser_id": "...", "tab_id": 123, "window_id": 456, "url": "...", "title": "...", "active": true, "context_role": "" }
}
```

关闭事件 `page_closed` / `page_removed`：payload 至少包含 `browser_id` 和 `tab_id`。

**服务端 → 扩展：命令**

```json
{
  "type": "command",
  "id": "<UUID，一次命令一个>",
  "session_id": "<目标连接的 session_id>",
  "timestamp": 1700000000000,
  "payload": {
    "tool": "browser_read_state",
    "arguments": {
      "browser_id": "...",
      "page_id": "page_xxxxxxxx",
      "tab_id": 123,
      "task_id": ""
    }
  }
}
```

**扩展 → 服务端：回包**

```json
{ "type": "result", "id": "<命令 id>", "payload": { } }
```

或：

```json
{ "type": "error", "id": "<命令 id>", "payload": { "message": "...", "code": "..." } }
```

服务端按 `id` 唤醒等待中的 Promise；**30 秒**超时；连接断开时把所有 pending 立即 reject。

空的 `{"type":"ping"}` 心跳忽略即可。

### 4.3 动作表（发给扩展的 `payload.tool` 与 arguments）

所有动作的 arguments 都要带上 `browser_id / page_id / tab_id`（参考实现如此）。

| 对 Claude 的 action | tool 名 | arguments |
| --- | --- | --- |
| `open_tab` | `browser_open_tab` | `browser_id, url, active` |
| `focus_page` | `browser_focus_page` | `browser_id, page_id, window_id, tab_id` |
| `close_tab` | `browser_close_tab` | `browser_id, page_id, tab_id` |
| `read_state` | `browser_read_state` | `browser_id, page_id, tab_id, task_id:""` |
| `click/hover/dblclick/rightclick` | `browser_click` | `browser_id, page_id, tab_id, index, variant` |
| `type` | `browser_type` | `browser_id, page_id, tab_id, index, text` |
| `press` | `browser_press` | `browser_id, page_id, tab_id, key, index?` |
| `scroll` | `browser_scroll` | `browser_id, page_id, tab_id, x, y, index?` |
| `wait_for` | `browser_wait_for` | `browser_id, page_id, tab_id, timeout_ms`（默认 10000） |
| `go_back` | `browser_go_back` | `browser_id, page_id, tab_id` |
| `reload` | `browser_reload` | `browser_id, page_id, tab_id` |
| `extract` | `browser_extract` | `browser_id, page_id, tab_id, index, include_html` |
| `describe_element` | `browser_describe_element` | `browser_id, page_id, tab_id, index` |
| `execute_script` | `browser_execute_script` | `browser_id, page_id, tab_id, script` |

`extension_status` / `list_sessions` / `list_pages` 不发给扩展，由本地 registry 直接回答。

**page_id 规则**

- 服务端生成，形如 `page_` + 8 位；对应 `(browser_id, tab_id)`。
- 同一 tab 的 `page_updated` 复用已存在的 `page_id`，只更新 url/title/active 等字段。
- tab 关闭事件删除对应 page。
- `list_pages` 只返回该 `browser_id` 下的页面。
- `open_tab` 的回包内容以扩展为准；如果回包里没有 `page_id`，等 `page_updated` 到达后调用 `list_pages`，按 URL / 最新 tab 匹配拿 `page_id`。

**session / browser 索引**

- `session_id → client`：每条 WS 连接一个。
- `browser_id → client`：`hello` 上报后重新索引；之前的临时 browser_id 要移除。
- 断线时清理该 client 的所有 page。

---

## 5. 推荐实现结构

```text
server.js          → 创建 bridge（监听 17323）+ 创建 McpServer（stdio）+ 注册工具
src/protocol.js    → 常量、PingSignature、帧构造函数、uuid/timestamp
src/bridge.js      → http server（ping）+ ws server（hello/page/command）+ registry + pending
src/tools.js       → browser_bridge 工具定义、参数校验、action→命令映射、结果截断
test/fake-extension.js → 模拟扩展：连 WS、发 hello/page_updated、收命令、回 result
test/bridge.test.js    → node:test 协议测试
```

关键点：

- `bridge.js` 导出可直接调用的方法：`extensionStatus()`、`listSessions()`、`listPages(browserId)`、`sendCommand(browserId, tool, args)`。MCP 层只做参数转换，方便测试。
- 允许用环境变量覆盖端口（如 `KRO_BRIDGE_PORT`），默认 `17323`；测试用随机端口。
- `server.js` 启动时先起 bridge，再连接 stdio transport。
- **不要用 `console.log`**；所有日志 `console.error`。
- MCP SDK 用 `@modelcontextprotocol/sdk`；具体 API 以装上的版本为准（`McpServer` + `registerTool`，或低层 `setRequestHandler`）。需要 `zod` 做输入 schema。不要凭记忆猜 API，装完后看包内 README / 类型定义。
- 工具返回值：

```js
{ content: [{ type: "text", text: JSON.stringify(result) }] }
```

错误返回：

```js
{ isError: true, content: [{ type: "text", text: "人类可读错误" }] }
```

- 单次结果 JSON 超过 32 KiB 时，返回截断标记（参考 `capBridgeData`）：
  `{ truncated: true, action, original_size_bytes, kept_size_bytes, note, preview_json }`。

---

## 6. 分阶段实施

### Phase 0 · 读与确认

1. 读完参考实现中的协议相关源码（协议常量、WS 路由、registry、service、actions、工具 schema、SKILL）。
2. 确认端口空闲：`netstat -ano | findstr :17323`，若有监听先问用户是否为其他 bridge 服务端。
3. 向用户复述一次方案和风险，确认后再装依赖。

### Phase 1 · 脚手架

1. `npm init -y`，设置 `"type": "module"`、`"engines": {"node": ">=20"}`。
2. 安装依赖：`npm install ws @modelcontextprotocol/sdk zod`。
3. 建 `src/`、`test/`、`.gitignore`（`node_modules`、`.env`、日志）。
4. 写 `src/protocol.js`：常量、`PingSignature`、`randomUUID()`、`nowMS()`。

### Phase 2 · Bridge 服务

1. HTTP server：
   - `GET/HEAD /chrome-bridge/ping`，GET 校验签名。
   - 返回 4.1 的 JSON，`token` 进程内唯一。
2. WS server：
   - 校验 `?token=`，错误则 upgrade 后 close 4401。
   - 分配 `session_id`，处理 `hello` 并回 `hello_ack`。
   - 处理 `page_updated / page_closed / page_removed / result / error / ping`。
3. Registry：实现 session/browser/page 三张索引和 `page_id` 稳定性。
4. `sendCommand`：pending Map + `id` 匹配 + 30 秒超时 + 断线 reject。
5. 只绑定 `127.0.0.1`。端口占用时给出清晰错误（可能其他 bridge 服务端在跑）。

### Phase 3 · MCP 层

1. 定义 `browser_bridge` 工具（参数表见 `AGENTS.md` 第 5 节）。
2. 实现本地 action：`extension_status / list_sessions / list_pages`。
3. 实现转发 action，并做参数校验（缺 `browser_id/page_id/index/text` 等返回可读错误）。
4. 结果截断。
5. 启动时把 bridge 监听成功/失败打到 stderr。

### Phase 4 · 自动化测试

1. `test/fake-extension.js`：能 ping、拿 token、连 WS、发 hello、发 page_updated、收 command、回 result。
2. `test/bridge.test.js` 覆盖：
   - 签名错误 → 403；HEAD 不校验 → 200。
   - 错误 token → close 4401。
   - hello → hello_ack；browser_id 重新索引。
   - page_updated → listPages 可见；同 tab 更新不换 page_id；关闭后删除。
   - sendCommand → fake 扩展收到正确 tool/arguments → 回 result → Promise resolve。
   - fake 扩展回 error → Promise reject。
   - 断线 → pending reject。
   - 30 秒超时（测试里可注入更短超时）。
3. `npm test` 必须全绿，且不依赖真实浏览器。

### Phase 5 · 真实环境联调

1. 确保其他占用 `17323` 的 bridge 服务端没有运行。
2. 启动 server（或先注册 MCP 让 Claude Code 拉起）。
3. **请用户操作 Edge**：点扩展图标 → 确认 `Port` 为 Auto detect 或手动 `17323` → Reconnect，直到显示 Connected。
4. 验证：
   - `extension_status` → `ready: true`，能看到 browser_id。
   - `list_pages` → 能看到用户当前 tab。
   - 打开一个安全测试页（例如 `https://example.com`）→ `read_state` → `execute_script` 读 `document.title`。
   - 不要关闭用户已有 tab；测试 tab 关闭前先问用户。
5. 重启 server，确认扩展能自动重连。

### Phase 6 · 文档与收尾

1. 写 `README.md`：它是什么、依赖、启动、注册 MCP、测试、限制。
2. 如有必要更新 `AGENTS.md` 中“目标目录结构”的实际差异。
3. 按第 10 节格式向用户报告。

---

## 7. 验收标准

- [ ] `GET /chrome-bridge/ping`（带正确签名）返回字段完整；错误签名 403。
- [ ] 错误 token 的 WS 被 4401 关闭。
- [ ] 真实扩展显示 Connected，`extension_status.ready === true`。
- [ ] `list_sessions / list_pages / open_tab / read_state / click / type / extract / execute_script` 至少各成功一次。
- [ ] `npm test` 全绿，覆盖 hello、page 事件、命令回包、错误、断线。
- [ ] 端口被占、扩展未连接、page_id 失效时错误清晰，不崩溃。
- [ ] stdout 无任何非 MCP 输出。
- [ ] README 能让人从零启动。

---

## 8. 需要用户配合的动作

遇到以下节点必须停下来请用户操作，不要自己猜：

1. `npm install` 需要联网下载依赖。
2. 注册 MCP / 重启 Claude Code 会话。
3. 在 Edge 里连接扩展（Auto detect 或填 `17323`）。
4. 需要登录、验证码、支付、同意条款的页面。
5. 关闭任何不是本工具新开的 tab。
6. 如果用户正在运行其他 bridge 服务端，需要先停掉它（端口冲突）。

---

## 9. 常见坑

1. **stdout 污染**：MCP 用 stdout 传协议帧，任何 `console.log` 都会让工具列表加载失败。日志一律 `console.error`。
2. **端口冲突**：其他 bridge 服务端也可能监听 `17323`。启动前查 `netstat`；端口占用时错误信息要提示这一点。
3. **扩展不连**：Auto detect 可能没有扫到；让用户在扩展里手动把 Port 设为 `17323` 再 Reconnect。服务端重启后扩展可能需要重连。
4. **token 是进程级的**：不要持久化，不要跨进程复用；每次启动重新生成。
5. **hello 前 browser_id 是临时的**：收到 hello 后必须重命名索引，否则 `list_sessions` 里的 id 和实际连接对不上。
6. **JSON 数字**：`tab_id / window_id` 反序列化后是 `Number`；Go 里是 float64，JS 里直接 `Number()` 即可。
7. **page_id 不能由扩展给**：它是服务端生成的；扩展只知道 `tab_id`。
8. **命令超时**：默认 30 秒；不要无限等待。断线时立即 reject 所有 pending。
9. **execute_script 约束**：脚本必须单行、无换行、IIFE + `return`、只用单引号、返回体 KB 级；否则扩展可能静默返回 null。
10. **没有 screenshot**：bridge 协议没有截图动作，不要声称支持。
11. **ESM 路径**：`__dirname` 不存在，用 `fileURLToPath(import.meta.url)`。
12. **Windows 路径**：注册 MCP 时 Node 路径用正斜杠或正确转义；建议 `node "<path-to-repo>/server.js"`，并把 `<path-to-repo>` 换成仓库绝对路径。
13. **多实例**：同一时间只跑一个 server；第二个会 `EADDRINUSE`。v1 不做守护进程，日志说明即可。
14. **敏感数据**：日志不要打印完整 URL 查询串、Cookie、页面正文；只记动作和 id。

---

## 10. 最终向用户报告什么

1. 项目位置与文件清单。
2. 启动命令、MCP 注册命令、是否需要重启。
3. 测试证据：`npm test` 输出；真实环境每一步的动作与结果（例如 `extension_status` 返回了什么）。
4. 已知限制：无截图、单实例、扩展需手动连接、登录需用户操作。
5. 下一步建议（如常驻守护进程、细粒度工具、自动重连）。

报告要如实：没测过的不要写成已通过；失败就贴错误。
