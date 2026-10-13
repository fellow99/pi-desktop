# 003 — 系统托盘（tray）技术实现方案

> **Module:** 003-tray（系统托盘）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应规格:** [`./spec.md`](./spec.md)
> **架构基线:** `docs/工程规划.md` §5.3、§5.8、§9.3、§11.2 O7、§6.2（目录结构）

## 1. 技术上下文

### 1.1 运行时环境

- **运行位置**：Electron 主进程（Node 24.21.0）。
- **调用时机**：007-app-entry 在 `app.whenReady()` 之后、**宿主就绪前后均可调用**（`initTray()` 幂等）；退出链中调用 `disposeTray()`。
- **编译产物**：`src/main/tray.ts` → `.vite/build/main.js`。
- **资源**：`resources/tray.png`（Windows/Linux）、`resources/trayTemplate.png`（macOS 模板图）。两者经 `forge.config.ts` 的 `extraResource` 随包分发（✅ `forge.config.ts` 第 38 行已声明这两项），运行时从 `process.resourcesPath` 解析（打包态）/ 仓库 `resources/`（开发态）。

### 1.2 依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `electron`（`Tray` / `Menu` / `nativeImage` / `shell` / `app`） | 内置 | 托盘、菜单、图标、打开目录、退出 |
| `src/main/windows.ts`（002） | 本工程 | `showMainWindow()`、`getMainWindow()` |
| `src/main/settings.ts`（008） | 本工程（✅ 已存在） | `loadSettings()` + `resolveAgentDir()` → 会话目录路径 |
| `src/main/logger.ts` | 本项目（✅ 已存在，86 行） | `getLogFilePath()`（打开日志项的落点）、`logInfo/logWarn` |
| `src/main/update-check.ts`（011） | 本工程（✅ 已存在，97 行） | `checkForUpdates()` |
| `src/main/constants.ts` | 本项目（✅ 已存在） | `PRODUCT_NAME`、路径与文件名常量 |

> 无第三方依赖。图标资源已产出（`resources/{icon.ico,icon.icns,icon.png,tray.png,trayTemplate.png}`），⬜ 仅 macOS 模板图与高 DPI 视觉待实机核（spec §7 的 O7）。

## 2. 宪法合规检查

| 原则（`docs/工程规划.md` §3 / §5 / §9.3） | 状态 | 说明 |
|---|---|---|
| 平台差异显式化（§3 原则 6；§9.3） | ✅ | 模板图（macOS）与单击行为差异都在本模块收口并写入台账（FR-003-004、FR-003-013） |
| 明确不做项不偷做（§5.8） | ✅ | 不实现全局快捷键 / 开机自启 / 多窗口 / 托盘常驻（FR-003-018） |
| 退出路径唯一（§5.3、§5.2） | ✅ | 托盘「退出」走 `app.quit()` → `before-quit` 链（FR-003-016） |
| 失败可见（§3 原则 5） | ✅ | 无托盘环境/资源缺失记录 WARN 并继续（FR-003-005） |
| 数据面零 IPC（§3 原则 4） | ✅ | 托盘不经任何 IPC；动作全部在主进程内完成 |
| 零上游改动（§7） | ✅ | 不涉及上游 |
| 代码质量：strict TS、无 `as any`、严禁空 catch | ⬜ | 代码已落地（2026-10-12 复核），待人工评审 |

> 合规结论：架构/平台/退出相关项 ✅；资源与实机呈现见 §3.2 的 ⬜ 项。

## 3. 研究结论

### 3.1 关键决策与理由

| 决策 | 理由 | 对应 FR |
|---|---|---|
| 单例 + 幂等 `initTray()` | 二次初始化会产生第二个图标（用户可见的缺陷）；幂等让 007 无需关心调用次数 | FR-003-001 |
| 宿主未就绪也创建托盘、菜单项置灰 | 启动期（首启解压数十秒）用户必须能打开日志/退出（🔶 dsh 现状形态，§5.3） | FR-003-002、FR-003-007 |
| 固定五项菜单，不动态增删 | 菜单结构稳定；禁用态已能表达「暂不可用」 | FR-003-007 |
| 会话目录项直接 `shell.openPath(agentDir)` | agentDir 是 008 的唯一权威解析结果；本模块不重新推导路径 | FR-003-009 |
| macOS 用模板图 + 单击弹菜单 | 平台惯例（§5.3、§9.3 台账） | FR-003-004、FR-003-013 |
| 「退出」= `app.quit()` 而非 `app.exit()` | 必须经过优雅关闭链（关 SSE → close → deadline 强退），否则会留下挂住的进程（§4.2、R8） | FR-003-016 |
| 菜单构造抽成纯函数 | 唯一可单测部分：断言各状态组合下的 enabled 真值表 | §6 可维护性 |

### 3.2 上游/参考核实（✅ / 🔶 / ⬜）

| # | 事实 | 依据 |
|---|---|---|
| U1 | 本工程的托盘菜单项集合是**五项**（显示主窗口 / 会话目录 / 打开日志 / 检查更新 / 退出） | ✅ `docs/工程规划.md` §5.3（dsh 参考实现只有两项，本工程扩展） |
| U2 | 托盘图标：macOS 用模板图 `trayTemplate.png`，Windows/Linux 用 `tray.png` | ✅ §5.3；✅ 资源已产出（`resources/`）；⬜ 实机视觉待验（O7） |
| U3 | 单击行为平台差异：Windows/Linux 唤回窗口；macOS 弹菜单 | ✅ §5.3 |
| U4 | `extraResource` 已包含 `resources/tray.png` 与 `resources/trayTemplate.png` | ✅ `forge.config.ts:38`（本仓库已存在） |
| U5 | Linux 托盘依赖桌面环境（StatusNotifier/AppIndicator）支持 | ⬜ 三平台实测（§9.3 只写「依赖桌面环境」） |
| U6 | 日志落点：`<userData>/logs/pi-desktop-<YYYYMMDD>.log`；`getLogFilePath()` 已实现 | ✅ `src/main/logger.ts:34`、§4.6 |
| U7 | 数据目录：`loadSettings()` + `resolveAgentDir()` 已实现（shared → `~/.pi/agent`；app → `<userData>/pi-agent`） | ✅ `src/main/settings.ts:34,59` |

## 4. 数据模型

### 4.1 实体

| 实体 | 字段 | 说明 |
|---|---|---|
| `TrayStatus` | `hostReady: boolean`、`agentDir: string \| null`、`logPath: string \| null`、`updateState: 'idle' \| 'checking' \| 'done'` | 决定菜单项 enabled（FR-003-007） |
| `TrayHandlers` | `{ showWindow, openSessionDir, openLog, checkForUpdates, quit }` | 依赖注入（避免 `tray.ts` 反向 import 007/011 造成循环依赖） |
| 菜单项 | `{ id, label, enabled, click }` | 五项固定结构（FR-003-006） |

### 4.2 状态机

```
absent
  → created      （initTray()；图标加载成功或降级为占位）
  → refreshed    （setContextMenu(status) 重建菜单；幂等，可多次）
  → destroyed    （disposeTray()；退出链调用）

图标加载失败 → created(no-icon) + WARN（不阻塞；后续 refresh 行为不变）
```

### 4.3 校验规则

- `agentDir` 项 enabled = `agentDir !== null && existsSync(agentDir)`。
- `openLog` 项 enabled = `logPath !== null`（日志文件按需创建，`logger.ts` 已保证首次写入时建目录）。
- `checkForUpdates` 项 enabled = `updateState === 'idle'`（避免并发检查）。
- 单击处理：`process.platform === 'darwin'` → `tray.popUpContextMenu()`；否则 `handlers.showWindow()`。
- 唤回：`win.isMinimized() && win.restore()` → `win.show()` → `win.focus()`；`win.isDestroyed()` → 交给 007 重建（本模块不自行建窗）。

## 5. 接口契约

### 5.1 提供接口（本模块导出）

| 导出 | 签名 | 说明 |
|---|---|---|
| `initTray(handlers)` | `(h: TrayHandlers) => void` | 创建单例托盘（幂等） |
| `refreshTray(status)` | `(s: TrayStatus) => void` | 重建菜单（幂等） |
| `disposeTray()` | `() => void` | 销毁托盘（退出链调用；幂等） |
| `buildMenuTemplate(status, handlers)` | `(s, h) => MenuItemConstructorOptions[]` | 纯函数，便于单测（FR-003-006/007） |

### 5.2 消费接口（本模块依赖）

| 来源 | 符号 |
|---|---|
| `electron` | `Tray`, `Menu`, `nativeImage`, `shell`, `app`, `process.platform` |
| 002-window | `showMainWindow()`, `getMainWindow()` |
| 008-runtime-config | `loadSettings()`, `resolveAgentDir()` |
| `src/main/logger.ts` | `getLogFilePath()`, `logInfo`, `logWarn` |
| 011-release-update | `checkForUpdates()`（✅ 已存在，97 行） |

### 5.3 事件协议

- **无 IPC 通道**：托盘动作全在主进程内完成；不向渲染层发送任何消息。
- Electron 事件：`tray.on('click')`（平台分支）；菜单项 `click` 回调。

## 6. 实现策略

### 6.1 架构模式

**依赖注入的薄模块**：`tray.ts` 不直接 import 007/011，而是通过 `initTray(handlers)` 接收动作函数；状态经 `refreshTray(status)` 推入。这样 007 是唯一的「知道全部模块」的位置（对齐「只写装配代码」原则）。

### 6.2 关键算法

- **菜单重建**：每次 `refreshTray()` 用 `Menu.buildFromTemplate(buildMenuTemplate(status, handlers))` 生成新菜单并 `tray.setContextMenu(menu)`；不做增量 patch（Electron 菜单本身不可变）。
- **图标加载**：`nativeImage.createFromPath(iconPath)` → `isEmpty()` 判定失败；macOS 额外 `image.setTemplateImage(true)`，并优先尝试 `trayTemplate.png`。
- **唤回**：见 §4.3；全部操作前判 `isDestroyed()`。
- **打开目录/日志**：`shell.openPath(path)` 返回非空字符串即视为失败，`logWarn` 记录（不弹窗、不阻塞）。

### 6.3 错误处理

- 图标缺失：`logWarn` + 继续（FR-003-005）；**不得**用 `throw` 让启动中断。
- `shell.openPath` 失败：`logWarn`（用户的显式动作，失败需留痕；后续可接通知，但 v1 只留痕）。
- `disposeTray()` 重复调用：内部判空后 `destroy()`，异常只记录 WARN（**非空 catch**）。
- 更新检查中的并发点击：由 `updateState` 门控（§4.3），不产生并发请求。

### 6.4 性能

- 托盘初始化 = 一次图标加载 + 一次菜单构建（毫秒级）。
- 菜单只在状态变化时重建（宿主就绪、窗口创建/销毁、更新检查状态变化），**MUST NOT** 轮询。
- `buildMenuTemplate()` 为纯函数，无 IO。

## 7. 测试考量

| 层次 | 方式 | 覆盖需求 |
|---|---|---|
| 静态 | `npm run typecheck` | 全部 |
| 单元 | `buildMenuTemplate()` 真值表：`hostReady=false` / `agentDir` 不存在 / `updateState='checking'` / 全部就绪 四种组合下的 enabled 断言 | FR-003-006、FR-003-007、FR-003-009、FR-003-010、FR-003-011 |
| 单元 | 图标路径解析：打包态（`process.resourcesPath`）与开发态（仓库 `resources/`）两条分支 | FR-003-004、FR-003-005 |
| 手动 | 三平台各一次：图标可见性（含 macOS 深浅色）、单击行为、五项动作、退出后无残留图标 | FR-003-001…004、FR-003-013…017 |
| 负向 | 删除 `resources/tray.png` → 断言启动继续且有 WARN；托盘环境下 `agentDir` 不存在 → 断言项置灰 | FR-003-005、FR-003-009 |
| 探针 | **P0-6**（打包冒烟）：安装后从托盘退出，断言进程列表无残留 | FR-003-016、FR-003-017 |

## 8. 文件清单

| 文件 | 用途 | 状态（2026-10-12 复核） |
|---|---|---|
| `src/main/tray.ts` | 托盘单例 + 菜单构造 + 唤回 + 退出入口 | ✅ 已存在（87 行；实际导出 `createTray` / `refreshTrayMenu` / `destroyTray`） |
| `resources/tray.png` | Windows/Linux 托盘图标 | ✅ 已存在 |
| `resources/trayTemplate.png` | macOS 模板图（深浅色自适应） | ✅ 已存在（⬜ 实机视觉待核，O7） |
| `resources/icon.ico` / `icon.icns` / `icon.png` | 应用图标（`forge.config.ts` 的 `icon` 与 Squirrel `setupIcon` 依赖） | ✅ 已存在 |
| `src/main/windows.ts`（002） | 唤回主窗口（`getMainWindow` / `showMainWindow`） | ✅ 已存在（201 行） |
| `src/main/logger.ts` | `getLogFilePath()`（打开日志项落点） | ✅ 已存在（86 行） |
| `src/main/settings.ts`（008） | `loadSettings()` / `resolveAgentDir()` | ✅ 已存在（110 行） |
| `src/main/update-check.ts`（011） | `checkForUpdates()` | ✅ 已存在（97 行） |

> `forge.config.ts` 的 `extraResource` 已包含 `resources/tray.png`、`resources/trayTemplate.png`，因此图标随包分发无需改打包配置。§5 的导出名为设计期建议，**以源文件为准**。

## 9. 与规格交叉引用

| 规格需求 | 实现落点 |
|---|---|
| FR-003-001…005（单例 / 未就绪也创建 / tooltip / 模板图 / 降级） | §4.2 状态机 + §6.2「图标加载」+ §6.3 |
| FR-003-006…012（五项菜单 / 置灰 / 各动作 / 刷新幂等） | §5.1 `buildMenuTemplate()` + §6.2「菜单重建」 |
| FR-003-013…015（单击行为 / 三种窗口状态 / 聚焦） | §4.3 校验规则 + §6.2「唤回」 |
| FR-003-016…018（退出走链 / 销毁托盘 / 不隐藏窗口） | §3.1 决策表 + §5.1 `disposeTray()` |
| FR-003-019…020（资源生命周期） | §6.3 + §4.2 `destroyed` 态 |
| §5 验收场景 S1–S7 | §7 测试考量（S1/S2/S3/S6 手动；S4/S5/S7 负向与单元） |
