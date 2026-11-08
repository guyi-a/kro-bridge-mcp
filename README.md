# kro-bridge-mcp

把用户 Edge 里的 **Kro Browser Bridge** 扩展接到 Claude Code 的本地 MCP 适配层。

它自己不做任何智能决策，也不调用 LLM：

- **对扩展**：扮演兼容的 bridge 服务端（HTTP ping + WebSocket），监听 `127.0.0.1:17323`。
- **对 Claude Code**：扮演 MCP server（stdio），把浏览器动作暴露成工具 `browser_bridge`。

```text
Kro 扩展（用户 Edge）
        │  WS  ws://127.0.0.1:17323/chrome-bridge/ws?token=...
        │  HTTP GET/HEAD /chrome-bridge/ping
        ▼
  kro-bridge-mcp（本进程）
        │  MCP over stdio
        ▼
  Claude Code
```

决策始终在 Claude Code 这侧；本项目只转发命令和回包。

---

## 前置条件

- Windows 11（其他平台理论可用，未验证）。
- Node.js >= 20（开发机为 v24）。
- Edge 已安装 **Kro Browser Bridge** 扩展。
- 运行期间 **不要同时运行其他占用 `17323` 的 bridge 服务端**，否则会端口冲突。
- 首次 `npm install` 需要联网。

## 安装

```bash
cd <path-to-repo>
npm install
```

`<path-to-repo>` 指克隆后的仓库根目录。无构建步骤，纯 JavaScript ESM。

## 启动与自检

手动启动（用于自检；Claude Code 通过 MCP 注册直接拉起 `node server.js`）：

```bash
npm start
```

stderr 应看到：

```text
[kro-bridge] listening on 127.0.0.1:17323
[kro-bridge] MCP stdio connected; tool browser_bridge registered
```

另开终端验证 ping（PowerShell 的 `curl` 是 `Invoke-WebRequest` 别名，使用 `curl.exe`）：

```bash
curl.exe -H "X-Kro-Client-Sig: 52a6681f244444dd5d603b204b6616ccdb738f6e59e8e53942876030a3c82e99" http://127.0.0.1:17323/chrome-bridge/ping
```

期望返回：

```json
{"ok":true,"server":"krow-browser-bridge","instanceId":"...","protocolVersion":"1.0","wsPath":"/chrome-bridge/ws","token":"..."}
```

`instanceId` 和 `token` 每个进程重新生成，不持久化。

## 注册到 Claude Code（用户级）

```bash
claude mcp add --scope user kro-bridge -- node "<path-to-repo>/server.js"
```

- 把 `<path-to-repo>` 换成克隆后的仓库绝对路径（Windows 可用正斜杠）。
- 注册后需要**重启 Claude Code 会话**才会加载 MCP 工具。
- 工具列表里应出现 `browser_bridge`。
- 如果 `node` 不在 Claude Code 的 PATH（例如 nvm-windows 切换过版本），把命令里的 `node` 换成 `node.exe` 的绝对路径。
- `npm start` 只用于自检；不要让 Claude Code 通过 `npm start` 启动，否则可能多一层 shell/日志干扰。

## 连接 Edge 扩展

1. 确认没有其他 bridge 服务端占用 `17323`：`netstat -ano | findstr :17323` 应无监听。
2. 点 Edge 工具栏的 Kro Browser Bridge 扩展图标。
3. `Port` 选 **Auto detect**，或手动填 `17323`。
4. 点 **Reconnect**，直到状态显示 **Connected**。
5. 如果服务端重启过，token 会变化，扩展通常需要再点一次 Reconnect。

## 使用流程

Claude Code 使用 `browser_bridge` 时的推荐顺序：

1. `extension_status` → `ready=false` 立即停止，告诉用户“扩展未连接”，不要猜。
2. `list_sessions` → 拿 `browser_id`。
3. `list_pages` → 优先复用用户已打开的 tab；需要时 `focus_page`。
4. 需要新页时 `open_tab`。
5. `read_state` → 拿到元素编号。
6. 按编号 `click / hover / dblclick / rightclick / type / press / scroll`。
7. **每次操作后重新 `read_state`**；DOM 一变编号立即作废。
8. 不主动 `close_tab`，除非用户明确要求。

硬性纪律：

- 登录、验证码、短信/邮箱验证、支付、“同意条款”一律交还用户手动完成。
- 不要对用户已登录的敏感网站做超出请求范围的操作。
- `page_id` 失效时不要盲重试，重新 `list_pages`。
- 扩展重连后 `session_id / browser_id` 可能变化，重新 `list_sessions`。

### Action 表

| action | 参数 | 说明 |
| --- | --- | --- |
| `extension_status` | — | 探测扩展是否连接；返回 `ready / sessions_count / browser_ids / extension_versions?` |
| `list_sessions` | — | 列出已连接的扩展实例，拿 `browser_id` |
| `list_pages` | `browser_id` | 列出该浏览器的 tab，拿 `page_id` |
| `open_tab` | `browser_id`, `url`, `active?` | 新开 tab；`active` 默认 true |
| `focus_page` | `browser_id`, `page_id` | 把 tab 提到前台 |
| `close_tab` | `browser_id`, `page_id` | 关闭 tab（谨慎，这是用户真实浏览器） |
| `read_state` | `browser_id`, `page_id` | 拿编号 markdown |
| `click` / `hover` / `dblclick` / `rightclick` | `browser_id`, `page_id`, `index` | 点击变体 |
| `type` | `browser_id`, `page_id`, `index`, `text` | 填输入框 |
| `press` | `browser_id`, `page_id`, `key`, `index?` | 键盘按键；index 省略作用于整页 |
| `scroll` | `browser_id`, `page_id`, `x`, `y`, `index?` | 相对滚动，正 y 向下 |
| `wait_for` | `browser_id`, `page_id`, `timeout_ms?` | 等待页面稳定，默认 10000ms |
| `go_back` / `reload` | `browser_id`, `page_id` | 浏览器导航 |
| `extract` | `browser_id`, `page_id`, `index`, `include_html?` | 拿元素文本，可选 outerHTML |
| `describe_element` | `browser_id`, `page_id`, `index` | 拿元素稳定 selector / 属性 |
| `execute_script` | `browser_id`, `page_id`, `script` | 跑 JS，返回值必须 JSON 可序列化 |

`extension_status / list_sessions / list_pages` 由本进程直接回答，不发扩展。

### `execute_script` 硬约束

不遵守时扩展可能静默返回 `null`，无法诊断：

1. **单行、无换行、无缩进**；语句用 `;` 分隔。
2. **IIFE + 显式 `return`**：`(function(){...return X;})()`。
3. **只用单引号**；对象字面量 key 不加引号。
4. 返回体控制在 **KB 级**；大列表分批 `slice(0, 10)`。
5. 返回 `null` 一次先 `wait_for` 2 秒重试；仍 `null` 就停下报告。

## 测试

```bash
npm test
```

使用 `node:test` + 模拟扩展，不需要真实浏览器。当前覆盖：

- 协议常量、签名、ping GET/HEAD/403/OPTIONS CORS
- WS 错误 token → 4401；hello / hello_ack / browser_id 重索引
- page 事件（直接与 `type:"event"` 两种形状）、page_id 稳定复用、关闭删除、断线清理、重连防误删
- 命令信封、result/error、乱序回包、迟到 id、坏 JSON、ping 心跳
- 30 秒默认超时（测试注入短超时）、断线立即 reject、pending 清理
- 20 个 action 的参数映射与校验
- 32 KiB 截断（ASCII / 中文 / emoji）
- MCP 工具注册、schema、stdio 洁净、`server.js` 启停

## 协议摘要

```text
PingClientID    = "kro-browser-bridge"
PingSalt        = "kro-2026"
PingSigHeader   = "X-Kro-Client-Sig"
PingPath        = "/chrome-bridge/ping"
WSPath          = "/chrome-bridge/ws"
ServerName      = "krow-browser-bridge"
ProtocolVersion = "1.0"
WSCloseAuthFailed = 4401
PingSignature   = 52a6681f244444dd5d603b204b6616ccdb738f6e59e8e53942876030a3c82e99
```

- `GET ping` 校验签名；`HEAD ping` 不校验，用于探活。
- WS 错误 token：先 upgrade，再以 close code `4401`（reason `auth failed`）关闭。
- 帧为 JSON 文本。扩展 → 服务端：`hello`、`page_updated`、`page_closed`、`page_removed`、`result`、`error`、`ping`。
- 服务端 → 扩展：`hello_ack`、`command`。
- 命令信封：

```json
{
  "type": "command",
  "id": "<uuid>",
  "session_id": "<session uuid>",
  "timestamp": 1700000000000,
  "payload": { "tool": "browser_read_state", "arguments": { } }
}
```

- 命令默认 30 秒超时；任一连接断开时立即 reject 所有 pending。
- `page_id` 由本服务生成，形如 `page_` + 8 位十六进制，对应 `(browser_id, tab_id)`；同一 tab 更新复用，tab 关闭删除。
- 单次转发结果超过 32 KiB 时返回 `{truncated:true, action, original_size_bytes, kept_size_bytes, note, preview_json}`。

## 安全与隐私

- 只监听 `127.0.0.1`，不绑定 `0.0.0.0`。
- `token` 每个进程重新生成，不持久化、不记录。
- 日志只记会话/动作元信息；不记录 token、Cookie、完整 URL 查询串、页面正文、脚本内容。
- 不实现任意 HTTP 代理，不向外部网络转发数据。
- 这是用户的真实浏览器：不主动关闭用户 tab，不做超出请求范围的操作。

## 已知限制

- **没有截图**：bridge 协议没有 screenshot 动作，不要用截图能力承诺任务。
- **单实例**：同一时间只能跑一个 server；第二个会 `EADDRINUSE`。这也意味着同一时间只有一个 Claude Code 会话能使用 `browser_bridge`；要切换会话，先结束占用 17323 的那个会话。
- **端口冲突**：其他 bridge 服务端也可能监听 `17323`，运行前先停掉它。
- **扩展需手动连接**：Auto detect 扫不到时，手动填 `17323` 再 Reconnect。
- **服务重启后 token 变化**：扩展可能需要再次 Reconnect。
- **`wait_for` 有效上限约 30 秒**：超过会先触发命令超时。
- **`press` 使用合成键盘事件**：某些浏览器默认行为（例如 Tab 切换焦点）可能不触发；按键动作本身会成功返回。
- **断线 reject 所有 pending**：多浏览器时，一个连接断开会影响另一浏览器的在途命令（对齐参考实现，v1 限制）。
- **`open_tab` 回包可能没有 `page_id`**：等 `page_updated` 后 `list_pages` 按 URL/最新 tab 匹配。
- **`close_tab` 的页面移除是事件驱动**：`list_pages` 可能短暂看到已关闭 tab。
- **登录/验证码/支付/条款**：一律由用户手动完成。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `EADDRINUSE` / `EACCES` | 17323 被其他 bridge 服务端或另一个 kro-bridge-mcp 实例占用；停掉对方，或设置 `KRO_BRIDGE_PORT`（仅测试用） |
| 扩展一直 Disconnected | 确认 server 已启动；Port 手动填 `17323` 再 Reconnect；确认没有其他 bridge 服务端抢占 |
| WS 被 4401 关闭 | token 不匹配；重启 server 后重新 ping/Reconnect |
| `browser_id ... not connected` | 扩展掉线或重启过；重新 `extension_status` / `list_sessions` |
| `page_id ... not found` | tab 被关闭或用户切换了页面；重新 `list_pages`，不要盲重试 |
| `timed out after 30000 ms` | 页面卡死或扩展忙；先 `read_state` 看状态，不要立即重试 |
| 工具列表加载失败 | 检查是否有代码往 stdout 写日志；本项目日志一律走 stderr |
| PowerShell `curl` 行为异常 | 使用 `curl.exe` |
| `node` 找不到 | 用绝对 `node.exe` 路径重新注册 MCP |

## 验收状态

自动化测试：**43/43 通过**（`npm test`，协议 + MCP 层，无需真实浏览器）。

真实 Edge 联调：**已完成（2026-11-08）**。

- [x] 真实扩展 Connected，`extension_status.ready === true`（browser_id `28bf…00906`，extension 0.0.6）
- [x] `list_sessions` / `list_pages` 拿到真实 browser_id / page_id
- [x] `open_tab` → `read_state` → `execute_script` 读 `document.title` 成功（example.com）
- [x] `click` / `type` / `extract` 各成功一次（example.com 链接、httpbin 表单）
- [x] 重启 Claude Code / server 后扩展能重连
- [x] 未关闭用户已有 tab

真实环境记录：

| 日期 | 动作 | 结果 | 备注 |
| --- | --- | --- | --- |
| 2026-11-08 | `extension_status` | `ready=true`，1 session | extension 0.0.6 |
| 2026-11-08 | `list_pages` | 初始 3 个用户 tab | 未操作 |
| 2026-11-08 | `open_tab` example.com | `page_1838742c` | 新 tab |
| 2026-11-08 | `read_state` | 7 个元素 | |
| 2026-11-08 | `execute_script` | `title = "Example Domain"` | 该版本页面无 h1 |
| 2026-11-08 | `extract` index 7 | `"Learn more"` → iana.org | |
| 2026-11-08 | `click` index 7 | `navigates=true` | 跳转 iana.org |
| 2026-11-08 | `wait_for` + `read_state` | iana.org 已加载，80 个元素 | |
| 2026-11-08 | `go_back` | 回到 example.com | |
| 2026-11-08 | `open_tab` httpbin 表单 | `page_3a6fd4ee` | |
| 2026-11-08 | `type` index 4 | `value = "kro-bridge test"` | `read_state` 确认 |
| 2026-11-08 | `describe_element` index 4 | `input[name="custname"]` | |
| 2026-11-08 | `press` Tab | 动作成功，焦点未变 | 合成键盘事件不触发浏览器默认 Tab 行为 |

## 开发结构

```text
server.js              MCP 入口：起 bridge → 注册工具 → stdio；信号与关闭
src/protocol.js        协议常量、签名、帧构造/解析
src/bridge.js          HTTP ping + WS + Registry + pending 命令表
src/tools.js           action 校验、参数构造、32 KiB 截断、MCP 注册
test/fake-extension.js 模拟扩展 WS 客户端
test/bridge.test.js    协议级测试
test/mcp.test.js       MCP 工具与 server.js 启停测试
```

MCP SDK 版本：`@modelcontextprotocol/sdk@^1.32.2`；`zod@^4.6.7`；`ws@^8.22.1`。

## License

[MIT](LICENSE)
