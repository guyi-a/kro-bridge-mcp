# AGENTS.md · kro-bridge-mcp

> 项目级常驻说明。任何在本目录启动的 Claude Code，先读本文件，再读 `HANDOFF.md`。
>
> **当前状态：v1 已实现，`npm test` 全绿；真实 Edge 联调（Phase 5）已完成（2026-11-08）。** 具体实现任务、协议细节、验收流程都在 `HANDOFF.md`，使用说明见 `README.md`。

## 1. 项目定位

`kro-bridge-mcp` 是一个**纯本地适配层**，把用户 Edge 浏览器里的 **Kro Browser Bridge** 扩展接到 Claude Code。

它自己不做任何智能决策，也不调用 LLM：

- **对扩展**：扮演兼容的 bridge 服务端（HTTP ping + WebSocket），让扩展连上来。
- **对 Claude Code**：扮演 MCP server（stdio），把浏览器动作暴露成工具。

```text
Kro 扩展（用户的 Edge）
        │  WS  ws://127.0.0.1:17323/chrome-bridge/ws?token=...
        ▼
  kro-bridge-mcp（本进程）
        │  MCP over stdio
        ▼
  Claude Code
```

**决策始终在 Claude Code 这侧。** 本项目只负责转发命令和回包。

## 2. 技术栈与运行约束

- Windows 11；Node.js >= 20（本机为 v24）。
- 纯 JavaScript ESM，无构建步骤，不引入 TypeScript。
- 依赖：`ws`、`@modelcontextprotocol/sdk`。
- HTTP / WS 服务只绑定 `127.0.0.1:17323`，禁止绑定 `0.0.0.0`。
- MCP 走 stdio。
- **stdout 只能输出 MCP 协议帧。所有日志必须走 stderr（`console.error`）。** `console.log` 会破坏 MCP 协议。
- 不修改参考实现目录或其他无关项目目录。
- 不提交任何密钥、Cookie、页面内容或用户隐私数据。

## 3. 目标目录结构

```text
kro-bridge-mcp/
├── AGENTS.md
├── HANDOFF.md
├── README.md
├── package.json
├── .gitignore
├── server.js              # MCP 入口：初始化 bridge + 注册工具
├── src/
│   ├── protocol.js        # 协议常量、签名、帧构造
│   ├── bridge.js          # HTTP ping + WS + registry + 命令分发
│   └── tools.js           # MCP 工具定义与参数校验
└── test/
    ├── fake-extension.js  # 模拟扩展的 WS 客户端
    ├── bridge.test.js     # 协议级测试
    └── mcp.test.js        # MCP 工具与 server.js 启停测试
```

允许在不破坏上述职责划分的前提下微调，但必须保持“协议层 / MCP 层”分离，便于用模拟扩展做测试。

## 4. 协议不变量（绝不能改）

以下常量与扩展写死，改一个字节扩展就连不上。完整帧格式见 `HANDOFF.md` 第 4 节。

```text
PingClientID   = "kro-browser-bridge"
PingSalt       = "kro-2026"
PingSigHeader  = "X-Kro-Client-Sig"
PingPath       = "/chrome-bridge/ping"
WSPath         = "/chrome-bridge/ws"
ServerName     = "krow-browser-bridge"
ProtocolVersion= "1.0"
WSCloseAuthFailed = 4401

PingSignature  = hex(sha256(PingClientID + ":" + PingSalt))
```

必须遵守：

1. `GET /chrome-bridge/ping` 校验 `X-Kro-Client-Sig == PingSignature`；`HEAD` 不校验签名，用于探活。
2. ping 响应 JSON 字段名严格为 `ok / server / instanceId / protocolVersion / wsPath / token`（camelCase）。
3. `token` 必须**每个进程重新生成一次**（UUID），WS 连接时校验 `?token=`；错误 token 升级后以 close code `4401` 关闭。
4. WS 帧为 JSON 文本；命令信封字段严格为 `type / id / session_id / timestamp / payload.tool / payload.arguments`。
5. 扩展回包为 `{type:"result", id, payload}` 或 `{type:"error", id, payload:{message, code?}}`。
6. 命令超时默认 **30 秒**；断线时立即让所有等待中的命令失败，不要干等超时。
7. `browser_id` 在扩展 `hello` 前是临时值，`hello` 后必须用扩展上报的稳定 id 重新索引。
8. `page_id` 由本服务生成，对应 `(browser_id, tab_id)`；tab 更新时复用同一个 `page_id`，tab 关闭时删除。
9. 发给扩展的每个动作参数里都必须带 `browser_id / page_id / tab_id`（参考实现如此）。
10. 动作 tool 名严格为 `browser_*`，详见 `HANDOFF.md` 动作表。

## 5. MCP 工具暴露要求

v1 推荐暴露**单个工具** `browser_bridge`，参数与参考实现一致：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `action` | string（枚举） | 见下 |
| `browser_id` | string | `extension_status` / `list_sessions` 之外都需要 |
| `page_id` | string | 操作具体 tab 的动作需要 |
| `url` | string | `open_tab` |
| `active` | boolean | `open_tab` 是否前台，默认 true |
| `index` | number | 最近一次 `read_state` 的编号 |
| `text` | string | `type` 的输入内容 |
| `key` | string | `press` 的按键 |
| `x` / `y` | number | `scroll` 的偏移，正 y 向下 |
| `timeout_ms` | number | `wait_for`，默认 10000 |
| `include_html` | boolean | `extract` 是否返回 outerHTML |
| `script` | string | `execute_script` 的 JS |

`action` 取值：

```text
extension_status / list_sessions / list_pages / open_tab / focus_page /
close_tab / read_state / click / hover / dblclick / rightclick / type /
press / scroll / wait_for / go_back / reload / extract /
describe_element / execute_script
```

要求：

- 工具结果以 JSON 文本返回，保留扩展原始 payload。
- 单次结果超过 **32 KiB** 时截断并返回明确的 `truncated` 标记（参考实现 `capBridgeData`）。
- 参数错误、扩展未连接、`page_id` 失效等要返回可读错误，不要让 MCP 进程崩溃。
- 不做截图相关工具：**bridge 协议没有 screenshot 动作**。

如果后续要拆成多个细粒度工具，必须保留一个能完成全部 action 的入口，避免能力缺失。

## 6. 行为纪律（沿用参考实现）

任何浏览器任务的顺序：

1. `extension_status` → `ready=false` 立即停止并告诉用户“扩展未连接”，不要猜。
2. `list_sessions` → 拿 `browser_id`。
3. `list_pages` → 优先复用用户已经打开的 tab；需要时 `focus_page`。
4. 需要新页时 `open_tab`。
5. `read_state` → 拿到编号。
6. 按编号 `click / type / press / scroll`。
7. **每次操作后重新 `read_state`**；DOM 一变编号立即作废。
8. 不主动 `close_tab`，除非用户明确要求。

硬性规则：

- 登录、验证码、短信/邮箱验证、支付、“同意条款”**一律交还用户手动完成**，不要替用户点。
- 不要对用户已登录的敏感网站做超出请求范围的操作。
- `execute_script` 必须遵守：单行无换行、IIFE + 显式 `return`、只用单引号、返回体控制在 KB 级；返回 `null` 一次先 `wait_for` 重试，仍失败就停下报告。
- `page_id not found` 不要盲重试，重新 `list_pages`。
- 扩展重连后 `session_id / browser_id` 可能变化，重新 `list_sessions`。

## 7. 安全边界

- 本服务等于把用户浏览器的控制权交给本地 Claude Code，**只能监听 `127.0.0.1`**。
- 不记录、不上传 Cookie、页面正文、登录凭证；日志只记会话/动作元信息。
- 不实现任意 HTTP 代理、不转发到外部网络。
- 用户明确拒绝或要求停止时，立即停止操作。
- 运行期间避免同时运行其他占用 `17323` 的 bridge 服务端，否则会端口冲突。

## 8. 开发与测试命令（已可用）

```bash
npm install          # 安装 ws / @modelcontextprotocol/sdk
npm start            # 启动 MCP server（由 Claude Code 通过 stdio 拉起）
npm test             # 协议级测试（模拟扩展，无需真实浏览器）
```

注册到 Claude Code（用户级，任意项目可用）：

```bash
claude mcp add --scope user kro-bridge -- node "<path-to-repo>/server.js"
```

把 `<path-to-repo>` 换成仓库的绝对路径。注册后需要重启 Claude Code 会话才会加载 MCP 工具。

## 9. 完成标准

- [x] `curl -H "X-Kro-Client-Sig: <签名>" http://127.0.0.1:17323/chrome-bridge/ping` 返回正确 JSON。
- [x] 用户 Edge 里的扩展显示 **Connected**（端口 Auto detect 或手动 17323）。
- [x] MCP 工具列表里能看到 `browser_bridge`，`extension_status` 返回 `ready=true`。
- [x] 能完成 `list_sessions → list_pages → open_tab → read_state → click/type → extract` 的真实闭环。
- [x] 模拟扩展的自动化测试通过（43/43）。
- [x] 断线、错误 token、端口占用、扩展未连接都有清晰错误。
- [x] README 写清楚启动、注册、测试和已知限制。

## 10. 参考实现

协议细节以参考实现为准；参考实现的源码不随本仓库分发。
