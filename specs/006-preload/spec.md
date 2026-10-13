# 006 — 壳层桥（preload）功能规格

> **Module:** 006-preload（壳层桥）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应方案:** [`./plan.md`](./plan.md)
> **实现落点:** `src/preload/index.ts`
> **规划依据:** `docs/工程规划.md` §5.6、§4.8、§3 原则 4、§5.4、§5.7

## 1. 模块概述

### 1.1 目的

壳层桥模块的职责是：**默认保持最小（不暴露任何东西），只在必要时向「壳层自有页面」（`file://` 的 loading/兜底页）暴露一组仅限于壳层动作的 API（`piDesktop`）**。

核心纪律：**数据面永不过 IPC**。会话、对话、文件、终端、SSE 事件帧全部走渲染层的同源 HTTP/SSE；IPC 只承载「壳层动作」（打开日志、退出、阶段通知等），且默认连这些都不需要（§5.6）。

### 1.2 解决的问题

- **构建目标需要入口**：Forge + Vite 的 preload 构建目标要求存在 `src/preload/index.ts`（即使为空实现）。
- **loading 页在 `file://` 下没有同源后端**：`index.html` 是壳层自有页面，没有 HTTP 服务可调；它的「打开日志 / 重试 / 退出」动作需要一条受控通道。
- **上游 UI 不该拿到壳层 API**：Pi Web UI 是上游代码，暴露壳层接口会（a）扩大攻击面，（b）诱发上游代码依赖壳层实现（升级即碎）。
- **避免数据面走 IPC 的历史陷阱**：一旦把 IPC 当数据通道，就会引入新载体、需要维护协议、并违背「零上游改动 + 同源数据面」原则（§3 原则 4、§4.8）。

### 1.3 范围

**包含**

- 空的 preload 入口（维持构建目标）。
- 条件暴露：仅 `file://` 文档可获得 `window.piDesktop`。
- 暴露面（六个）：`getInfo`、`openLog`、`openSessionDir`、`checkForUpdates`、`quit`、`onStage`。
- 显式的类型声明与「按需启用」的触发条件注释。

**不包含**

- 数据面通道（会话/对话/文件/终端/模型调用）——**永不**经 IPC。
- 窗口控制 IPC（`window:minimize/close` 等）——v1 用常规标题栏，无此需求（§5.2）。
- 会话行右键菜单的原生接管（`pi-web:session-row-contextmenu`）——Phase 2（§5.8、§10 Phase 2）。
- 深链、托盘/通知的内部实现（分别属 003/004）。

## 2. 用户故事

- 作为用户，当加载失败时我在 loading 页上点「打开日志」「重试」「退出」应当立即生效（这条通道必须在 `file://` 页面可用）。
- 作为用户，我希望 Pi Web UI 界面里不会因为我用了桌面版而出现「只在桌面壳里才有的行为」或多余的壳层按钮。
- 作为安全评审者，我希望知道 `piDesktop` 只在壳层自有页面上存在，且没有 Node 能力、没有通用 `invoke(channel, …)` 后门。
- 作为维护者，我希望「什么时候才允许引入壳层 IPC」有明确触发条件，而不是靠临时决定。

## 3. 功能需求

动作词：**MUST** 必须满足；**MUST NOT** 禁止；**SHOULD** 建议；**MAY** 可选。

### 3.1 默认最小

- FR-006-001：preload MUST 默认保持最小实现（允许 `export {}` 或仅条件暴露），其存在首先是为满足 Forge/Vite 的 preload 构建目标。
- FR-006-002：系统 MUST NOT 通过 IPC 传输任何数据面内容（会话、消息、文件内容、终端输出、SSE 事件帧、模型输出）。
- FR-006-003：系统 MUST NOT 提供通用的 `invoke(channel, payload)` / `send(channel, payload)` 式透传接口。

### 3.2 暴露条件

- FR-006-004：系统 MUST 仅当当前文档为壳层自有页面（`location.protocol === 'file:'`）时才向渲染世界暴露 `piDesktop`。
- FR-006-005：系统 MUST NOT 让 `http://127.0.0.1:<port>/`（Pi Web UI）文档获得 `piDesktop`（该文档下 `window.piDesktop` 必须为 `undefined`）。
- FR-006-006：暴露判定 MUST 在 preload 执行时完成（不依赖渲染层自报，也不依赖 URL 字符串匹配之外的启发式）。

### 3.3 暴露面（六个动作）

- FR-006-007：`piDesktop` MUST 仅包含以下方法：`getInfo()`、`openLog()`、`openSessionDir()`、`checkForUpdates()`、`quit()`、`onStage(handler)`。
- FR-006-008：`getInfo()` MUST 返回只读的壳层信息（应用名、版本、Electron/Node/Chromium 版本、数据目录模式、是否打包态），**MUST NOT** 返回任何凭据或密码。
- FR-006-009：`openLog()` MUST 打开日志落点（`<userData>/logs/`）；`openSessionDir()` MUST 打开数据目录（`agentDir`）——两者行为与 003 托盘菜单的同名项一致。
- FR-006-010：`checkForUpdates()` MUST 委托 011-release-update；MUST NOT 在桥内实现版本比较或下载。
- FR-006-011：`quit()` MUST 触发与托盘「退出」等价的退出流程（`app.quit()` → 优雅关闭链 → deadline 强退），**MUST NOT** 直接 `app.exit()` 绕过关闭链。
- FR-006-012：`onStage(handler)` MUST 只订阅壳层启动阶段事件（`{ stage, detail?, elapsedMs?, failed? }`），并 MUST 返回取消订阅函数；**MUST NOT** 承载会话/对话/工具调用等业务事件。
- FR-006-013：每个暴露方法 MUST 有对应的主进程 handler 实现；**MUST NOT** 暴露任何无实现的通道。

### 3.4 实现纪律

- FR-006-014：暴露经 `contextBridge.exposeInMainWorld('piDesktop', api)` 完成；api MUST 只包含函数与纯数据，**MUST NOT** 暴露 Node 能力（`require`/`process`/`fs`/`ipcRenderer` 本体）。
- FR-006-015：渲染层收到的对象 MUST 是克隆后的普通对象（不暴露 Electron 内部对象引用）。
- FR-006-016：暴露 API 的类型 MUST 可推导（提供 `window.piDesktop` 的类型声明，供 `src/renderer/renderer.ts` 使用）。
- FR-006-017：文件头 MUST 注明两件事：① 数据面永不过 IPC；② 「按需启用」的触发条件（见 §7）。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| `PiDesktopApi` | 暴露给壳层页面的接口对象 | 六个方法；全部无参数或轻量参数；无凭据 |
| `ShellInfo` | `getInfo()` 的返回 | `{ productName, version, electron, node, chrome, isPackaged, agentDirMode }` |
| `StageEvent` | `onStage` 的事件载荷 | `{ stage: string; detail?: string; elapsedMs?: number; failed?: boolean }` |
| 暴露判定 | 是否暴露的判据 | `location.protocol === 'file:'` |

## 5. 验收场景

### 场景 S1：壳层页面可用

- Given 窗口正在显示 `index.html`（启动中或失败态）
- When 页面脚本调用 `window.piDesktop.openLog()` / `quit()` / `onStage(h)`
- Then 动作在主进程执行、`onStage` 收到后续阶段事件

### 场景 S2：上游 UI 拿不到

- Given 窗口加载 `http://127.0.0.1:<port>/`
- When 在 Pi Web UI 的控制台执行 `typeof window.piDesktop`
- Then 输出 `undefined`

### 场景 S3：数据面不过 IPC

- Given 应用正常使用中（发送消息、工具调用、终端）
- When 观察 IPC 通道使用情况
- Then 只有壳层动作通道被使用；无任何会话/文件/终端内容经过 IPC

### 场景 S4：无 Node 能力

- Given 壳层页面可访问 `window.piDesktop`
- When 尝试 `window.piDesktop.require` / `window.piDesktop.process` / 任意未知方法
- Then 全部为 `undefined`（无通用透传后门）

### 场景 S5：退出走链

- Given 壳层页面（或 loading 页）提供退出动作
- When 用户触发 `quit()`
- Then 走 `app.quit()` → 优雅关闭链；进程正常退出（不绕过关闭链）

### 场景 S6：阶段事件不含业务数据

- Given `onStage` 已订阅
- When 启动阶段推进（含失败）
- Then 事件载荷只包含阶段名/详情/耗时/失败标记，不含会话内容、不含端口密码

## 6. 非功能需求

- **安全性**：最小暴露面（六个动作、无参数透传、无 Node 能力）；条件暴露（仅 `file://`）；不返回凭据。
- **稳定性**：暴露 API 的语义固定，渲染层无需感知主进程实现变化（未来换实现不破坏契约）。
- **可维护性**：暴露清单集中在一处（便于审计「IPC 面到底有多大」）；类型声明与实现同文件或紧邻。
- **性能**：`onStage` 为低频事件（启动期数十条），无热路径；无轮询。
- **构建**：preload 产物必须存在（`vite.preload.config.ts` 目标），否则 Forge 启动失败。

## 7. 假设与约束

- **假设（🔶 沿用 dsh 现状）**：preload 默认空实现是 dsh 的现状形态，本工程沿用（§5.6）。因此本模块的存在意义首先是**构建目标**与**壳层页面动作**，而非通用桥。
- **约束**：**按需启用**的触发条件（任一成立才允许扩大暴露面，且必须登记）：① 会话 JSONL 尾随的通知方案不能满足及时性（§5.4 备选①）；② 需要接管会话行右键菜单（`pi-web:session-row-contextmenu`）；③ 需要把「运行中会话」状态反馈给关窗确认（002 FR-002-029）。**扩展暴露面必须走规格追加，不得顺手加接口。**
- **约束**：`onStage` 只承载启动阶段（壳层自有页面场景）；Pi Web UI 页面不存在该订阅（FR-006-005）。
- **⚠️ 实现现状（2026-10-12 复核）**：`src/preload/index.ts`（34 行）已按 FR-006-004/005 做了 `location.protocol === 'file:'` 限定，但暴露的方法是 `getInfo` / `openLog` / `openSessionDir` / `checkForUpdates` / **`retry`** / `quit`（通道前缀 `pi-desktop:`），**没有 `onStage`** —— 启动阶段文本改由 002 的 `setStageOnWindow()`（`executeJavaScript`）推送。处置：要么实现补 `onStage`（满足 FR-006-012），要么按「FR 只追加不修订」追加一条记录该决定的 FR（本规格不得原地改写 FR-006-007/012）。
- **约束**：`sandbox: true` 下 preload 仍可执行并访问 `contextBridge` / `ipcRenderer`（🔶 dsh 现状），因此本模块不要求关闭沙箱。
- **⬜ 待验证**：`index.html` 的 CSP（`default-src 'self'; script-src 'self'`）对 preload 注入无影响（preload 运行在隔离世界、不受页面 CSP 限制）——P0-3 中一并确认；若不成立则在 `index.html` 用 nonce/hash 放行页面脚本（**不改上游**，`index.html` 属本工程）。
- **⬜ 待验证**：`location.protocol` 在 preload 的 `file://`/`http://` 两种文档下均能正确判定（Electron 43 + contextIsolation）。探针：两种文档各打一次日志。

## 8. 依赖

**上游（被本模块消费）**

- 002-window：窗口加载 `index.html`（`file://`）与 Pi Web UI（`http://`）——本模块的暴露判定依赖该加载策略。
- 003-tray / 011-release-update / 008-runtime-config：`openSessionDir`、`checkForUpdates`、`getInfo` 的实现来源。
- 005-lifecycle / 007-app-entry：`quit()` 的关闭链。

**下游（消费本模块）**

- `src/renderer/renderer.ts`（loading/兜底页脚本）：调用 `piDesktop` 的六个动作。
- 007-app-entry：注册 `onStage` 对应的阶段广播与动作 handler。

**外部**

- Electron `contextBridge` / `ipcRenderer` / `shell` / `app`；Forge Vite preload 构建目标（`vite.preload.config.ts`）。
