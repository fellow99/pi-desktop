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
| `@pi-agent-hub/sync-daemon` | `0.1.1`（固定） | daemon CLI：`dist/main.js run [--config <path>] [--once]` |
| `@pi-agent-hub/sync-plugin-pi-web` | `0.1.1`（固定） | 插件（kind=`pi-web`）：bin `dist/main.js`，JSON-RPC/stdio |

两包 `engines.node >= 22.19`，`type: module`，均 publish 于 npm registry（✅ 已核实）。
daemon 的 `PluginManager` 从其自身包目录向上找 `node_modules/@pi-agent-hub/sync-plugin-pi-web`
（✅ `plugin-manager.ts` 解析逻辑），故两包同为 pi-desktop 的 dependencies 即可被 daemon 发现，
运行期无需 npm install（`pluginInstall: false`）。

## 2. 宪法合规检查

| 项 | 结论 |
|---|---|
| 数据面零 IPC 原则（108） | 业务数据仍只走同源 HTTP；设置表单是**壳能力**，经独立 `piDesktopSync`（`get`/`apply`）走 IPC ✅ |
| 渲染安全（104） | 设置 UI 位于 pi-web 页面内；桥只含两个同步动作，主进程逐次校验 `senderFrame` 属于内嵌 pi-web 源 ✅ |
| 上游改动（012） | pi-web 以**构建期幂等补丁**接入（应用 → 往返校验 → 构建后回退），`../pi-web` 保持 pristine ✅ |
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
- **D5：设置 UI 并入 pi-web 设置对话框（构建期补丁），不再使用原生设置窗口**
  （2026-11-22 改版；原「extraResource 静态目录 + 独立 preload」方案被取代，历史见 §3.3 D11/D15）。
  理由：pi-web 已有成熟的设置对话框（分区 tab / 手机端层级 / 焦点与 Escape / i18n / 主题），
  再维护一套原生 HTML 设置页属于重复建设。pi-web **没有**客户端 UI 插件/扩展插槽（pi 扩展 UI 仅
  `select`/`confirm`/`input`/`editor`/`custom` 与编辑器上下 widget；设置分区是硬编码数组），因此采用
  `patches/<pi-web-tag>/` 的构建期幂等补丁：`prepare-next` 在 `next build` 前应用，构建后回退。
  补丁面：`lib/settings-navigation.ts`（加 `sync`）、`components/SettingsPanel.tsx`（分区项 + 渲染）、
  新增 `components/SyncConfig.tsx`、`lib/i18n/messages/{zh-CN,en,zh-TW}.ts`（`settings.sync*`）。
  样式复用 `SettingsUi` 现有块与内联样式，不改 `app/settings.css`。
- **D6：不迁移、不读写 `~/.pi-agent-hub/`**（本机独立 daemon 数据），`pluginRoot` 隔离到
  `~/.pi-desktop/sync-daemon`（control 文件 / 日志 / 插件工作区互不干扰）。
- **D7：托盘只去「会话目录」项**；IPC `pi-desktop:open-session-dir` 与 preload 方法保留（上游 pi-web UI 依赖）。

### 3.2 上游/参考核实（✅ / 🔶 / ⬜）

| 结论 | 标记 |
|---|---|
| `@pi-agent-hub/sync-daemon@0.1.1` / `sync-plugin-pi-web@0.1.1` 已 publish（`npm view`） | ✅ |
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
| D11 | ~~设置窗口 CSS **内联**在 `index.html`，不建 `style.css`~~ | **已废止**：原生设置窗口整体移除（D18） |
| D12 | `running` 文案从「已连接」改为「**运行中**」 | 与 D8 的进程级语义一致，避免把「进程在跑」说成「已连接」 |
| D13 | 保留既有未提交实现作为本轮基座，不重写 | 逐条核对与需求一致（托盘/设置窗口/四字段/状态灯/配置落盘/启动编排/退出链） |
| D14 | 文档一致性只修本需求造成的口径漂移（README 301 表行、108 托盘描述、STRUCTURE、工程规划 §5.3） | `AGENTS.md` 的 `npm run check` 不存在属既有缺陷，改法有分歧，仅在交接文档记录 |
| D15 | ~~`forge.config.ts` 的 `extraResource` 用目录条目 `resources/settings`~~ | **已废止**：不再分发原生设置页（D18）；`RunAsNode: true` 仍保留 |
| D16 | start/stop/apply 统一进**串行队列**，并加 `shuttingDown` 退出闸门；启动前 `unlink` control 文件做代际隔离 | 并发 `await` 让出点会各自 spawn 出双 daemon；「点应用后立刻退出」会放出 detached 孤儿（评审 Important-3） |
| D17 | 优雅停止窗口降为 1.5s，超时必须强杀进程树 | 上游 `Daemon.stop()` 不清理 30s `setInterval`（`daemon.ts:114`，无 unref/exit），不能假设其自行退出（评审 Important-5）。**实测**：本机 `/local/quit` 后约 1.8s 以 code=1 退出、无残留；强杀仍保留为兜底 |
| D18 | 设置 UI 并入 **pi-web 设置对话框**（`sync` 分区，排在 MCP 之后）；删除原生设置窗口与其资源/独立 preload | pi-web 已有分区骨架/手机层级/焦点/i18n/主题；桌面自建原生页属重复建设。插件/扩展无 UI 插槽（见 §3.4），注入 DOM 依赖上游结构、升级即静默失效，故用构建期补丁 |
| D19 | 壳能力经**独立** preload 命名空间 `window.piDesktopSync`（只 `get`/`apply`）；主进程逐次校验 `senderFrame` | 不扩大既有 `window.piDesktop` 壳动作面；仅本应用源可用，未知来源拒绝并记 WARN。无桥（单独浏览器打开补丁版 pi-web）时该分区不显示 |
| D20 | 构建期补丁遵守 hos 纪律：`patches/<pi-web-tag>/`、幂等（`--reverse --check` 命中即跳过）、应用→反向→逐文件 SHA-256 还原、冲突硬失败、构建后自动回退 | 与 `pi-desktop-hos/patches/README.md` 同口径；另提供 `scripts/patches.mjs apply/revert/status` 供 dev 态手工迭代 |

### 3.4 设置 UI 的接缝核实（决定走补丁的依据）

| 路线 | 结论 | 依据 |
|---|---|---|
| pi 扩展 / 插件 | ❌ 不可行 | pi 扩展 UI 仅 `select`/`confirm`/`input`/`editor`/`custom`（终端组件）与编辑器上/下 widget、状态栏（`pi/packages/coding-agent/src/core/extensions/types.ts`；pi-web `components/ExtensionWidgets.tsx` 只用于聊天区）；pi-web 设置分区由 `lib/settings-navigation.ts` 枚举 + `components/SettingsPanel.tsx` 硬编码，无注册表/插槽 |
| 运行时 DOM 注入 | ⚠️ 可行但不采用 | 需 `MutationObserver` 往 `.settings-section-tabs` / `.settings-dialog-main` 插入节点；React 重渲染可能丢弃/重排，手机端首页与 level/history 需另适配，i18n/焦点/a11y 无法自然接入；上游改 DOM 会静默失效且构建期无感知 |
| 构建期补丁 | ✅ 采用 | 见 D18/D20；补丁面 4~5 个文件，复用上游分区骨架与 `SettingsUi`，构建期往返校验可保证可构建与可回退 |

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
export function saveSyncConfig(settings: SyncDaemonSettings, opts: SyncRuntimeOptions): Promise<void>;   // 校验 + 原子写（含运行时 options 落盘）
export function startSyncDaemon(opts: { server: string; agentDir: string; password: string }): Promise<void>; // 写 options → spawn
export function stopSyncDaemon(): Promise<void>;
export function applySyncConfig(settings: SyncDaemonSettings, opts: { server: string; agentDir: string; password: string }): Promise<void>; // 应用按钮全链路
export function getSyncStatus(): SyncStatus;
export function markSyncDaemonShuttingDown(): void;   // 退出闸门：置位后一律不再 spawn
export function onSyncStatusChange(listener: (s: SyncStatus) => void): () => void;
```

IPC（preload `window.piDesktopSync`，仅内嵌 pi-web 源可用）：

| 通道 | 方向 | 载荷 |
|---|---|---|
| `pi-desktop:sync:get` | invoke | → `{ settings: SyncDaemonSettings; status: SyncStatus }` |
| `pi-desktop:sync:apply` | invoke | `{ settings: SyncDaemonSettings }` → `{ ok: true }` / throw Error(可读消息) |

- 状态刷新：分区挂载期间每 **2.5s** 调一次 `get`（实现放在 `SyncConfig` 的 effect 里，卸载即清理）；
  不再保留 main→renderer 的 push 通道（FR-301-022 已按“分区挂载期间轮询”改写）。
- 两个通道都由 `sync-settings-ipc.ts` 注册；每次调用先校验 `event.senderFrame?.url` 属于
  `getAppOrigin()`（`http://127.0.0.1:<port>`）且为窗口主 frame，否则记 WARN 并抛错。

### 5.2 消费接口（本模块依赖）

- `host.ts`：`runtime.server.{url, port, password}`、`runtime.agentDir`（boot 就绪后提供）。
- `tray.ts`：`TrayActions` **删除** `openSettings`（托盘只剩显示主窗口 / 打开日志 / 检查更新… / 退出）。
- `windows.ts`：主窗口 `getAppOrigin()` 同时用于导航收口与桥的来源校验。
- `index.ts` `boot()`：`setStage('就绪')`/`refreshTrayMenu` 后调 `startSyncDaemon`（try/catch，不阻塞）；
  主窗口创建后注册 `sync-settings-ipc`。
- 退出链（`lifecycle`/`will-quit`）：`await stopSyncDaemon()`（不变）。

### 5.3 daemon 子进程契约

- 命令：`spawn(process.execPath, [daemonBin, 'run', '--config', configPath], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore','pipe','pipe'], windowsHide: true })`
  （`daemonBin` = `require.resolve('@pi-agent-hub/sync-daemon/dist/main.js')`，dev/打包均落在 asar node_modules 内，
  node 身份下可执行 asar 内 JS ✅ Electron fs 补丁）。
- stdout/stderr → 壳日志（`[sync-daemon:out/err]`，脱敏：过滤含 token/password 的行不回显全文）。
- 退出事件 → 状态 `stopped`（记录 code/signal）；若预期存活（enabled 且未主动 stop）记 WARN。

## 6. 文件与落点

| 文件 | 动作 |
|---|---|
| `src/main/sync-daemon.ts` | **不动**（本轮明确不改生命周期/状态机/原子写/退出闸门） |
| `src/main/sync-settings-ipc.ts` | **新增**：注册 `pi-desktop:sync:get` / `:apply`；`senderFrame` 来源校验；`getRuntime` 依赖注入 |
| `src/main/settings-window.ts` | **删除**（原生设置窗口、单例、资源加载、推送定时器一并移除） |
| `src/preload/settings.ts` | **删除** |
| `resources/settings/index.html` / `app.js` | **删除**（随原生设置页退场） |
| `vite.preload-settings.config.ts` | **删除** |
| `src/preload/index.ts` | **改**：`file:` 页仍只暴露既有 `piDesktop` 壳动作；对应用 http 源新增 `piDesktopSync = { get, apply }` |
| `src/main/tray.ts` | **改**：删除 `openSettings` 动作与菜单项；保留显示主窗口 / 打开日志 / 检查更新… / 退出 |
| `src/main/index.ts` | **改**：去掉 `openSettingsWindow`/`registerSettingsIpc`；改为注册 `sync-settings-ipc`（需 `getAppOrigin`）；daemon 启动/退出链不变 |
| `forge.config.ts` | **改**：`RunAsNode: true` 保留；删除 `extraResource` 的 `'resources/settings'` 与 settings preload 入口 |
| `scripts/prepare-next.mjs` | **改**：新增阶段 1b —— 在 `next build` 前幂等应用 `patches/<pi-web-tag>/*.patch`，构建成功后回退 |
| `scripts/patches.mjs` | **新增**：`apply` / `revert` / `status`（dev 态手工迭代补丁用；默认流程仍自动应用+回退） |
| `patches/README.md` + `patches/v0.17.0/0001-sync-daemon-settings-tab.patch` | **新增**：补丁登记（P301-1）与补丁本体 |
| `package.json` | **不动**：依赖仍为 `@pi-agent-hub/sync-daemon@0.1.1` / `sync-plugin-pi-web@0.1.1` |
| `specs/README.md` / `SPECS_CHECKLIST.md` / `STRUCTURE.md` / `docs/工程规划.md` | **改**：108 托盘项、301 设置分区、补丁数 0→1 的口径同步 |

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| asar 内 ESM `dist/main.js` 在 node 身份下执行 | Electron 的 fs 补丁对 asar 透明（node 身份同样生效）；测试项 TC 覆盖 dev+打包；若打包态失败，退路 = 把两包 dist 挪入 extraResource 并在配置 `plugins` 用 `path` 形态（⬜ 备选） |
| `RunAsNode: true` 安全面扩大 | plan §3.1 D2 已记录权衡；与 sidecar 模式既有依赖一致 |
| 密码每启动变化导致 daemon 内 deliver 401 | 每次（重）启动 daemon 前刷新 options.password 落盘（§4.1）；pi-web 密码本身随 app 生命周期 |
| 双 daemon 并存（本机独立 `~/.pi-agent-hub` daemon 也在跑） | `pluginRoot` 隔离（D6）；两者 hub 注册为不同 host（host.name 不同），不冲突 |
| 状态轮询读到上一代 control 文件（重启间隙） | 轮询前先校验本进程持有该子进程且存活；control 请求失败 → 红 |
| 上游 pi-web 升级导致补丁上下文漂移 | 补丁按 tag 分目录（`patches/v0.17.0/`），升级时在 detached worktree 以新 tag 重出；`prepare-next` 冲突即硬失败并给修复指引，绝不 `--3way` |
| 补丁残留污染上游工作树 | 构建成功后 `finally` 自动回退；`scripts/patches.mjs status` 可查；CI 在干净 clone 上验证“应用→构建→回退” |
| 桥被非预期页面调用 | 主进程校验 `senderFrame`（应用源 + 主 frame）；未知来源拒绝并记 WARN；`piDesktopSync` 只含 `get`/`apply` |

## 8. 测试策略

见 `test-cases.md`：单元层（配置读写/校验/状态机，typecheck + 手工脚本）+ 集成层
（dev 态 `npm start` + Docker hub 端到端 + CDP 驱动 pi-web 设置分区）+ 构建层（补丁往返校验）。

### 8.1 自动化取证方式（本轮）

| 层 | 做法 |
|---|---|
| 类型 | `npx tsc --noEmit`（本仓无 `npm run check`，CI 口径即 typecheck） |
| 补丁 | `node scripts/patches.mjs status` → `applied/clean`；`prepare-next` 构建期自动断言“应用→反向→SHA-256 还原”；构建后 `git -C ../pi-web status --porcelain` 必须为空 |
| 设置分区 UI | `--remote-debugging-port` + CDP：打开设置 → 点「中枢服务」tab → 断言字段回填 / 状态灯 / 令牌掩码与切换 / 校验错误文案 / 应用后 daemon 重启 |
| 桥安全 | 从一个非应用源页面（如 `about:blank` 或本地测试页）调用 `piDesktopSync.get`，断言被拒绝并记录 WARN |
| 主进程 / daemon | 日志 `<userData>/logs/pi-desktop-<date>.log` + 子进程 PID + control API `GET /local/status` + 配置文件比对 |
| 端到端上行 | hub console（`http://127.0.0.1:12380/hub/`，admin）里核对 `win-pi-desktop` host 与其会话 |
| 打包态 | `npm run package` 后启动打包产物，验证 `RunAsNode` fuse + asar 内 daemon 可拉起 + 补丁版 UI 带「中枢服务」分区 |

> 托盘菜单本身的**点击**需人工/UI 自动化；本轮菜单项断言为“5 条（含禁用标题）且无「设置」「会话目录」”，点击路径在交接文档中标为待人工确认。

## 9. 交付与回滚

- 交付：pi-desktop 单仓提交（feat 一条 + 规格文档一条）；父工程仅 submodule 指针推进（无父工程 spec）。
- 回滚：`enabled=false` 即停用（无需卸载）；代码回滚 = revert 对应提交。
