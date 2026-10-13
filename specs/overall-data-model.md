# overall-data-model.md — 数据模型

> pi-desktop 全局数据实体与状态定义（2026-10-12）。
> 本工程是**桌面壳**：业务数据（会话、消息、文件、工具调用、终端、模型与凭据）**完全在 `pi-web` / `pi` 侧**，
> 壳层只持有少量装配期实体与状态。本文档只记录壳层自己的东西。
> 标记口径：`✅ 已核实`（本工程源码，带路径）· `⬜ 待验证`。字段命名以**源码为准**（[constitution.md](./constitution.md) §4.4）。

---

## 1. 实体清单

### 1.1 `PiWebServerHandle`（宿主句柄）

主进程持有的内嵌服务端句柄。**目标契约**（[overall-spec.md](./overall-spec.md) FR-000-010 / FR-000-011 / FR-000-005）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `mode` | `'in-process'` \| `'in-process-next-server-api'` \| `'spawn'` | 宿主形态；前两者是进程内（导出探测命中不同形状），`spawn` 为登记的 sidecar 回退 B（需显式开启） |
| `port` | `number` | 实际绑定端口（`127.0.0.1` + 随机高位端口） |
| `url` | `string` | 渲染层同源加载地址：`http://127.0.0.1:<port>/` |
| `close()` | `() => Promise<void>` | 幂等关闭（配合 `SHUTDOWN_DEADLINE_MS` 的强退上限） |

> **as-built**（✅ `src/main/host.ts:39-49`）：类型名为 `PiWebServer`，字段为
> `mode` / `hostname` / `port` / `url` / **`password`** / `close()` —— 比目标契约多两个字段：
> `hostname`（可断言 `=== '127.0.0.1'`，即 §11.4 S3 的守卫落点）与 `password`（凭据注入的输入，**仅在主进程内存中**）。
> 命名差异按「源码即真理」以代码为准，后续如需外部契约再统一。

### 1.2 `ArtifactState`（产物状态）

`pi-dist.tar.gz` 的定位与解压幂等状态。**目标契约**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `archivePath` | `string` | 归档路径：打包态 `process.resourcesPath/pi-dist.tar.gz`；开发态 `app.getAppPath()/pi-dist.tar.gz` |
| `expectedSha256` | `string` | 随包固化的期望归档哈希（与 marker 比对，**不是存在性判断**） |
| `markerPath` | `string` | 幂等 marker 路径（`<userData>/pi-dist.sha256`） |
| `piDistRoot` | `string` | 解压根目录（`<userData>/pi-dist`），即宿主 `dir` 参数 |

> **as-built**（✅ `src/main/artifact.ts:18-27`）：字段为 `archivePath` / `piDistRoot` / `markerPath` / **`nextEntry`**（已确认可用的 Next 入口文件），
> 而**期望哈希来自随包的 `pi-dist.version` 文件**（常量 `VERSION_NAME`，`src/main/constants.ts:16`）而非结构体字段；
> 比对语义不变（marker 内容 ≠ 期望值 → 重新解压）。⬜ 待验证：`pi-dist.version` 在 `collect-pi.mjs` 中的写入时机（脚本未建）。

### 1.3 `AgentDirMode`（数据目录模式）

| 取值 | 解析结果 | 含义 |
|---|---|---|
| `'shared'`（默认） | `os.homedir()/.pi/agent` | 与 `pi` CLI 共享凭据、会话、扩展、MCP、技能（Q6 的产品默认） |
| `'app'` | `<userData>/pi-agent` | 应用私有，隔离/企业场景退路 |

✅ 已核实 `src/main/settings.ts:21`；解析函数 `resolveAgentDir()`（`settings.ts:59-62`）。
**切换语义**：写设置后**必须重启应用**才生效（宿主启动早期就要用到该变量），**不支持进程内热切换**。

### 1.4 `ShellSettings`（壳层设置）

| 字段 | 类型 | 说明 |
|---|---|---|
| `version` | `1` | 设置结构版本（当前固定 `1`） |
| `agentDirMode` | `AgentDirMode` | 数据目录模式（默认 `'shared'`） |

✅ 已核实 `src/main/settings.ts:23-28`；持久化文件 `<userData>/pi-desktop-settings.json`
（常量 `SETTINGS_FILE_NAME`，`constants.ts:38`）；读取失败/非法值 → 回退默认并记 `logWarn`（不阻塞启动）。

### 1.5 `WindowState`（窗口状态）

| 字段 | 类型 | 说明 |
|---|---|---|
| `x` | `number?` | 上次窗口左上角 X（可能缺失） |
| `y` | `number?` | 上次窗口左上角 Y（可能缺失） |
| `width` | `number` | 宽度（默认 1200，最小 800） |
| `height` | `number` | 高度（默认 800，最小 600） |
| `isMaximized` | `boolean` | 是否最大化 |

✅ 已核实 `src/main/window-state.ts:20-25`；持久化文件 `<userData>/window-state.json`
（常量 `WINDOW_STATE_FILE_NAME`，`constants.ts:39`）。约束：写入防抖、取 `getNormalBounds()`、
多显示器可见性校验（不可见 → 回退默认位置）。

### 1.6 `SessionNotification`（通知事件）

通知模块消费的最小事件载荷。**目标契约**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionFile` | `string` | 触发消息所在会话文件（`<agentDir>/sessions/**/*.jsonl` 的绝对路径） |
| `sessionId` | `string` | 会话 id（从文件名/内容解析，用于同会话冷却去重） |
| `title` | `string` | 通知标题 |
| `timestamp` | `number` | 事件时间（用于冷却判定与去重） |

> **as-built**（✅ `src/main/session-watch.ts:19-24`）：类型名为 `AssistantMessageEvent`，字段为
> `sessionFile` / `sessionId` / `projectDir` / `text`；**没有 `title`/`timestamp` 字段** ——
> 标题由 `notifications.ts` 统一派生（`${PRODUCT_NAME} — 有新的助手回复`），
> 时间戳用 `Date.now()`（冷却表 `lastNotifiedAt`，✅ `notifications.ts:26-33`）。
> 语义等价（去重键 = `sessionId`），字段名以源码为准。

### 1.7 `UpdateCheckResult`（检查更新结果）

**目标契约**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | `'update-available'` \| `'up-to-date'` \| `'error'` | 三态；**没有**「下载中/安装中」态（半自动，Q5） |
| `latest` | `string?` | 远端最新版本号（`status = update-available` 时存在） |
| `url` | `string?` | 下载页地址（交给 `shell.openExternal`） |

> **as-built**（✅ `src/main/update-check.ts:15-21`）：额外含 `current`（当前版本，必填）与 `message`（错误说明）。
> 数据源默认 `https://api.github.com/repos/fellow99/pi-desktop/releases/latest`
> （常量 `DEFAULT_UPDATE_FEED`，`constants.ts:55`；超时 8 s，`constants.ts:56`）—— ⬜ 数据源最终归属待人工确认（工程规划 §11.3 第 2 条）。

### 1.8 其他壳层常量型实体（✅ `src/main/constants.ts`）

| 实体 | 值 | 说明 |
|---|---|---|
| 应用标识 | `APP_ID = 'com.fellow99.pi.desktop'`、`PRODUCT_NAME = 'Pi Desktop'` | Windows 通知归组 / macOS bundle id（⬜ 发布主体归属待确认） |
| 归档与 marker 名 | `ARCHIVE_NAME = 'pi-dist.tar.gz'`、`VERSION_NAME = 'pi-dist.version'`、`MARKER_NAME = 'pi-dist.sha256'` | 见 §1.2 |
| 就绪探测 | `READY_TIMEOUT_MS = 30_000`、`READY_INTERVAL_MS = 400`、`READY_PROBE_PATH = '/api/web-auth'` | 不解析 stdout（FR-000-015/016） |
| 凭据契约 | `PI_WEB_SESSION_COOKIE = 'pi_web_session'`、`PI_WEB_AUTH_USERNAME = 'pi'`、`PI_WEB_SESSION_MAX_AGE_SECONDS = 2592000` | **镜像上游** `pi-web/lib/web-auth.ts`，上游升级需复核 |
| 窗口尺寸 | 1200×800 / 最小 800×600 | 🔶 沿用 `dsh-desktop` |
| 通知与尾随 | `NOTIFICATION_COOLDOWN_MS = 10_000`、`SESSION_WATCH_INTERVAL_MS = 2_000` | 冷却去重 + 轮询兜底 |
| 退出 | `SHUTDOWN_DEADLINE_MS = 5_000` | 对齐上游 `PI_WEB_SHUTDOWN_DEADLINE_MS` 默认值 |

### 1.9 `ShellIpcContext`（壳层桥契约，✅ `src/main/windows.ts:22-45`）

preload 暴露的 `window.piDesktop` 四个动作（**只对 `file://` 文档**）：`getInfo()` / `openLog()` / `openSessionDir()` /
`checkForUpdates()` / `retry()` / `quit()`；`getInfo()` 返回 `productName / appVersion / electron / node / chrome / stage /
serverUrl / agentDir / piDistRoot / logFile`。**约束：该契约中不得出现任何业务数据字段**（FR-000-034）。

---

## 2. 状态机

### 2.1 宿主启动状态机（`src/main/index.ts` 的 `boot()`）

```
idle
 └─ boot() ──► booting
      ├─ [env]      环境装配失败 ──────────────────────────────► failed（阶段 + 原因可见）
      ├─ [artifact] 解压失败/哈希不符 ─────────────────────────► failed
      ├─ [server]   导出探测失败 / 监听失败 ───────────────────► failed（或按 PI_DESKTOP_HOST_MODE 切 spawn）
      ├─ [ready]    HTTP 轮询超时（30 s）──────────────────────► failed
      ├─ [auth]     凭据注入失败 ──────────────────────────────► failed
      ├─ [load]     loadURL 失败（did-fail-load）──────────────► failed
      └─ [done] ───────────────────────────────────────────────► ready
                                                                   │
   failed ──(loading 页「重试」/ __piDesktopHostError)──► boot()（幂等：先 closeWithDeadline 上一轮 server）
   ready  ──(before-quit)──► closing（停尾随 → closeWithDeadline(5 s) → destroyTray）──► exited
```

**不变式**：`booting` 期间的重复 `boot()` 被忽略（`runtime.booting` 守卫）；`failed` 必须携带阶段名与原因。

### 2.2 窗口生命周期状态机

```
created（frame:true，先加载壳层 loading 页 file://）
   ├─ loading: running ──(阶段推进)──► running ──(就绪)──► done
   │                                     └─(任一阶段失败)──► failed（显示阶段+原因+打开日志/重试/退出）
   ├─ ready-to-show ──► shown（避免白屏闪烁）
   ├─ 加载真实 URL（同源 http://127.0.0.1:<port>/）──► UI ready
   ├─ close ──(最近 60 s 有会话活动)──► 确认对话框 ──(仍然关闭)──► closed
   └─ closed ──► window-all-closed ──► app.quit()（关窗即退出）
                     │
     macOS: activate 且无窗口 ──► 重建窗口（复用已有 server；无 server 则重跑 boot）
```

### 2.3 数据目录模式切换状态机（`AgentDirMode`）

```
shared（默认，~/.pi/agent）
   └─(写 ShellSettings.agentDirMode='app')──► needs-restart（UI 提示「重启后生效」）
                                                 └─(重启应用)──► app（<userData>/pi-agent）
   反向同理；**不存在**运行中直接切换的路径
```

---

## 3. 数据边界

| 数据 | 归属 | 落点 | 壳层是否持有 |
|---|---|---|---|
| 会话、消息、工具调用、审批、用量/成本 | `pi-web` + `pi` agent | `<agentDir>/sessions/**/*.jsonl`（version 3 行式 JSONL） | ❌ 不持有；只**尾随读取**新增行用于通知 |
| 模型与凭据（API Key / OAuth） | `pi` | `<agentDir>/auth.json`（明文、上游写 `0600`）、`models.json` | ❌ 不读取、不缓存 |
| 扩展 / 技能 / MCP / 信任 | `pi` | `<agentDir>/{extensions,skills,mcp.json,trust.json,settings.json...}` | ❌ 只做**预置模板物化**（仅当文件不存在） |
| 文件与终端 | `pi-web` 路由 + 宿主进程 | 用户工作目录 | ❌ |
| 宿主产物（Next + 运行依赖） | 本工程构建期 | `<userData>/pi-dist`（由 `pi-dist.tar.gz` 解压） | ✅ 只持有路径与哈希 |
| 服务端句柄 / 端口 / 随机密码 | 本工程 | 仅主进程内存（不落盘、不入日志） | ✅ |
| 壳层设置 / 窗口状态 / 日志 | 本工程 | `<userData>/{pi-desktop-settings.json, window-state.json, logs/}` | ✅ |
| 业务 API 通道 | `pi-web` | 同源 HTTP `/api/*`（约 90 条路由）+ SSE `/api/agent/[id]/events` | ❌ **不经过 IPC、不经过壳层**（FR-000-034） |

**一句话**：壳层只持有「装配期状态」（句柄、路径、哈希、设置、窗口几何、通知去重表），
**业务数据全在 `~/.pi/agent`（或私有 agent 目录）与 `pi-web` 侧**；壳层既不做业务缓存，也不做数据代理。
