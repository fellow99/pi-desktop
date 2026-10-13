# 007 — 应用入口编排（app-entry）功能规格

> **Module:** 007-app-entry（应用入口编排）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应方案:** [`./plan.md`](./plan.md)
> **实现落点:** `src/main/index.ts`
> **规划依据:** `docs/工程规划.md` §4.7、§5.1、§5.2、§8.4、§10（P0-0）、§11.4 S1/S4

## 1. 模块概述

### 1.1 目的

入口编排模块的职责是：**按固定顺序装配各模块**（Squirrel 短路 → 单实例锁 → `whenReady` 前的安全准备 → `AppUserModelId` → 起宿主 → 建窗 → 托盘/通知 → 生命周期事件），本身**不实现**任何桌面能力。

它是「唯一知道全部模块」的位置：只有这里可以看到设置、数据目录、产物、宿主、窗口、托盘、通知与关闭链，并把它们按正确时序串起来。

### 1.2 解决的问题

- **启动顺序依赖**：宿主必须在窗口加载前就绪（否则窗口拿到的是不可达地址）；`AppUserModelId` 必须早于任何通知；安全准备必须在 `whenReady` 之前；单实例锁必须在任何资源创建之前。顺序错了会出现「白屏」「通知不显示」「第二个实例抢到端口」等散乱故障。
- **安装器短生命周期进程**：Windows 的 Squirrel 安装/卸载会以特殊参数短暂拉起本进程，必须在最早期识别并静默退出，避免弹出无意义的窗口与服务。
- **失败要可读**：任一阶段失败时窗口都必须存在并显示「阶段 + 原因」，并提供「打开日志 / 重试 / 退出」。
- **退出必须收敛**：关窗、托盘退出、系统退出信号都必须汇入同一条关闭链（005），并在 deadline 到点强退。
- **薄入口**：编排逻辑线性可读，职责委托给模块，避免入口变成第二个「大 main.js」。

### 1.3 范围

**包含**

- `electron-squirrel-startup` 的静态短路。
- 单实例锁的调用时机与第二实例回调接线（实现属 005）。
- `whenReady` 之前的安全准备调用（实现属 005）。
- `AppUserModelId` 设置。
- 设置解析 → 数据目录 → 目录树/预置模板 → 产物就位 → 环境装配 → 起宿主 → 就绪 → 建窗 → 凭据注入加载 → 托盘 → 通知尾随的顺序编排。
- 生命周期事件接线：`second-instance`、`activate`、`window-all-closed`、`before-quit`。
- 启动阶段文本推送与全流程日志。

**不包含**

- 各模块内部实现（宿主启动、窗口、托盘、通知、生命周期、设置、产物、更新）。
- 数据面（会话/对话）的任何处理。
- 深链、开机自启、全局快捷键、多窗口（§5.8）。
- 构建期准备（产物组装、CI 出包）→ 010/011。

## 2. 用户故事

- 作为用户，我希望启动过程有明确的阶段反馈；失败时窗口还在、能读原因、能打开日志、能重试或退出。
- 作为用户，我重复点图标时只会唤回已有窗口，不会出现第二份服务与第二个托盘图标。
- 作为用户，我在 Windows 上安装/卸载应用时不应看到应用窗口闪一下。
- 作为用户，我希望关窗就是退出，且退出后进程真的结束（不留后台服务）。
- 作为 macOS 用户，我希望点 Dock 图标（`activate`）时窗口能回来。
- 作为维护者，我希望入口是一个「编排清单」：每一行对应一个模块的一次调用，顺序即设计。

## 3. 功能需求

动作词：**MUST** 必须满足；**MUST NOT** 禁止；**SHOULD** 建议；**MAY** 可选。

### 3.1 入口短路与单实例

- FR-007-001：入口 MUST 在**最前面**（任何其它 import 的副作用之前）短路 `electron-squirrel-startup`；命中安装/卸载事件时 MUST 立即退出进程，**MUST NOT** 创建窗口、服务器或托盘。
- FR-007-002：系统 MUST 在短路之后、任何窗口/服务器/托盘创建之前申请单实例锁（调用 005 的守卫）；未获得锁时 MUST 立即退出。

### 3.2 `whenReady` 前后的安全准备

- FR-007-003：系统 MUST 在 `app.whenReady()` **之前**完成安全准备：代理绕过注入、系统 CA 合并、崩溃兜底注册（实现属 005）。
- FR-007-004：系统 MUST 在 `whenReady` 之后**尽早**设置 `app.setAppUserModelId(APP_ID)`，且 MUST 早于任何通知的产生。
- FR-007-005：系统 MUST 在启动宿主前解析壳层设置（008），据此决定 `agentDir`（共享 `~/.pi/agent` 或应用私有）；**MUST NOT** 在运行中热切换数据目录。

### 3.3 启动编排（顺序固定）

- FR-007-006：系统 MUST 按以下顺序推进启动：**设置解析 → agent 目录树与预置模板 → 产物就位（009）→ 环境装配与宿主启动（001）→ 就绪 → 建窗（002）→ 凭据注入并加载 UI → 托盘（003）→ 通知与尾随（004）**。
- FR-007-007：宿主启动失败（含探测失败、超时、产物缺失）时，系统 MUST 仍然建窗并显示失败态（阶段 + 原因 + 三个动作）；**MUST NOT** 让应用静默退出或停在无窗口状态。
- FR-007-008：整个启动流程 MUST 在主进程内完成，**MUST NOT** 引入子进程（除非 001 启用登记过的候选 B）。
- FR-007-009：入口 MUST 保持薄编排：**MUST NOT** 在入口内实现模块职责（解压、探测、通知策略等）。
- FR-007-010：每个阶段 MUST 更新 loading 页阶段文本（经 002 的 `pushStage`），失败时 MUST 推送 `pushFailure` 并把阶段写入窗口标题。
- FR-007-011：系统 SHOULD 记录每个阶段的开始/结束与耗时，形成一条可读的启动时间线。

### 3.4 生命周期事件

- FR-007-012：系统 MUST 在 `second-instance` 时唤回主窗口（实现属 005，回调在此接线）。
- FR-007-013：系统 MUST 在 `window-all-closed` 时调用 `app.quit()`（关窗即退出，三平台一致）。
- FR-007-014：系统 MUST 在 macOS `activate` 且无窗口时重建主窗口；若宿主仍就绪则加载宿主 URL，否则显示失败/loading 态。
- FR-007-015：系统 MUST 在 `before-quit` 触发 005 的优雅关闭链（含 deadline 强退）。
- FR-007-016：退出后系统 MUST NOT 残留孤儿进程；若 001 启用了子进程回退，入口 MUST 负责调用对应的进程树清理。

### 3.5 诊断与重试

- FR-007-017：系统 MUST 在启动早期输出取证基线日志（应用版本、Electron/Node/Chromium 版本、`app.isPackaged`、`agentDir`、日志路径），**MUST NOT** 输出任何凭据。
- FR-007-018：loading 页的「重试」动作 MUST 触发一次受控重试：重跑 FR-007-006 的启动链（不重复申请单实例锁、不重复建窗）。⬜ 具体实现方式（进程内重跑 vs `app.relaunch()`）按 P0-0 结论决定；无论选哪种，用户可见行为 MUST 一致（一次点击 → 一次重试）。
- FR-007-019：系统 MUST NOT 向入口引入调试参数（`--inspect` / `--remote-debugging-port`）；开发态开关只允许在 `npm start` 的开发脚本中（§11.4 S1/S4）。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| 启动上下文（`BootstrapContext`） | 编排过程中的共享状态 | `settings`、`agentDir`、`artifact: ArtifactState`、`host: HostHandle \| null`、`mainWindow`、`status` |
| 阶段标识（`StageId`） | 启动阶段枚举 | `settings` → `agent-tree` → `artifact` → `env` → `server` → `ready` → `window` → `load` → `tray` → `notify` |
| 启动结果 | 编排终态 | `ready` / `failed(stage, reason)` |
| 事件接线表 | 入口注册的 Electron 事件 | `second-instance`、`activate`、`window-all-closed`、`before-quit` |

## 5. 验收场景

### 场景 S1：正常启动顺序

- Given 无其它实例运行、产物已就位
- When 应用启动
- Then 按 FR-007-006 顺序推进；首屏为 Pi Web UI；托盘已创建；日志含完整阶段时间线

### 场景 S2：安装器短生命周期

- Given 进程以 Squirrel 安装/卸载参数被拉起
- When 入口代码执行
- Then 进程立即退出，不创建窗口、不启动宿主、不创建托盘

### 场景 S3：重复启动

- Given 应用已有运行实例
- When 用户再次启动
- Then 第二实例立即退出；已有实例的窗口被还原并聚焦；不产生第二份服务器/托盘

### 场景 S4：宿主失败时的 fail-visible

- Given 产物归档缺失或 `startServer` 探测失败
- When 应用启动
- Then 窗口仍然出现并显示失败阶段与原因；「打开日志 / 重试 / 退出」三个动作都可用

### 场景 S5：关窗退出

- Given 应用运行中
- When 用户关闭主窗口
- Then `window-all-closed` → `app.quit()` → 关闭链；进程结束、留痕完整

### 场景 S6：macOS 重新激活

- Given macOS 上窗口已关闭但进程仍在（例如关闭过程中）
- When 用户点击 Dock 图标（`activate`）且无窗口
- Then 重建主窗口并加载宿主 URL（宿主仍就绪时）

### 场景 S7：重试

- Given 应用处于失败态（如临时端口冲突）
- When 用户点击 loading 页「重试」
- Then 重跑启动链；成功则进入首屏，再次失败则显示新的失败原因

### 场景 S8：无残留进程

- Given 应用完成一次启动与退出
- When 查看进程列表
- Then 只有操作系统/其它应用进程，无本应用的残留进程

## 6. 非功能需求

- **可读性**：入口是线性编排清单；每个阶段一行调用，顺序即设计（避免嵌套与隐式依赖）。
- **可诊断性**：阶段时间线 + 失败原因 + 诊断槽（`globalThis.__hostError` 等）三处齐备。
- **健壮性**：任一阶段失败都不崩溃（除单实例/安装器短路这两条「立即退出」路径）。
- **安全**：不注册调试参数；不打印凭据；开发态能力（DevTools/`--inspect`）与打包态严格分离（§11.4 S1/S4）。
- **启动性能**：入口自身开销为毫秒级；总启动时间由 009 解压与 001 就绪主导（⬜ 实测）。
- **可维护性**：新增阶段只允许在阶段枚举中追加，且必须同时更新 loading 页阶段文本与日志。

## 7. 假设与约束

- **假设（🔶 沿用 dsh 范式）**：入口编排形态（安装器短路 → 单实例 → 安全准备 → 宿主 → 建窗 → 托盘/通知 → 生命周期事件）与 dsh 一致；差异只在于「宿主」换成 pi-web 的进程内 Next 服务器（§4.9）。
- **约束**：本工程**没有** `desktop profile` 之类的宿主 profile 概念，因此 dsh 的 008-desktop-profile 对应物被替换为「`config/` 预置模板 + `agentDirMode` 设置」（§6.3），其实现在 008-runtime-config，入口只调用。
- **约束**：关窗即退出（三平台一致），因此 `window-all-closed` **不**做 macOS 特例（不做「macOS 保持后台」）。
- **约束**：⬜ 「重试」的实现方式待 P0-0 定（进程内重跑需保证服务器可重复启动、`http.Server` 可重建；若实测不可重入，则退化为 `app.relaunch() + app.exit()`）。
- **约束**：⬜ 关闭中「存在运行中会话」的关窗确认（002 FR-002-029）是否在 v1 落地，取决于 P0-5 对会话运行态判定源的结论；入口只负责接线，不自行判定。
- **⬜ 待验证（P0-0）**：`electron-squirrel-startup` 的静态短路必须位于入口**任何副作用之前**；Vite 打包为 cjs 后其 `require` 副作用顺序需实测确认。

## 8. 依赖

**上游（被本模块消费，全部为本工程模块）**

| 模块 | 交付 |
|---|---|
| 001-host | `startHost()` → `HostHandle`；`HostHandle.close()` |
| 002-window | `createMainWindow()`、`loadHostUrl()`、`pushStage()`、`pushFailure()`、`showMainWindow()`、`getMainWindow()` |
| 003-tray | `initTray()`、`refreshTray()`、`disposeTray()` |
| 004-notification | `startSessionWatch()` / `stopSessionWatch()`、`startNotifications()` |
| 005-lifecycle | `installSingleInstanceGuard()`、`installSecurityPrelude()`、`runShutdownChain()` |
| 006-preload | 六个壳层动作的 handler 实现（`pi-desktop:*`）与阶段广播 |
| 008-runtime-config | `loadSettings()`、`resolveAgentDir()`、`ensureAgentDirTree()`、`materializePresetTemplates()` |
| 009-artifact-bootstrap | `ensureArtifact(userData)` |
| 011-release-update | `checkForUpdates()`（经 003/006 触发） |

**下游（消费本模块）**

- 打包产物（安装器依赖 Squirrel 短路）；操作说明（`README.md` 的运行/调试章节）。

**外部**

- Electron `app`（`whenReady`、`requestSingleInstanceLock`、事件、`setAppUserModelId`、`quit`/`exit`）、`electron-squirrel-startup`（唯一壳层运行时依赖，✅ `package.json`）。
