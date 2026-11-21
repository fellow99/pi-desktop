# 301 — 中枢服务同步（sync-daemon 内嵌）技术实现方案

## 1. 技术上下文

### 1.1 运行时环境

- Electron **43.7.9**（主进程 = Node ≥22.19 环境）、Electron Forge 7.11.2 + plugin-vite、npm（`package-lock.json`）。
- 内嵌 pi-web：主进程进程内 `startServer`（`host.ts`），`127.0.0.1:<动态端口>`，
  鉴权 = `PI_WEB_AUTH_USERNAME:pi` + `PI_WEB_PASSWORD`（`resolvePassword()` 每启动随机，env 可固定）。
- 会话数据：`PI_CODING_AGENT_DIR`（`resolveAgentDir()`：shared=`~/.pi/agent`，app=`<userData>/pi-agent`）。

### 1.2 依赖

| 包 | 版本 | 说明 |
|---|---|---|
| `@pi-agent-hub/sync-daemon` | `0.1.0`（固定） | daemon CLI：`dist/main.js run [--config <path>] [--once]` |
| `@pi-agent-hub/sync-plugin-pi-web` | `0.1.0`（固定） | 插件（kind=`pi-web`）：bin `dist/main.js`，JSON-RPC/stdio |

两包 `engines.node >= 22.19`，`type: module`，均 publish 于 npm registry（✅ 已核实）。
daemon 的 `PluginManager` 从其自身包目录向上找 `node_modules/@pi-agent-hub/sync-plugin-pi-web`
（✅ `plugin-manager.ts` 解析逻辑），故两包同为 pi-desktop 的 dependencies 即可被 daemon 发现，
运行期无需 npm install（`pluginInstall: false`）。

## 2. 宪法合规检查

| 项 | 结论 |
|---|---|
| 数据面零 IPC 原则（108） | 托盘「设置」项点击为纯主进程动作（建窗），不经 IPC ✅ |
| 渲染安全（104） | 设置窗口 sandbox + contextIsolation + 独立最小 preload；仅 3 个受控通道 ✅ |
| 配置目录 | 需求指定 `~/.pi-desktop/`（非 userData）——新增独立配置根，不动 `settings.ts` 现有职责；写入 0600 ✅ |
| 生命周期（110/111） | daemon 子进程纳入退出链（will-quit 停止）✅ |
| 密钥卫生 | 令牌/密码仅 0600 文件与进程 env；日志脱敏 ✅ |
| 类型/错误处理 | 无 `as any`/`@ts-ignore`/空 catch；全部 try/catch 记日志 ✅ |

## 3. 研究结论

### 3.1 关键决策与理由

- **D1：daemon 以子进程运行（`process.execPath` + `ELECTRON_RUN_AS_NODE=1`），不在主进程内嵌 `Daemon` 类**
  （✅ 已核实 `plugin-manager.ts:69` `RpcClient({command: process.execPath, ...})` 且不传 env）。
  若 daemon 在主进程内跑，插件子进程将以 Electron 主进程身份/缺 `ELECTRON_RUN_AS_NODE` 拉起 → 打包态
  （`OnlyLoadAppFromAsar` / `RunAsNode=false` fuse）直接不可用；且进程隔离使 daemon 崩溃不拖垮主进程，
  「重启模块逻辑」= kill + respawn 天然干净。代价：主进程↔daemon 状态走 control API 文件（D3）。
- **D2：打包构建 `RunAsNode` fuse 改为 `true`**
  （现状 `false` → 打包态 `ELECTRON_RUN_AS_NODE` 被忽略）。先例：`host.ts` sidecar 模式
  （`PI_DESKTOP_HOST_MODE=spawn`）同样依赖该 env，打包态同样失效（现存一致缺陷）。
  安全权衡：允许 `pi-desktop.exe <script>` 以 node 运行——与 Electron 默认 fuse 状态一致，
  属已知取舍；本需求 daemon 链路硬依赖它。dev 态 forge start 不打 fuse，行为本就可用。
- **D3：状态经 daemon 自带 control API 取得**
  （✅ `control.ts`：随机端口监听 127.0.0.1，`pluginRoot/daemon-control.json` 写 `{port,token}` 0600，
  `GET /local/status` Bearer 鉴权）。主进程轮询（窗口打开时 ≤3s），失败置红。
- **D4：配置文件 = 标准 SyncDaemonConfig + 顶层 `enabled`**
  （✅ `config.ts` `loadConfig` 只校验必填字段，不拒未知字段）。`~/.pi-desktop/sync-daemon.json`。
- **D5：设置窗口用 extraResource 静态目录 + 独立 preload**
  沿用 `tray.ts iconPath()` 的双态解析（dev：`app.getAppPath()/resources`；打包：`process.resourcesPath`）。
  forge `extraResource` 增加 `'resources/settings/**'`；vite 增加第二个 preload 入口
  `src/preload/settings.ts`（产物 `.vite/build/preload-settings.js`）。
- **D6：不迁移、不读写 `~/.pi-agent-hub/`**（本机独立 daemon 数据），`pluginRoot` 隔离到
  `~/.pi-desktop/sync-daemon`（control 文件 / 日志 / 插件工作区互不干扰）。
- **D7：托盘只去「会话目录」项**；IPC `pi-desktop:open-session-dir` 与 preload 方法保留（上游 pi-web UI 依赖）。

### 3.2 上游/参考核实（✅ / 🔶 / ⬜）

| 结论 | 标记 |
|---|---|
| `@pi-agent-hub/sync-daemon@0.1.0` / `sync-plugin-pi-web@0.1.0` 已 publish（`npm view`） | ✅ |
| daemon CLI：`run [--config <path>] [--once]`（`main.ts`） | ✅ |
| 插件 options：`server` / `agentDir`（默认 `~/.pi/agent`）/ `password`（Basic `pi:<pw>`）/ `cwd`（`plugin.ts`） | ✅ |
| 插件 collect 读 `<agentDir>/sessions` 磁盘（与 pi-web 同源），deliver 走 pi-web HTTP API | ✅ |
| control server：`/local/status`、`/local/quit`、`/local/logs`、随机端口 + `{port,token}` 文件（`control.ts`） | ✅ |
| `sync-plugin-pi-web` 的 deliver 走 `POST /api/agent/[id]`；字段映射上游标 ⬜ 待真机校准 | 🔶（本轮测试聚焦 collect/上行，deliver 仅冒烟） |
| daemon 侧「完整重试」上游仍为 TODO（README 现状） | ⬜（不影响本需求验收） |

### 3.3 本轮已确认的决策（2026-11-21）

| # | 决策 | 理由 / 影响 |
|---|---|---|
| D8 | 状态灯 = **进程级**（存活 + control 可达），**不**探测 hub 连通性 | 上游 `/local/status` 不暴露 SSE 状态；壳侧探 hub 会引入额外出网依赖与误红风险。局限已写入 spec FR-301-021a |
| D9 | 令牌**明文** + `0o600` + 原子写，不做加密 | 上游 `loadConfig` 只认明文；加密必再落一份明文，收益为零。Windows 上 chmod 无效属已知 |
| D10 | 端到端测试使用**专属 host 身份**（hub 新增 token `win-pi-desktop`） | hub 的 host 身份由 `daemonTokens[].hostName` 决定；复用 `phk_debian_pi_007` 会覆盖真实 debian-pi 的 agent 行 |
| D11 | 设置窗口 CSS **内联**在 `index.html`，不建 `style.css` | 同 `file://` 加载面最小化；后续 tab 增加时再考虑拆分 |
| D12 | `running` 文案从「已连接」改为「**运行中**」 | 与 D8 的进程级语义一致，避免把「进程在跑」说成「已连接」 |
| D13 | 保留既有未提交实现作为本轮基座，不重写 | 逐条核对与需求一致（托盘/设置窗口/四字段/状态灯/配置落盘/启动编排/退出链） |
| D14 | 文档一致性只修本需求造成的口径漂移（README 301 表行、108 托盘描述、STRUCTURE、工程规划 §5.3） | `AGENTS.md` 的 `npm run check` 不存在属既有缺陷，改法有分歧，仅在交接文档记录 |

## 4. 数据模型

### 4.1 实体

`~/.pi-desktop/sync-daemon.json`（落盘形态，示例）：

```jsonc
{
  "enabled": true,
  "hub": { "url": "http://127.0.0.1:12380", "token": "<daemon token>" },
  "host": { "name": "DESKTOP-XXX" },
  "plugins": ["@pi-agent-hub/sync-plugin-pi-web"],
  "pluginRoot": "~/.pi-desktop/sync-daemon",
  "pluginInstall": false,
  "pluginAllowlist": ["@pi-agent-hub/*"],
  "agents": {
    "pi-web": {
      "instances": [{ "name": "default" }],
      "options": { "server": "http://127.0.0.1:41731", "agentDir": "C:\\Users\\fello\\.pi\\agent", "password": "<运行时注入>" }
    }
  }
}
```

表单视图 `SyncDaemonSettings = { enabled, hubUrl, hostName, hubToken }`（其余字段壳固化）。

### 4.2 状态机

```
                 enabled=false
        ┌─────────────────────────────────────┐
        ▼                                     │
  disabled ──(应用/启动, enabled=true)──► starting ──(control 可达)──► running(绿)
        ▲                                     │                          │ ▲
        │            (配置缺失/校验失败/拉起失败) │          (进程退出/control 不可达) │
        └─────────────────────────────────────┴────────► stopped(红) ────┘
                                                         (再「应用」→ starting)
```

### 4.3 校验规则

- `enabled=true`：`hubUrl` 必须 `new URL()` 可解析且 scheme ∈ {http,https}；`hostName`、`hubToken` 非空（trim）。
- `enabled=false`：字段不做强制校验（允许保存半成品）。
- 文件解析失败 / 缺必填 → 视为「配置缺失」：不启动 daemon，日志 WARN，状态 `stopped`。

## 5. 接口契约

### 5.1 提供接口（新增模块导出，主进程内）

`src/main/sync-daemon.ts`：

```ts
export type SyncStatus =
  | { state: 'disabled' }
  | { state: 'starting' }
  | { state: 'running' }
  | { state: 'stopped'; reason?: string };

export function loadSyncConfig(): Promise<{ enabled: boolean; settings: SyncDaemonSettings; raw: SyncDaemonFile } | null>;
export function saveSyncConfig(settings: SyncDaemonSettings): Promise<void>;   // 校验 + 原子写（含运行时 options 刷新由调用方负责）
export function startSyncDaemon(opts: { server: string; agentDir: string; password: string }): Promise<void>; // 写 options → spawn
export function stopSyncDaemon(): Promise<void>;
export function applySyncConfig(settings: SyncDaemonSettings, opts: { server: string; agentDir: string; password: string }): Promise<void>; // 应用按钮全链路
export function getSyncStatus(): SyncStatus;
export function onSyncStatusChange(listener: (s: SyncStatus) => void): () => void;
```

IPC（preload `window.piDesktopSettings`）：

| 通道 | 方向 | 载荷 |
|---|---|---|
| `pi-desktop:settings:sync:get` | invoke | → `{ settings: SyncDaemonSettings; status: SyncStatus }` |
| `pi-desktop:settings:sync:apply` | invoke | `{ settings: SyncDaemonSettings }` → `{ ok: true }` / throw Error(可读消息) |
| `pi-desktop:settings:sync:status` | main→renderer send | `{ status: SyncStatus }` |

### 5.2 消费接口（本模块依赖）

- `host.ts`：`runtime.server.{url, port, password}`、`runtime.agentDir`（boot 就绪后提供）。
- `tray.ts`：`TrayActions` 增加 `openSettings(): void`（移除 `openSessionDir`/`hasAgentDir` 依赖）。
- `index.ts` `boot()`：`setStage('就绪')`/`refreshTrayMenu` 后调 `startSyncDaemon`（try/catch，不阻塞）。
- 退出链（`lifecycle`/`will-quit`）：`await stopSyncDaemon()`。

### 5.3 daemon 子进程契约

- 命令：`spawn(process.execPath, [daemonBin, 'run', '--config', configPath], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore','pipe','pipe'], windowsHide: true })`
  （`daemonBin` = `require.resolve('@pi-agent-hub/sync-daemon/dist/main.js')`，dev/打包均落在 asar node_modules 内，
  node 身份下可执行 asar 内 JS ✅ Electron fs 补丁）。
- stdout/stderr → 壳日志（`[sync-daemon:out/err]`，脱敏：过滤含 token/password 的行不回显全文）。
- 退出事件 → 状态 `stopped`（记录 code/signal）；若预期存活（enabled 且未主动 stop）记 WARN。

## 6. 文件与落点

| 文件 | 动作 |
|---|---|
| `src/main/sync-daemon.ts` | **新增**：配置读写 + 子进程生命周期 + 状态机 + control 轮询 |
| `src/main/settings-window.ts` | **新增**：设置窗口（单例）+ 3 条 IPC + 状态推送定时器 |
| `src/preload/settings.ts` | **新增**：设置窗口 preload（`piDesktopSettings` API） |
| `resources/settings/index.html` / `app.js` | **新增**：原生 HTML/CSS/JS（多 tabs + 中枢服务表单）；CSS 以 `<style>` **内联**在 `index.html`（不另建 `style.css`：设置页只加载本地静态文件，内联可减少 `file://` 下的加载失败面） |
| `src/main/tray.ts` | **改**：移除 `agentDirItem`/`hasAgentDir`/`openSessionDir`；新增「设置」项 |
| `src/main/index.ts` | **改**：`trayActions()` 换 `openSettings`；`boot()` 插入 daemon 启动；退出链 stop |
| `forge.config.ts` | **改**：`RunAsNode: true`；`extraResource` + `'resources/settings/**'`；vite build + settings preload 入口 |
| `package.json` | **改**：dependencies + `@pi-agent-hub/sync-daemon@0.1.0`、`@pi-agent-hub/sync-plugin-pi-web@0.1.0`（固定版本） |
| `specs/README.md` / `SPECS_CHECKLIST.md` | **改**：3XX 段定义（跨端需求模块）+ M 行 |

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| asar 内 ESM `dist/main.js` 在 node 身份下执行 | Electron 的 fs 补丁对 asar 透明（node 身份同样生效）；测试项 TC 覆盖 dev+打包；若打包态失败，退路 = 把两包 dist 挪入 extraResource 并在配置 `plugins` 用 `path` 形态（⬜ 备选） |
| `RunAsNode: true` 安全面扩大 | plan §3.1 D2 已记录权衡；与 sidecar 模式既有依赖一致 |
| 密码每启动变化导致 daemon 内 deliver 401 | 每次（重）启动 daemon 前刷新 options.password 落盘（§4.1）；pi-web 密码本身随 app 生命周期 |
| 双 daemon 并存（本机独立 `~/.pi-agent-hub` daemon 也在跑） | `pluginRoot` 隔离（D6）；两者 hub 注册为不同 host（host.name 不同），不冲突 |
| 状态轮询读到上一代 control 文件（重启间隙） | 轮询前先校验本进程持有该子进程且存活；control 请求失败 → 红 |

## 8. 测试策略

见 `test-cases.md`：单元层（配置读写/校验/状态机，typecheck + 手工脚本）+ 集成层
（dev 态 `npm start` + Docker hub 端到端 + Playwright/CDP 驱动设置窗口）。

### 8.1 自动化取证方式（本轮）

| 层 | 做法 |
|---|---|
| 类型 | `npx tsc --noEmit`（本仓无 `npm run check`，CI 口径即 typecheck） |
| 设置窗口 UI | `electron-forge start -- --remote-debugging-port=9222` 后，以 Node inspector 附加主进程、用**真实已注册的 IPC** 另开一个设置窗口（复用 `.vite/build/preload-settings.js` + `resources/settings/index.html`），再用 Playwright `connectOverCDP` 驱动表单 |
| 主进程 / daemon | 日志 `<userData>/logs/pi-desktop-<date>.log` + 子进程 PID + control API `GET /local/status` + 配置文件比对 |
| 端到端上行 | hub console（`http://127.0.0.1:12380/hub/`，admin）里核对 `win-pi-desktop` host 与其会话 |
| 打包态 | `npm run package` 后启动打包产物，验证 `RunAsNode` fuse + asar 内 daemon 可拉起 |

> 托盘菜单本身的**点击**需人工/UI 自动化，本轮以「源码 + review」核对菜单项，点击路径在交接文档中标为待人工确认。

## 9. 交付与回滚

- 交付：pi-desktop 单仓提交（feat 一条 + 规格文档一条）；父工程仅 submodule 指针推进（无父工程 spec）。
- 回滚：`enabled=false` 即停用（无需卸载）；代码回滚 = revert 对应提交。
