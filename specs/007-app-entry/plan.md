# 007 — 应用入口编排（app-entry）技术实现方案

> **Module:** 007-app-entry（应用入口编排）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应规格:** [`./spec.md`](./spec.md)
> **架构基线:** `docs/工程规划.md` §4.7（启动时序）、§5.1、§5.2、§8.4、§10（P0-0）、§11.4 S1/S4

## 1. 技术上下文

### 1.1 运行时环境

- **运行位置**：Electron 主进程入口（`package.json` 的 `main: .vite/build/main.js`；源码 `src/main/index.ts`）。
- **构建**：`vite.main.config.ts` 已把 `main` 目标锁定为 cjs lib、`external: ['electron', 'electron-squirrel-startup', 'node:*']` —— 因此入口可以用顶层 `require` 语义引入 `electron-squirrel-startup`（短路依赖其模块级副作用）。
- **唯一壳层运行时依赖**：`electron-squirrel-startup`（✅ `package.json` 的 `dependencies`）。
- **调用关系**：入口是唯一的「装配者」，所有模块由它调用；模块之间不互相 import 入口（避免循环依赖）。

### 1.2 依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `electron`（`app`） | 内置 | 生命周期、`setAppUserModelId`、`quit`/`exit` |
| `electron-squirrel-startup` | 壳层运行时依赖（✅ 已声明） | Windows 安装/卸载事件短路 |
| 001…009 / 011 各模块 | 本工程 | 见 spec §8 的交付表 |
| `src/main/logger.ts` | 本项目（✅ 已存在） | 启动时间线与失败留痕 |
| `src/main/constants.ts` | 本项目（✅ 已存在） | `APP_ID`、`PRODUCT_NAME`、`LOG_PREFIX` |

> 入口**不引入**任何新依赖；新增依赖需回到规格追加 FR 并说明理由。

## 2. 宪法合规检查

| 原则（`docs/工程规划.md` §3 / §4.7 / §11.4） | 状态 | 说明 |
|---|---|---|
| 只写装配代码（§3 原则 3） | ✅ | 入口是编排清单，模块内聚各自职责（FR-007-009） |
| 主进程进程内宿主（§3 原则 2） | ✅ | 无子进程编排；候选 B 例外需登记（FR-007-008、FR-007-016） |
| fail-visible（§3 原则 5、§4.7） | ✅ | 阶段文本 + 标题 + 日志 + 诊断槽（FR-007-007、FR-007-010、FR-007-011） |
| 同源数据面 / 零 IPC 数据面（§3 原则 4） | ✅ | 入口只做壳层动作接线（006 的六通道） |
| 关窗即退出（§5.2） | ✅ | `window-all-closed` → `app.quit()`，三平台一致（FR-007-013） |
| 安全 S1/S4（生产无 --inspect / DevTools 仅 dev） | ✅ | 入口不注册调试参数；dev 能力在 `npm start` 层（FR-007-019） |
| 安全 S2（不打印凭据） | ✅ | 取证基线日志不含密码（FR-007-017） |
| 平台差异显式化（§3 原则 6、§9.3） | ✅ | 安装器短路（Windows）、`activate`（macOS）显式分支 |
| 代码质量：strict TS、无 `as any`、严禁空 catch | ⬜ | 代码已落地（2026-10-12 复核），待人工评审 |

> 合规结论：架构与安全项 ✅；⬜ 项在 `src/main/index.ts` 落地后复核。

## 3. 研究结论

### 3.1 关键决策与理由

| 决策 | 理由 | 对应 FR |
|---|---|---|
| 顶层短路 `electron-squirrel-startup` | 安装器进程不应抢锁、不应创建窗口/服务器；短路必须早于一切副作用 | FR-007-001 |
| 单实例锁早于一切资源创建 | 抢占失败时进程「什么都没做」，退出代价为零（🔶 §5.1） | FR-007-002 |
| 安全准备在 `whenReady` 之前 | `commandLine.appendSwitch` 必须早于就绪；崩溃兜底越早越好 | FR-007-003 |
| `setAppUserModelId` 在 `whenReady` 后尽早 | Windows 通知显示与归组依赖它（§5.4） | FR-007-004 |
| 顺序：设置 → 目录 → 产物 → 宿主 → 就绪 → 窗 → 托盘 → 通知 | 每一步都有硬前置（目录先于宿主、产物先于宿主、就绪先于加载、窗口先于托盘唤回） | FR-007-006 |
| 宿主失败仍建窗 | 失败必须可见；无窗口的失败等于用户看不到任何原因（fail-visible） | FR-007-007 |
| 托盘在宿主失败时也创建 | 用户可以从托盘打开日志/退出（§5.3） | FR-007-006、003 |
| 尾随/通知在就绪后启动 | 需要 `agentDir` 与窗口存在（可见性判定） | FR-007-006 |
| 关窗即退出，不区分 macOS | 产品决策（§5.2、§9.2）；macOS 的 `activate` 重建窗口仅覆盖「无窗口但未退出」的瞬时窗口 | FR-007-013、FR-007-014 |

### 3.2 与参考实现/上游的核实（✅ / 🔶 / ⬜）

| # | 事实 | 依据 |
|---|---|---|
| U1 | 启动时序（含阶段与 fail-visible 规则）在规划中已定：`[lock] → [env] → [artifact] → [secret] → [server] → [ready] → [load]` | ✅ §4.7 |
| U2 | dsh 的入口编排（Squirrel 短路、单实例、安全准备、宿主、建窗、托盘/通知、退出）可作为形态模板 | 🔶 §4.9、dsh `specs/007-app-entry/spec.md` |
| U3 | 本工程**无** desktop profile 概念；其对应物是 `config/` 预置模板 + `agentDirMode`（008） | ✅ §6.3；⬜ 实现待 Phase 1 |
| U4 | `electron-squirrel-startup` 是本工程唯一的壳层运行时依赖 | ✅ `package.json` |
| U5 | 宿主启动必须**先于**窗口加载；但窗口可以先于宿主就绪创建并显示 loading 页 | ✅ §4.3、§4.7（首启解压数十秒） |
| U6 | 关窗确认依赖「运行中会话」判定源 | ⬜ P0-5（004） |
| U7 | 「重试」是否可进程内重跑（服务器可重复启动） | ⬜ P0-0/P0-1 结论决定（spec §7） |

### 3.3 入口骨架（编排清单）

```ts
// 0) 安装器短路（必须最先；其余 import 的副作用都不得早于它）
import squirrelStartup from 'electron-squirrel-startup';
if (squirrelStartup) app.quit();

// 1) 单实例锁（实现属 005）
if (!installSingleInstanceGuard(() => showMainWindow())) app.quit();

// 2) whenReady 之前的安全准备（实现属 005）
installSecurityPrelude();      // NO_PROXY + <-loopback> + 系统 CA + 崩溃兜底

void app.whenReady().then(async () => {
  app.setAppUserModelId(APP_ID);                        // 3) 早于任何通知
  logBaseline();                                        // 4) 取证基线（无凭据）

  const settings = loadSettings();                      // 5) 设置 → 数据目录
  const agentDir = resolveAgentDir(settings);
  ensureAgentDirTree(agentDir);
  materializePresetTemplates(agentDir, presetDir);      // 008

  const artifact = await ensureArtifact(userData);      // 6) 产物就位（009）

  stage('window'); createMainWindow(null);              // 7) 先建窗（loading 页）
  try {
    const host = await startHost({ userData, agentDir, piDistRoot: artifact.piDistRoot, nextEntry: artifact.nextEntry });   // 8) 宿主（001）
    await loadHostUrl(getMainWindow(), { url: host.url, password: host.password });                                          // 9) 加载 UI
  } catch (err) {
    failVisible(getStage(), err);                       // 失败可见，窗口保留
  }

  initTray({ showWindow: showMainWindow, openSessionDir, openLog, checkForUpdates, quit: () => app.quit() });   // 10) 托盘
  startSessionWatch(agentDir); startNotifications();   // 11) 通知（004）
});

app.on('second-instance', () => showMainWindow());
app.on('activate', () => { if (!getMainWindow()) recreateOrShow(); });        // macOS
app.on('window-all-closed', () => app.quit());                                // 关窗即退出（三平台）
app.on('before-quit', (e) => { e.preventDefault(); void runShutdownChain(deps); });   // 005
```

要点：

- **第 3 步与第 4 步在 `whenReady` 之后立即执行**，不等待宿主：这样通知与日志从第一刻起就是正确的。
- **第 7 步先建窗**：即使宿主失败，窗口也已存在，可显示失败态（FR-007-007）。窗口内部的加载策略负责「先 loading、后真实 URL」（002）。
- **`presetDir`**：开发态指向仓库 `config/`；打包态指向 `process.resourcesPath` 下的预置模板（⬜ 打包投放方式由 010/008 决定）。
- **`before-quit` 只做转发**：`preventDefault()` 与强退都在 005 内部实现（单一事实来源）。

## 4. 数据模型

### 4.1 实体

| 实体 | 字段 | 说明 |
|---|---|---|
| `BootstrapContext` | `{ settings, agentDir, artifact, host, status }` | 编排共享状态（模块级变量，不导出） |
| `StageId` | `'settings' \| 'agent-tree' \| 'artifact' \| 'env' \| 'server' \| 'ready' \| 'window' \| 'load' \| 'tray' \| 'notify'` | 阶段枚举（与 loading 页文本一一对应） |
| `StartupStatus` | `'starting' \| 'ready' \| 'failed'` + `failedStage?` + `reason?` | 编排终态（供托盘/006 `getInfo` 读取） |

### 4.2 状态机

```
boot
  ├─ squirrelShortCircuit → exit
  ├─ lockFailed → exit
  └─ whenReady
        → preparing   （settings / agent-tree / artifact）
        → hosting     （env / server / ready）
        → loading     （window / load）
        → serving     （ready：托盘 + 通知已装配）
        → failed(stage, reason)   （任一阶段失败；窗口保留，可重试）

退出边：window-all-closed / second-instance?? / tray quit → app.quit → before-quit → closing → exited
```

### 4.3 校验规则

- 只有在 `status !== 'failed'` 时才装配托盘与通知（失败态下托盘仍需创建，但「检查更新」等依赖宿主的项由 003 的 `TrayStatus` 置灰）。
- `recreateOrShow()`（`activate`）：有窗口 → `showMainWindow()`；无窗口 → `createMainWindow()` + 若宿主句柄仍在则 `loadHostUrl()`，否则显示 loading/失败态。
- 重试（FR-007-018）：**不重复** 执行 `installSingleInstanceGuard()` 与 `installSecurityPrelude()`；只重跑 `preparing → loading` 段，且先重置 `status`。
- 日志：每次阶段推进 `logInfo('[stage] <id> <ms>')`，失败用 `logError` + `globalThis.__<stage>Error`。

## 5. 接口契约

### 5.1 提供接口

| 导出 | 签名 | 说明 |
|---|---|---|
| （无对外导出） | — | 入口是终点，不导出函数；仅注册 Electron 事件与执行编排 |
| 诊断槽 | `globalThis.__hostError` / `__extractError` / `__renderError` | 探针取证用（不引入额外 API） |

### 5.2 消费接口（编排用）

| 来源 | 符号 |
|---|---|
| 005-lifecycle | `installSingleInstanceGuard`, `installSecurityPrelude`, `runShutdownChain` |
| 008-runtime-config | `loadSettings`, `resolveAgentDir`, `ensureAgentDirTree`, `materializePresetTemplates` |
| 009-artifact-bootstrap | `ensureArtifact` |
| 001-host | `startHost` |
| 002-window | `createMainWindow`, `loadHostUrl`, `pushStage`, `pushFailure`, `showMainWindow`, `getMainWindow` |
| 003-tray | `initTray`, `refreshTray`, `disposeTray` |
| 004-notification | `startSessionWatch`, `startNotifications`, `stopSessionWatch`, `stopNotifications` |
| 006-preload | 六个 `pi-desktop:*` handler 注册 + 阶段广播 |
| 011-release-update | `checkForUpdates` |
| `src/main/logger.ts` | `logInfo/logWarn/logError/describeError/setStage` |

### 5.3 事件协议（Electron）

| 事件 | 方向 | 处理 |
|---|---|---|
| `second-instance` | Electron → 入口 | `showMainWindow()`（005 已注册监听，回调在此提供） |
| `activate` | Electron → 入口（macOS） | 无窗口则重建（FR-007-014） |
| `window-all-closed` | Electron → 入口 | `app.quit()`（FR-007-013） |
| `before-quit` | Electron → 入口 | `runShutdownChain()`（005 实现，FR-007-015） |

## 6. 实现策略

### 6.1 架构模式

**线性编排 + 单例上下文**：入口只写「调用顺序」，不写实现。`stage('x')` 与 `failVisible(stage, err)` 是两个薄辅助函数（内部转发到 002 的 `pushStage`/`pushFailure` 与 logger），其余全部是模块调用。**不做**「插件式启动引擎」：本工程只有一条启动路径。

### 6.2 关键算法

- **阶段推进**：`stage(id)` → `setStage(id)` + `logInfo` + `pushStage({ stage: id, elapsedMs })`；阶段耗时用模块级 `t0` 计算。
- **失败可见**：`failVisible(stage, err)` → `logError` + `globalThis['__' + stage + 'Error'] = message` + `pushFailure(stage, reason)` + 窗口标题（002 内部实现）。
- **重试**：`retry()` → 复位 `status` → 重跑 `preparing → loading` 段（复用同一函数）。
- **托盘就绪刷新**：宿主就绪/失败后调用 `refreshTray({ hostReady, agentDir, logPath, updateState: 'idle' })`。

### 6.3 错误处理

- 顶层 `whenReady().then(async () => {…})` MUST 用 `try/catch` 包住整段编排，`catch` 走 `failVisible` 而非静默（**非空 catch**）。
- 单实例/安装器两条路径直接 `app.quit()`，不写额外日志（无资源可清理）。
- 关窗确认（若启用）：只在 `close` 事件内做一次 `preventDefault` + 询问；用户确认后 `win.destroy()` → `window-all-closed` 自然退出。

### 6.4 性能

- 入口自身开销 = 若干同步调用（设置读写、目录创建）与 await 链；无轮询、无定时器。
- 启动总时长由 009 解压与 001 就绪主导；入口按 FR-007-011 输出各阶段耗时，便于定位瓶颈（⬜ 实测基线）。

## 7. 测试考量

| 层次 | 方式 | 覆盖需求 |
|---|---|---|
| 静态 | `npm run typecheck` | 全部 |
| 探针（**P0-0**） | 骨架冒烟：`npm ci` → `npm start` → 出空窗（loading 页可显示）；断言 `electron-squirrel-startup` 短路在最前 | FR-007-001、FR-007-010、FR-007-019 |
| 手动 | 三平台各一次：正常启动顺序、失败态三动作、重复启动唤回、托盘退出、关窗退出、macOS `activate` | FR-007-002、FR-007-006、FR-007-007、FR-007-012…015 |
| 集成 | 以环境变量强制宿主失败（`PI_DESKTOP_PI_DIST` 指向不存在目录）→ 断言窗口存在且失败可见、托盘可用、可从托盘退出 | FR-007-007、FR-007-010 |
| 单元 | `StageId` 与 loading 页文本的映射完整性（每个阶段都有文案）；`retry()` 不重复执行安全准备 | FR-007-010、FR-007-018 |
| 负向 | 连续两次快速 `quit()`（托盘+关窗并发）→ 断言关闭链只执行一次 | FR-007-015（与 005 FR-005-016 联合） |
| 冒烟 | **P0-6**：安装后启动到首屏、退出无残留进程 | FR-007-016 |

## 8. 文件清单

| 文件 | 用途 | 状态（2026-10-12 复核） |
|---|---|---|
| `src/main/index.ts` | 入口编排（本文档主体） | ✅ 已存在（327 行） |
| `src/main/constants.ts` | `APP_ID`、`PRODUCT_NAME`、`LOG_PREFIX` | ✅ 已存在（56 行） |
| `src/main/logger.ts` | 启动时间线、`setStage`/`getStage`、`getLogFilePath` | ✅ 已存在（86 行） |
| `src/main/artifact.ts`（009） | `ensureArtifact()` | ✅ 已存在（163 行） |
| `src/main/settings.ts`（008） | `loadSettings` / `resolveAgentDir` / `ensureAgentDirTree` / `materializePresetTemplates` | ✅ 已存在（110 行） |
| `src/main/host.ts`（001） | `startHost()` | ✅ 已存在（518 行） |
| `src/main/windows.ts` + `window-state.ts`（002） | 建窗/加载/阶段推送 | ✅ 已存在（201 / 124 行） |
| `src/main/tray.ts`（003） | 托盘装配 | ✅ 已存在（87 行） |
| `src/main/notifications.ts` + `session-watch.ts`（004） | 尾随与通知 | ✅ 已存在（63 / 188 行） |
| `src/main/lifecycle.ts`（005） | 安全准备/关闭快照（单实例锁在入口顶层） | ✅ 已存在（79 行） |
| `src/preload/index.ts`（006） | 壳层动作 handler 注册 | ✅ 已存在（34 行） |
| `src/main/update-check.ts`（011） | `checkForUpdates()` | ✅ 已存在（97 行） |
| `config/`（008） | 预置模板源目录（`settings.json` / `mcp.json` 已存在；`trust.json` 未见） | ✅ 部分已建 |
| `src/types/globals.d.ts` | 壳层全局类型（诊断槽等） | ✅ 已存在（12 行） |

> ⚠️ 实现侧的模块导出名与 §3.3 骨架的示意名不完全一致（例如托盘为 `createTray`、通知为 `setupNotifications`）；**以源文件为准**。

## 9. 与规格交叉引用

| 规格需求 | 实现落点 |
|---|---|
| FR-007-001（Squirrel 短路） | §3.3 骨架第 0 步 |
| FR-007-002（单实例锁时机） | §3.3 骨架第 1 步 + 005 |
| FR-007-003…005（whenReady 前后准备 / AppUserModelId / agentDir） | §3.3 骨架第 2–5 步 |
| FR-007-006…011（启动顺序 / 失败可见 / 无子进程 / 薄入口 / 阶段文本 / 耗时） | §3.3 骨架 + §4.3 + §6.2 |
| FR-007-012…016（四类生命周期事件 / 无残留） | §5.3 事件表 + §6.3 |
| FR-007-017…019（取证基线 / 重试 / 无调试参数） | §6.2 + §4.3「重试」+ §2 合规表 |
| §5 验收场景 S1–S8 | §7 测试考量（S1/S2/S7/S8 手动+探针；S3/S4 手动与集成；S5/S6 手动） |
