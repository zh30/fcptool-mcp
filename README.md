# fcptool-mcp

把 Final Cut Pro 13 自带的官方命令行工具 **fcptool** 封装成本地 MCP 服务，任何支持 MCP 的 coding agent（Claude Code、Codex、Grok CLI、Cursor、opencode……）都能直接操作 Final Cut Pro 的资源库、事件和 FCPXML。

- **标准协议**：stdio（默认）＋ Streamable HTTP（`--http`），每个工具同时返回 `structuredContent` 和 JSON 文本，带 `readOnlyHint/destructiveHint` 注解。
- **为性能设计**：fcptool 每次启动固定 ~2.3 s，本服务通过合并调用、变更感知缓存、批处理 DAG、同库串行/跨库并行、以及不走 fcptool 的快路径（DTD 校验 ~5–50 ms、FCPXML 解析、Spotlight 查找、lsof 占用检测）把调用次数降到最低。
- **对 Agent 友好**：稳定错误码 + 修复提示；FCPXML 可以直接内联传入；导出时一并返回解析后的时间线摘要。

fcptool 的完整调研见 [docs/fcptool-reference.md](docs/fcptool-reference.md)（命令、JSON 结构、错误、锁、性能实测）。

## 环境要求
- macOS + **Final Cut Pro 13.0+**（fcptool 位于 `Final Cut Pro.app/Contents/MacOS/fcptool`）
- Node.js ≥ 20
- 系统自带 `xmllint`（快速校验用；缺失时自动回退到 fcptool）

## 安装
```bash
git clone <this repo> fcptool-mcp && cd fcptool-mcp
npm install && npm run build
node dist/index.js --help
```
下文的 `/ABS/fcptool-mcp` 换成你的实际路径。用 nvm 的话，`node` 最好写绝对路径（`which node`），因为 GUI 客户端不一定继承你的 shell PATH。

## 接入各个 Agent

**Claude Code**
```bash
claude mcp add fcptool -s user -- node /ABS/fcptool-mcp/dist/index.js
```

**Codex CLI**（`~/.codex/config.toml`）
```toml
[mcp_servers.fcptool]
command = "node"
args = ["/ABS/fcptool-mcp/dist/index.js"]
```
或 `codex mcp add fcptool -- node /ABS/fcptool-mcp/dist/index.js`

**Grok CLI**
```bash
grok mcp add fcptool node -- /ABS/fcptool-mcp/dist/index.js     # 写入 ~/.grok/config.toml
grok mcp doctor fcptool                                         # 应显示 handshake OK / 14 tools
```

**Cursor**（`~/.cursor/mcp.json`）/ 其它 `mcpServers` 格式的客户端
```json
{ "mcpServers": { "fcptool": { "command": "node", "args": ["/ABS/fcptool-mcp/dist/index.js"] } } }
```

**opencode**（`opencode.json`）
```json
{ "mcp": { "fcptool": { "type": "local", "command": ["node", "/ABS/fcptool-mcp/dist/index.js"], "enabled": true } } }
```

**HTTP（多个 Agent 共享一个进程/缓存）**
```bash
node dist/index.js --http --port 8765     # http://127.0.0.1:8765/mcp ，只监听本机，带 Host 校验
claude mcp add --transport http fcptool http://127.0.0.1:8765/mcp
```

已在本机验证：
- Claude Code：headless 调用 `fcp_status` 返回真实数据
- Grok CLI：`grok mcp doctor` 显示 handshake OK（protocol 2025-11-25），发现 14 个工具；`grok -p` 无交互模式下由真实模型调用 `fcp_status`，返回 13.0 / 1.15·1.14·1.13 / 当前打开的库
- Codex CLI 0.171.0：`codex mcp add/list` 接受配置；`codex exec` 发现全部 14 个工具，并通过 MCP 实际调用 `fcp_status` 拿到真实结果（模型端使用本地模拟的 Responses API，因此不需要 OpenAI 凭证）
- MCP SDK 客户端：stdio 与 HTTP 均通过

## 工具

| 工具 | 作用 | fcptool 调用数 |
|---|---|---|
| `fcp_status` | 版本、catalog、可导出/可校验的 FCPXML 版本、元数据视图、FCP 是否运行及**打开了哪些库** | 0（启动时预热缓存） |
| `fcp_library_find` | 用 Spotlight（未索引目录回退遍历）查找 .fcpbundle，并标注是否被 FCP 打开 | 0 |
| `fcp_library_inspect` | 一次返回 info + settings + events；info 与其余并行；重复读取走缓存 | 0–3 |
| `fcp_library_create` | 新建库，可同时建多个事件、设置参数 | 1 + N |
| `fcp_library_settings` | 读取或修改库设置，返回 `{setting, from, to}` 变更列表 | 1 |
| `fcp_library_upgrade` | 升级 catalog（不可逆） | 1 |
| `fcp_event_list` / `fcp_event_create` / `fcp_event_copy` | 事件列表 / 批量新建 / 跨库复制（媒体选项、进度通知） | 1 / N / N |
| `fcp_xml_validate` | 按文档版本对 FCP 自带 DTD 校验，带行号；`engine: "fcptool"` 可走官方校验 | 0（快路径） |
| `fcp_xml_inspect` | 本地解析 FCPXML：格式、素材、事件、项目时长/时间码、主故事线、标记、关键词、效果、字幕文本 | 0 |
| `fcp_xml_import` | 路径或内联 XML 导入到新库/已有库；先做 DTD 校验，冲突策略 cancel/keep-both/replace | 1 |
| `fcp_xml_export` | 导出整库为 .fcpxml/.fcpxmld，**同时返回解析摘要**（`inspect: "timeline"` 返回片段级明细） | 1 |
| `fcp_batch` | 一次往返执行多达 100 个操作：涉及同一路径的按顺序执行，不同库并行 | Σ |

资源：`fcptool://reference`（本调研文档）、`fcpxml://dtd/{version}`（FCP 自带的 1.0–1.15 DTD，Agent 手写 FCPXML 前可读）。

### 典型工作流：让 Agent 改时间线
fcptool 不能直接编辑时间线，修改项目要走 FCPXML：
1. `fcp_xml_export { library, inspect: "timeline" }` → 拿到导出文件路径和时间线结构
2. Agent 编辑 XML（可读 `fcpxml://dtd/1.15` 对照结构）
3. `fcp_xml_validate { path }`（~50 ms，错误带行号）
4. `fcp_xml_import { path, into, conflictResolution: "replace" }`

## 性能设计
| 问题（实测） | 处理 |
|---|---|
| 每次调用固定 ~2.3 s | 合并调用、缓存、batch；能不调 fcptool 的都不调 |
| 同库并发 → 4 个里 3 个报 `Library permissions error` | 每库 FIFO 锁（多库操作一次性入队，不会死锁）；全局进程池（默认 cores/2，2–6） |
| 读操作也会改动库内文件 mtime | 缓存指纹在**本次调用之后**采集（几百 µs 的 stat），别人改过才会失效；本服务的写操作主动失效 |
| 库被 FCP 打开 | lsof 判断持有者：被 FCP 占用立即返回 `LIBRARY_LOCKED` + 提示；被其它进程短暂占用则退避重试 |
| 客户端取消 | 只读命令立即终止；写命令跑完，避免库写一半 |
| 校验要 2.3 s 且没有行号 | xmllint + 同一份 DTD，5–50 ms，带行号 |

## 错误码
所有失败返回 `isError: true` 和 `{error: {code, message, hint?, details?}}`：
`FCPTOOL_NOT_FOUND` · `LIBRARY_LOCKED` · `NOT_FOUND` · `ALREADY_EXISTS` · `INVALID_ARGUMENT` · `NEEDS_UPGRADE` · `VALIDATION_FAILED` · `TIMEOUT` · `CANCELLED` · `FCPTOOL_ERROR`

## 配置
| 环境变量 | 默认 |
|---|---|
| `FCPTOOL_PATH` | `/Applications/Final Cut Pro.app/Contents/MacOS/fcptool`，找不到时用 Spotlight 按 bundle id 查找 |
| `FCP_APP_PATH` | — |
| `FCPTOOL_MCP_MAX_PROCS` | cores/2（2–6） |
| `FCPTOOL_MCP_TIMEOUT_MS` | 600000 |
| `FCPTOOL_MCP_PREWARM` | 设为 `0` 关闭启动预热 |

## 安全约定
- 路径必须是绝对路径（或 `~/`），因为服务进程的 cwd 与 Agent 不同。
- 导出永不覆盖已有文件；`library_create` / `newLibrary` 不会覆盖已有路径。
- 导入默认 `conflictResolution: "cancel"`；默认不升级旧库（`autoUpgrade` 需显式传入）。
- 不会替你关闭 FCP 中打开的库。

## 测试
```bash
npm test     # 构建 + 单元测试 + 端到端测试（真实 fcptool，在临时目录里建库，不碰你的库）
```
端到端测试中"被 FCP 打开的库"一项只对该库执行会被拒绝的只读命令。

## 局限
- 能力上限即 fcptool：库/事件/设置/FCPXML 进出。不能渲染、导出影片、删除事件或直接控制 FCP 界面。
- `xml export` 只能导出整个库。
