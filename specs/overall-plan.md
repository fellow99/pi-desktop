# overall-plan.md — 整体技术方案

> pi-desktop 系统级技术方案（对应 [overall-spec.md](./overall-spec.md)，2026-10-12）。
> 本文档描述系统「如何构建」，是各模块 `plan.md` 的总纲；结论来源见 [`../docs/工程规划.md`](../docs/工程规划.md) §4、§5、§8、§10。
> **as-built 说明**：§3–§7 的路径与函数名对应当前工作树（`src/main/*.ts`，2026-10-12 快照）；
> ⬜ 标记的结论在 Phase 0 探针（P0-1…P0-6）取证前不得当作实测事实。

---

## 1. 技术上下文

| 项 | 内容 |
|---|---|
| 运行时 | **Electron 43.7.9**（主进程 Node **24.21.0**；渲染进程 Chromium **150.0.7871.250**；ABI **148**） |
| 构建 | Electron Forge `^7.11.2` + `@electron-forge/plugin-vite` + `@electron-forge/plugin-fuses`；`main` → `.vite/build/main.js`（三段：main / preload / renderer `main_window`） |
| 语言 | TypeScript `^5.6.0`（`strict`，`commonjs`，`tsc --noEmit` 为类型门） |
| 宿主（被封装） | `pi-web` **v0.11.1**（Next **16.3.8**，SPA + `/api/*` + **SSE**） + `pi` **v1.1.0**（进程内 SDK）——同级目录源码引用（`../pi`、`../pi-web`） |
| 宿主形态 | **主进程进程内**：`next/dist/server/lib/start-server.js` 的 `startServer({ dir, hostname, port })`（上游内部入口 → ⚠️ R1；⬜ 探针 P0-1） |
| 产物形态 | `pi-dist.tar.gz`（ustar）→ 首启解压 `<userData>/pi-dist`；SHA-256 marker 幂等 |
| 数据落点 | 默认 `~/.pi/agent`（`PI_CODING_AGENT_DIR`），可切 `<userData>/pi-agent` |
| 壳层运行依赖 | 只有 `electron-squirrel-startup ^1.0.1`（上游包不进壳层构建图） |

---

## 2. 宪法合规检查表

对照 [constitution.md](./constitution.md)（`✅` = as-built 已满足 / `⬜` = 待实现或待探针）：

| 原则 | 状态 | 说明与落点 |
|---|---|---|
| 零上游改动 | ✅ | 补丁集 0 条；`forge.config.ts` 只做打包配置；上游以 sibling 源码引用消费（§7） |
| 主进程进程内宿主 | ✅（机制）/ ⬜（P0-1 取证） | `src/main/host.ts` 的 `startHost()` 用 `require` 走导出探测 + `startServer`；sidecar 仅以 `PI_DESKTOP_HOST_MODE=spawn` 显式开启 |
| 只写装配代码 | ✅ | 主进程 14 个文件均为装配/壳层能力；无业务逻辑（`src/main/*`） |
| 同源数据面 | ✅ | 渲染层 `loadURL(http://127.0.0.1:<port>/)`（`src/main/windows.ts` 的 `loadPiWebUi`）；无自定义协议、无 CORS 改写 |
| fail-visible | ✅ | `logger.ts` 的 `setStage()` + `windows.ts` 的 `setStageOnWindow()` + `index.ts` 的 `failVisible()`（写 `globalThis.__piDesktopHostError`） |
| 平台差异显式化 | ✅（文档）/ ⬜（三平台实机） | 台账见工程规划 §9.3 与 `docs/桌面能力清单.md`（⬜ Phase 0 后产出） |
| 渲染进程隔离基线 | ✅ | `src/main/windows.ts` 的 `webPreferences`（`sandbox`/`contextIsolation`/无 `nodeIntegration`） |
| Fuses 六项 | ✅ | `forge.config.ts` 的 `FusesPlugin` 块 |
| 导航加固 | ✅ | `setWindowOpenHandler` 一律 deny + `will-navigate` 同源白名单 + `shell.openExternal` |
| 权限白名单 | ✅ | `windows.ts` 的 `ALLOWED_PERMISSIONS = {notifications, clipboard-sanitized-write}` + 来源与 `webContents.id` 校验 |
| loopback + 随机端口 + 随机密码 | ✅ | `host.ts` 的 `resolveFreePort()` / `resolvePassword()` / `assembleEnv()` |
| 凭据注入两件 | ✅ | `host.ts` 的 `installAuthInjection()`（Basic 出栈）+ `installAuthForWindow()`（`pi_web_session` cookie） |
| 生产不带 `--inspect` | ✅（打包配置 + Fuses）/ ⬜（构建产物 grep 取证） | `EnableNodeCliInspectArguments: false`；⬜ §11.4 S1 的产物核对脚本待建 |
| 数据面不过 IPC | ✅ | preload 只暴露 6 个壳层动作；业务数据走同源 HTTP + SSE |
| preload 只对 `file://` 暴露 | ✅ | `src/preload/index.ts` 的 `isLocalDocument()` 守卫（`location.protocol === 'file:'`） |
| TypeScript strict / 无 `as any` | ✅ | `tsconfig.json` 全量 strict 开关 + `npx tsc --noEmit` 通过（2026-10-12 实测） |
| 严禁空 catch | ✅ | 统一 `describeError()` + `logWarn/logError`；`session-watch.ts` 的只读 `catch { return [] }` 属「目录不存在即无文件」的显式空集，已在注释说明 |
| 最小改动 / 源码即真理 | ✅ | 本方案所有上游机制结论带文件路径（`specs/` 全部文档口径） |
| 关窗即退出 | ✅ | `index.ts` 的 `window-all-closed` → `app.quit()`；存在最近 60 s 会话活动时给一次关闭确认 |
| 优雅关闭链 + deadline | ✅ | `index.ts` 的 `before-quit`：停尾随 → `closeWithDeadline(server, SHUTDOWN_DEADLINE_MS)` → `destroyTray()` → `app.quit()` |
| 崩溃兜底 | ✅ | `lifecycle.ts` 的 `installCrashHandlers()` |
| 上游基线 tag 固定 | 🔶 | 文档与 `.gitmodules` 已固定；`ci.yml` 的 clone 步骤已就位；⬜ `upstream.lock.json` 属构建期产物，尚未生成 |
| 门禁全绿才打包 | 🔶 | 类型门 ✅ 通过；`scripts/smoke-desktop.mjs` 已就位、`prepackage`/`premake` 已指向它，⬜ 但**未执行过**（需 `pi-dist` 产物），故「全绿」尚未成立 |
| Conventional Commits | ✅ | 仓库提交约定（首个提交 `Initial commit` 为脚手架例外） |

**例外登记**：无未登记例外。

---

## 3. 启动编排顺序（`src/main/index.ts`）

```
① Squirrel 短路      if (started) → app.quit()          ← 安装/更新/卸载的短生命周期（静态 import，见文件注释）
② 单实例锁           app.requestSingleInstanceLock() 失败即 quit；成功注册 second-instance → restore/show/focus
③ 安全准备（whenReady 之前）
      ensureLoopbackNoProxy()  → NO_PROXY/no_proxy 并入回环 + proxy-bypass-list <-loopback>
      setupSystemCertificates() → 合并系统 CA（能力缺失时安全降级）
      installCrashHandlers()    → uncaughtException / unhandledRejection 落日志
      Menu.setApplicationMenu(null)
④ whenReady
      app.setAppUserModelId('com.fellow99.pi.desktop')   ← Windows 通知归组必需
      记录版本信息（Electron/Node/Chromium）；初始化 logger 的 userData 路径
⑤ 壳层 IPC 注册      registerShellIpc({ info / openLog / openSessionDir / checkForUpdates / retry / quit })
⑥ 建窗（先窗后宿主） createMainWindow() → 先加载壳层 loading 页（file://），显示阶段文本
⑦ 关窗前确认钩子     最近 60 s 内有会话写入 → 询问「仍然关闭 / 取消」
⑧ 建托盘             createTray()（宿主未就绪也可创建，菜单项按就绪态禁用）
⑨ 启动链 boot()      [env] → [artifact] → [server] → [ready] → [auth] → [load] → [done]
⑩ 通知订阅           setupNotifications()（仅后台弹、冷却去重、历史不补弹）
⑪ activate（macOS）  有窗口则唤回；无窗口则重建并复用已有 server（无 server 则重跑 boot）
⑫ window-all-closed  → app.quit()
⑬ before-quit        → 优雅关闭链（幂等：runtime.quitting 守卫）
```

**boot() 的七个阶段**（阶段名进入窗口标题、loading 页与日志；失败即 `failVisible`）：

| 阶段 | 动作 | 关键实现 |
|---|---|---|
| `[env]` | 读壳层设置 → 装配环境变量（`PI_CODING_AGENT_DIR` / `PI_WEB_HOSTNAME` / `PI_WEB_PASSWORD` / `NO_PROXY`） | `settings.ts::loadSettings`、`host.ts::assembleEnv` |
| `[artifact]` | `pi-dist.tar.gz` → `<userData>/pi-dist`（SHA-256 marker 幂等；`PI_DESKTOP_PI_DIST` 可跳过） | `artifact.ts::ensureArtifact` |
| `[server]` | 预览密钥轮换（**必须在起服务前**）→ 随机端口 → 进程内 `startServer` | `host.ts::rotatePreviewSecrets / resolveFreePort / startHost` |
| `[ready]` | HTTP 轮询探活（`/api/web-auth`，上限 `READY_TIMEOUT_MS = 30 s`），**不解析 stdout** | `host.ts::waitForReady` |
| `[auth]` | 注入两件凭据（cookie + Basic） | `host.ts::installAuthForWindow` |
| `[load]` | `loadURL(http://127.0.0.1:<port>/)` → 首屏完成 | `windows.ts::loadPiWebUi` |
| `[done]` | 刷新托盘菜单、启动通知订阅 | `tray.ts::refreshTrayMenu`、`notifications.ts::setupNotifications` |

> **与「先起宿主再建窗」的取舍**：本工程**先建窗（loading 页）再起宿主** —— 这是工程规划 §4.3 的必备项
> （首启要解压数万文件，直接加载真实 URL 会长时间白屏）。「就绪后才 loadURL 真实地址」这一条未被放弃，
> 只是把「窗口」与「真实页面」拆成两步。开发出口 `PI_DESKTOP_DEV_SERVER` 可跳过 `[artifact]`～`[ready]`，
> 直接加载已运行的 `pi-web`（§8.4）。

---

## 4. 宿主集成（`src/main/host.ts`）

| 步骤 | 实现要点 | 对应 FR |
|---|---|---|
| 端口 | `net.createServer().listen(0, '127.0.0.1')` 探测后释放 → 取空闲高位端口 | FR-000-011 |
| 环境 | `PI_CODING_AGENT_DIR`、`PI_WEB_HOSTNAME=127.0.0.1`、`PI_WEB_PASSWORD`（随机强密码，仅打印长度）、`NO_PROXY`/`no_proxy`；`PI_WEB_APP_NAME`、`PI_WEB_SKIP_VERSION_CHECK` 可选 | FR-000-012、FR-000-036 |
| 产物定位 | 打包态 `process.resourcesPath/pi-dist.tar.gz`；开发态 `app.getAppPath()`；解压根 `<userData>/pi-dist` | FR-000-042 |
| 预览密钥轮换 | `require(<pi-dist>/bin/rotate-preview-secrets.js)` 后调用（**不重新实现**；缺失即 fail-visible 抛错） | FR-000-013 |
| 启动导出探测 | 多候选路径/形状探测 `startServer`（`'in-process'` / `'in-process-next-server-api'`）；`PI_DESKTOP_HOST_MODE=spawn` 才走 sidecar（候选 B） | FR-000-010 |
| 就绪判定 | HTTP 轮询 `GET /api/web-auth`（免认证），间隔 400 ms、上限 30 s；**不解析 stdout** | FR-000-015、FR-000-016 |
| 凭据注入 | ① `session.webRequest.onBeforeSendHeaders` 对本服务 host:port 补 `Authorization: Basic pi:<password>`（覆盖 `/api/*` 与 SSE）；② 按上游算法派生会话 token → `session.cookies.set('pi_web_session', ...)`（30 天，承载页面导航） | FR-000-014 |
| 关闭 | `closeWithDeadline(server, 5000)`：先关 SSE/连接，再 `httpServer.close()`，超时强制 | FR-000-005 |

**替换了上游 `bin/pi-web.js` 的三件事**（必须自己实现，不能依赖它）：① 预览密钥轮换；②
`PI_WEB_HOSTNAME`/`PI_WEB_PASSWORD` 注入；③ run-record —— 本工程**不写** run-record（§4.2、FR-000-018）。

**回退候选 B（登记，不默认启用）**：`child_process.spawn(process.execPath, [nextBin, 'start', '-H','127.0.0.1','-p',port], { env: { ELECTRON_RUN_AS_NODE: '1' } })` + HTTP 轮询。
触发条件（任一）：⬜ P0-1 失败；上游内部入口形态变化且短期无法适配；需要服务端崩溃隔离/热重启。
启用代价：进程树清理（Windows `taskkill /T /F`）、孤儿 `next-server` 占端口、就绪判定改为双路。

---

## 5. 窗口与安全（`src/main/windows.ts`、`window-state.ts`）

- **窗口**：默认 1200×800、最小 800×600（`constants.ts`）；**常规系统标题栏**（`frame: true`，无窗口控制 IPC）；
  `ready-to-show` 后再显示；`F11` 全屏（`installFullscreenShortcut`）。
- **两段加载**：先 `file://` 壳层 loading 页（阶段文本 + 打开日志/重试/退出），就绪后 `loadPiWebUi()` 导航到真实 URL。
- **状态持久化**：`<userData>/window-state.json`（防抖写入、`getNormalBounds()`、多显示器可见性校验、异常回退默认）。
- **导航加固**：`setWindowOpenHandler` 一律 `deny` + http/https 交 `shell.openExternal`；`will-navigate` 仅同源。
- **权限白名单**：`setPermissionRequestHandler` 仅放行 `notifications` / `clipboard-sanitized-write`，并校验来源 URL 与 `webContents.id`。
- **失败可见**：`did-fail-load` / `render-process-gone` 记录并更新 loading 页文本。
- **壳层 IPC 面**（`registerShellIpc`，`ipcMain.handle('pi-desktop:*')` 单点收口）：
  `info`（产品/版本/阶段/URL/目录/日志路径）、`open-log`、`open-session-dir`、`check-updates`、`retry`、`quit`
  —— **全部是壳层动作，无一条承载业务数据**（FR-000-034）。

---

## 6. 托盘与通知（`tray.ts`、`session-watch.ts`、`notifications.ts`）

**托盘**：进程内单例 `Tray`（`resources/tray.png`；macOS 用 `trayTemplate.png` ⬜ 待设计确认）；
菜单 = 显示主窗口 / 会话目录（`shell.openPath(agentDir)`）/ 打开日志 / 检查更新 / 退出；
宿主未就绪时**照常创建**，菜单项按 `isReady()` / `hasAgentDir()` 禁用；退出走与关窗相同的 `app.quit()` 链。

**通知（v1 唯一事件源 = 会话 JSONL 尾随，零上游补丁）**：

```
<agentDir>/sessions/**/*.jsonl
   └─ session-watch.ts：fs.watch + 2 s 轮询兜底 + 每文件字节游标（含半行 remainder）
        └─ 解析新增行（version 3 行式 JSONL）→ AssistantMessageEvent { sessionFile, sessionId, projectDir, text }
             └─ notifications.ts：节流（默认 10 s 冷却）→ 仅当窗口不可见/未聚焦 → Electron Notification
```

- **启动基线**：首次扫描只记录字节偏移、**不回放历史**（FR-000-022）。
- **关闭在跑的会话**：`hasRecentActivity(sessionsDir, 60_000)` 供关窗确认使用（`index.ts` 的 `close` 钩子）。
- **备选（不在 v1 启用，登记）**：① 渲染层经最小 preload 桥上报告警事件；② 主进程订阅 `pi-web` 的 SSE/事件模块
  （⚠️ 耦合上游内部实现，上游升级即失效）。
- ⬜ **待验证（P0-5）**：延迟与可靠性度量；`pi-web` 会话落盘时机（turn 结束 vs 流式增量）；是否有更干净的上游钩子。

---

## 7. 横切关注点

### 7.1 代理与证书（`lifecycle.ts`）

- `ensureLoopbackNoProxy()`：`NO_PROXY`/`no_proxy` 追加 `127.0.0.1,localhost`，
  并 `app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>')`（须在 ready 前调用）。
- `setupSystemCertificates()`：`getCACertificates('default'|'system')` → `setDefaultCACertificates`；
  **能力缺失（旧 Node / 平台不支持）时安全降级不抛错**。

### 7.2 崩溃兜底（`lifecycle.ts::installCrashHandlers`）

`process.on('uncaughtException' | 'unhandledRejection')` → 统一日志 + 诊断槽；已知代价：宿主在主进程 = 应用级崩溃面。

### 7.3 日志（`logger.ts`）

- 文件：`<userData>/logs/pi-desktop-<YYYYMMDD>.log`；统一前缀 `[pi-desktop]`；控制台同步输出。
- 阶段状态机：`setStage()` / `getStage()`；`describeError(err)` 统一错误串（含 `cause` 链）。
- 纪律：**密码只打印长度**（⬜ §11.4 S2 待加构建期守卫）；日志是 fail-visible 的唯一落盘出口。

### 7.4 壳层设置与预置模板（`settings.ts`）

- `agentDirMode: 'shared' | 'app'`（`ShellSettings.version = 1`），存 `<userData>/pi-desktop-settings.json`；
  **切换需重启**（宿主启动早期即需该变量，不做进程内热切换）。
- 预置模板：`config/settings.json`（`packages: []`、`defaultProjectTrust: 'ask'`）与 `config/mcp.json`（空 `mcpServers`）
  → 仅在目标文件**不存在**时写入；`ensureAgentDirTree()` 补齐 `extensions/skills/prompts/themes/agents/sessions`。
  ⬜ **O6 待验证**：与用户既有文件的合并策略（不覆盖 vs 补缺键）——当前实现取「不覆盖」。

---

## 8. 测试与门禁方法

| 层 | 方法 | 状态 |
|---|---|---|
| 类型门 | `npm run typecheck`（`tsc --noEmit`，strict） | ✅ **通过**（2026-10-12：`npx tsc --noEmit` 退出码 0）。过程记录：首轮曾报 `src/main/windows.ts(202,10) TS2304: Cannot find name 'app'`（多余的 `export { app }`），随后修复；门禁要求打包前保持全绿（[constitution.md](./constitution.md) §6.2） |
| 冒烟门（**阻断打包**） | `node scripts/smoke-desktop.mjs`：用 **Node 24.21.0** 起服务并断言 ① `GET /` 返回 SPA ② `/api/web-auth` 与一条带凭据的 `/api/*` 返回 200 ③ SSE `/api/agent/[id]/events` 可建连（`text/event-stream`）④ pi SDK 可创建 `AgentSession`（不调用模型） | ⬜ 脚本已就位（287 行），**未执行**（依赖 `pi-dist` 产物与 `../pi-web` 生产构建） |
| 手工验收（Phase 1 出口） | §9.1 的 10 条：多轮工具调用闭环 + 终端 + MCP 各一次可用 | ⬜ |
| 探针（Phase 0） | P0-1 进程内宿主 / P0-2 Node 24.21 兼容 / P0-3 渲染与 `node-pty` / P0-4 产物引导 / P0-5 通知事件源 / P0-6 打包冒烟；结论落 `docs/构建验证记录.md` | ⬜ 未开工 |

**不变式（每个阶段验收都要过）**：无白屏、无闪退、无孤儿进程；失败必须给出「阶段 + 原因 + 打开日志」。

---

## 9. 构建与产物

```
① scripts/prepare-next.mjs   ：cd ../pi-web → npm ci → next build --webpack →（在副本上）按目标平台裁剪 node-pty prebuilds
                              → 复用 bin/rotate-preview-secrets.js 轮换预览密钥
② scripts/smoke-desktop.mjs  ：Node 24.21.0 起服务 + 四项断言；失败即阻断
③ scripts/collect-pi.mjs     ：组装 pi-dist（.next/** + public/** + next.config.ts + package.json + bin/ + node_modules 运行依赖
                              + config 预置模板）→ tar -czf pi-dist.tar.gz --format=ustar → 写 SHA-256 marker（= pi-dist.version）
④ forge make                 ：extraResource[pi-dist.tar.gz, resources/*] · asar:true · executableName:'pi-desktop'
                              · makers: Squirrel(win) / ZIP(win,mac,linux) / DMG(mac) / RPM(linux) / DEB(linux)
```

- `prepackage` / `premake` 钩子自动跑 ①→③（`package.json` 已配置），保证 `npm run make` 一条命令可复现（FR-000-044）。
- 解压目标 `<userData>/pi-dist`，幂等 marker `<userData>/pi-dist.sha256`（内容 = tar 包 SHA-256）（FR-000-042）。
- 体积与耗时基线：Electron 解压 ≈250 MB（🔶 通用量级）+ `pi-dist.tar.gz` ≈**116 MB**（🔶 HOS 同源实测 682 MB → 115.9 MB）
  → 安装包体积 ⬜ 实测；首启解压 + 起服务 + 首屏 ⬜ 实测（🔶 HOS 参考约 15 s）（FR，§8.3）。

---

## 10. 部署与更新（半自动）

- **发布**：`.github/workflows/release.yml`（tag `v*` + `workflow_dispatch`）→ 三 OS 矩阵 → `softprops/action-gh-release`
  上传 `*.exe` / `*.nupkg` / `RELEASES` / `*.zip` / `*.dmg` / `*.deb` / `*.rpm`（⬜ 工作流已就位，尚未演练发布）
- **签名/公证**：v1 **不做**（FR-000-048）；文档必须写明 macOS「右键打开」与 `xattr -dr com.apple.quarantine`；
  ⬜ 是否签名/公证见工程规划 §11.3 第 3 条。
- **更新（半自动，Q5）**：入口 = 托盘 / 壳层 IPC「检查更新」→ 查询更新源 → 语义化版本比较 → 有新版则弹窗展示版本号
  → `shell.openExternal(<下载页>)`；**不自动下载、不静默安装**；失败提示「无法检查更新」并留痕、不阻塞（FR-000-027、FR-000-028）。
- **更新数据源**：⬜ 待确认（工程规划 §11.3 第 2 条）——① GitHub Releases API
  （`https://api.github.com/repos/fellow99/pi-desktop/releases/latest`，注意未认证限流）；② `pi-desktop-website` 的静态 feed。
  当前实现以 ① 为默认、可用环境变量覆盖。
- **升级语义**：`pi-dist` 随包变化 → marker 不匹配 → 重新解压覆盖（**升级不残留旧文件**）；跨大版本升级需在发布说明中
  提示「首次启动会重新解压产物」。
