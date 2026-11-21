# fcptool 使用说明（Final Cut Pro 13.0）

> 调研日期：2026-11-20。环境：macOS 27.0.1 · Final Cut Pro 13.0 (build 460023) · catalog 1220。
> 本文所有行为均在本机实测；Apple 目前**没有**发布 fcptool 的官方文档（Apple Support / developer.apple.com 均无页面，FCP 13.0 release notes 只写了 "Updates FCPXML to version 1.15"）。命令清单来自 `fcptool help <subcommand>` 的完整递归抓取，原始输出见 `research/fcptool-help-raw.txt`。

## 1. 基本信息

| 项 | 值 |
|---|---|
| 位置 | `/Applications/Final Cut Pro.app/Contents/MacOS/fcptool`（不在 PATH 上） |
| 架构 | Universal（arm64 + x86_64），Swift ArgumentParser 程序 |
| 沙盒 | App Sandbox，但带 `temporary-exception.files.absolute-path.read-write = /`，实际可读写任意绝对路径 |
| 版本 | `fcptool --version` → `Final Cut Pro version: 13.0 (460023) / Catalog version: 1220 / Oldest supported catalog version: 730` |
| 机器可读输出 | 每个命令都支持 `--json`（成功结果为 JSON；**错误仍是纯文本**） |
| 详细日志 | `-v/--verbose` 把状态/警告/进度写到 stderr |
| 帮助结构 | `fcptool --experimental-dump-help` 输出整棵命令树的 JSON（ArgumentParser 内置） |

全局用法：`fcptool [--version] [--verbose] [--json] <subcommand>`，`--json`/`-v` 也可以放在子命令后面。

## 2. 命令参考（共 12 个子命令，4 组）

### library
| 命令 | 用法 | --json 成功输出 |
|---|---|---|
| `library info <path>` | 库信息（**不打开 catalog**，库在 FCP 中打开时也能用） | `{catalog:{catalogVersion,catalogVersionBase}, library:{name,libraryType,location,creationDate,modificationDate}, openability:"compatible"}` |
| `library new <path>` | 新建空库（会自动带一个以当天日期命名的事件，如 `11-20-26`） | `{path}` |
| `library settings <path> [选项]` | 不带选项＝读取；带选项＝修改 | 读：`{backupPolicy:{policy}, cacheLocation:{policy}, colorProcessingMode, mediaLocation:{policy}, motionContentLocation:{policy}}`；改：`{changes:[{setting,from,to}]}` |
| `library update <path>` | 把库升级到当前 catalog 版本（不可逆，旧版 FCP 将无法打开） | `{path}` |

`library settings` 选项：
- `--color-processing-mode standard-gamut-sdr | wide-gamut-hdr | legacy-wide-gamut`（JSON 中显示为 `standardGamutSDR` / `wideGamutHDR` …）
- `--media-location project | <path>`、`--cache-location project | <path>`
- `--motion-content-location project | templates`（JSON：`motionTemplatesFolder`）
- `--backup-policy none | default | <path>`（JSON：`noBackups` / `finalCutBackupsFolder`）
- `-u/--update`：打开时自动升级旧库

### event
| 命令 | 用法 | --json 成功输出 |
|---|---|---|
| `event list <path> [-u] [--no-headers]` | 列出事件 | `{events:[{name, modified, clipCount, timelineCount, stillsCount, audioCount}]}` |
| `event new <path> --name <name> [-u]` | 新建事件（每次一个） | `{name}` |
| `event copy --name <n> --from <lib> --to <lib> [媒体选项] [-u]` | 在库之间复制事件（每次一个） | `{name}` |

`event copy` 媒体选项（值均为 `true|false`）：`--without-media`、`--include-original-media`、`--include-optimized-media`、`--include-proxy-media`、`--copy-external-media`。

### xml
| 命令 | 用法 | --json 输出 |
|---|---|---|
| `xml validate <path>` | 按文档声明的版本对 DTD 校验 `.fcpxml` 或 `.fcpxmld` | `{valid, version, errors:[string]}`；**无效时退出码 1 但 stdout 仍是 JSON** |
| `xml import <fcpxml> (--new <lib> \| --into <lib>) [--conflict-resolution cancel\|keep-both\|replace] [-u]` | 导入到新库/已有库 | `{warnings:[]}` |
| `xml export <lib> --output <file.fcpxml\|bundle.fcpxmld> [--dtd-version 1.15\|1.14\|1.13] [--metadata-view <name>] [-u]` | **导出整个库**（无法只导出单个项目/事件） | `{path}` |
| `xml versions` | 可导出的 DTD 版本 | `{default:"1.15", versions:["1.15","1.14","1.13"]}` |

- `--conflict-resolution` 默认 `cancel`：遇到"同一项目但内容不同"即中止，库保持不变。
- 输出扩展名决定格式：`.fcpxml` 单文件，`.fcpxmld` 为包（内含 `Info.fcpxml`）。
- FCP 内置 DTD：`Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources/FCPXMLv1_0.dtd … FCPXMLv1_15.dtd`（可校验 1.0–1.15，但只能导出 1.13–1.15）。

### metadata-view
| 命令 | --json 输出 |
|---|---|
| `metadata-view list [--no-headers]` | `{viewSets:[{name, builtIn, properties}]}`；内置 13 个：Basic, General, Extended, Audio, EXIF, IPTC, Settings, HDR, 3D, DPP Media, MXF, Live Multicam, DPP Editorial/Services |

## 3. 实测行为（文档里没有，但封装时必须知道）

### 3.1 性能
- **每次调用固定 ~2.2–2.5 s**（`real 2.21 / user 1.40 / sys 1.04`），即使是 `--version`。原因是进程启动时加载 FCP 的 Flexo 核心框架。实际耗时几乎与操作无关，**调用次数就是成本**。
- 无状态命令（versions / metadata-view / validate）可以并行，3 个并发 ≈ 2.9 s。
- 不同库的命令可以并行，2 个并发 ≈ 2.9 s。
- 用 `xmllint --dtdvalid` + FCP 自带 DTD 校验同一文件只需 **5–50 ms**，结论与 `fcptool xml validate` 一致（同为 libxml2 消息），而且多了行号。注意 DTD 路径中的空格要按 URL 编码（`file:///Applications/Final%20Cut%20Pro.app/...`），否则 xmllint 报 `Could not parse DTD`。

### 3.2 锁与并发
- 库内有 `.lock`、`.lock-info`（plist：hostname/user/FFFileLockIdentifier）、`.lock-dir`。
- **同一个库并发打开会失败**：4 个并发 `event list` 只有 1 个成功，其余报 `Error: Library permissions error: <path>`（退出码 1）。
- **库在 Final Cut Pro 中打开时**：除 `library info` 外，所有需要打开 catalog 的命令都报同样的 `Library permissions error`。fcptool 不会"抢锁"，也不会损坏库。
- FCP 对每个打开的库都持有 `<lib>/.lock` 的文件描述符，所以 `lsof -F pcn <lib>/.lock`（~100 ms）就能判断"谁占着库"，无需 2 s 的 fcptool 调用。
- 读操作也会改写文件时间戳（`event list` 会更新各事件 `CurrentVersion.fcpevent` 的 mtime），写操作会在 stderr 打印 NSLog：`Attempting to restore library "A"... / Restore of library "A" succeeded.`

### 3.3 退出码与错误
| 场景 | 退出码 | 输出（stderr） |
|---|---|---|
| 成功 | 0 | stdout 为 JSON |
| 库被占用 / FCP 打开中 | 1 | `Error: Library permissions error: <path>` |
| 路径不存在 | 1 | `Error: The document is not a FCP library: <path>` + NSCocoaErrorDomain Code=260 |
| `library new` 目标已存在 | 1 | `Error: Unsupported library location open: <path>` |
| 参数值非法 | 1 | `Error: Invalid setting value 'foo'. Valid values: …` |
| 事件不存在 | 1 | `Error: Library event with name X was not found` |
| FCPXML 无效 | 1 | stdout：`{"valid":false,"errors":[…]}` |

`--json` 不影响错误格式：错误永远是 `Error: …` 纯文本，需要自行分类。

### 3.4 能力边界
- 只能做**库级**操作：库/事件/设置/FCPXML 进出。**不能**直接编辑时间线、添加片段、渲染或导出影片（导出影片需 Compressor 或 FCP 本体）。
- 修改项目的唯一途径：`xml export` → 编辑 FCPXML → `xml validate` → `xml import --conflict-resolution replace|keep-both`。
- `event new` / `event copy` 一次只处理一个事件。
- 第三方逆向（fcp.cafe，未经验证）称二进制里还编译了 `timeline`、`access` 两组命令但未注册，当前版本不可用。

## 4. FCPXML 1.15（FCP 13）
Apple 只说明"更新到 1.15"。据 fcp.cafe 的 DTD 比对（未经 Apple 证实）：新增 `adjust-natural-motion-blur`、`mask-semantic`；锚定项新增 `flags` 属性；`pan-rect` 新增 `interp`；`keyframe interp` 增加 hold / bezier / passthrough；`conform-rate`/`timeMap` 的 `frameSampling` 增加 `vsa-motion-blur`。1.15 文档不能被 FCP 12.x 读取，需要兼容时用 `--dtd-version 1.14/1.13` 导出。

## 5. 对 MCP 封装的设计结论
1. **减少进程数**是第一优化目标 → 合并调用（inspect 一次拿 info+settings+events）、缓存、批处理。
2. **同库串行、跨库并行** → 每个库一个 FIFO 锁，再加全局进程池上限。
3. **不依赖 fcptool 的快路径**：DTD 校验（xmllint）、FCPXML 解析、库发现（Spotlight）、占用检测（lsof）。
4. **错误要结构化**：把纯文本错误映射为稳定错误码 + 给 Agent 的修复提示。
5. **写操作不可中断**：客户端取消时只杀只读命令，写命令跑完，避免库写到一半。
