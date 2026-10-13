# 005 — 生命周期与安全（lifecycle）功能规格

> **Module:** 005-lifecycle（生命周期与安全）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应方案:** [`./plan.md`](./plan.md)
> **实现落点:** `src/main/lifecycle.ts`（退出链的调用方在 `src/main/index.ts`，属 007）
> **规划依据:** `docs/工程规划.md` §5.1、§4.2（关闭语义）、§4.5、§4.7、§11.1 R8、§11.4 S1/S4

## 1. 模块概述

### 1.1 目的

生命周期模块的职责是：**在启动最早期做好「单实例 + 安全准备」，在运行期兜住崩溃，在退出时按序走完优雅关闭链并在 deadline 到点强退**。

三件安全准备：① 让 loopback 地址绕开系统代理；② 把系统级 CA 合并进默认信任集；③ 捕获未处理异常与未处理拒绝。它们的共同前提是：**宿主（Next 服务器 + agent）跑在主进程内**，主进程异常即应用级崩溃，且本地请求被代理劫持会直接导致功能不可用。

### 1.2 解决的问题

- **多实例竞争**：每个实例都会绑一个随机端口、各建一套服务器与托盘；用户会看到多份状态与多个通知来源，退出时也容易留下孤儿。必须早在最早期拿单实例锁。
- **代理劫持本地请求**：系统代理开启时，指向 `127.0.0.1` 的请求可能被送往代理，同源加载与 `/api/*` 全部失败。
- **企业 CA 环境证书校验失败**：Electron 默认信任集不含系统 CA，自签/企业代理场景下无法完成校验（§4.5）。
- **静默崩溃**：主进程内一次未捕获异常即可让应用无声退出，用户与开发者都拿不到证据（fail-visible 原则）。
- **退不干净**：⚠️ R8 —— Next 16 的 `server.close()` 在 SSE 长连接未关闭时不会退出；若退出链没有 deadline，就会出现「点了退出进程不走」。

### 1.3 范围

**包含**

- 单实例锁与第二实例唤回。
- `NO_PROXY`/`no_proxy` 注入与 Chromium `proxy-bypass-list <-loopback>`。
- 系统 CA 合并（含能力缺失时的安全降级）。
- 崩溃兜底：`uncaughtException` / `unhandledRejection` 记录。
- `before-quit` 优雅关闭链：停止尾随/通知 → 关闭宿主 → 销毁托盘 → 强退兜底（deadline）。
- 退出链的幂等与阶段留痕。

**不包含**

- Squirrel 安装/卸载事件的静态短路（属 007-app-entry 的入口职责；本模块不读取 `process.argv` 的安装参数）。
- 宿主启动与 `HostHandle.close()` 的实现 → 001-host。
- 窗口创建/状态、托盘、通知的具体实现 → 002/003/004。
- 系统 CA 的「用户自定义证书导入」等产品能力（v1 不做）。
- 开机自启、全局快捷键（§5.8 明确不做）。

## 2. 用户故事

- 作为用户，我希望重复点击图标时只是把已有窗口唤到前台，而不是启动第二个应用、多出一套服务与托盘。
- 作为企业用户（走系统代理 + 自签 CA），我希望应用能正常访问内网模型端点与完成证书校验，而不是启动即报证书或网络错误。
- 作为用户，当应用因某个内部错误出问题时，我希望它要么提示我、要么在日志里留下证据，而不是静默消失。
- 作为用户，我希望「退出」是真的退出：进程结束、不留后台服务、下一次启动能正常起来。
- 作为排障者，我希望退出过程中的每一步（停止尾随、关闭服务器、销毁托盘、强退）都在日志里可读，能判断是「哪一步没走完」。

## 3. 功能需求

动作词：**MUST** 必须满足；**MUST NOT** 禁止；**SHOULD** 建议；**MAY** 可选。

### 3.1 单实例与唤回

- FR-005-001：系统 MUST 在进程启动的**最早期**（早于宿主启动、窗口创建、托盘创建）申请单实例锁；申请失败时 MUST 立即 `app.quit()`，且 MUST NOT 继续做任何初始化。
- FR-005-002：系统 MUST 在收到 `second-instance` 事件时唤回主窗口：最小化则 `restore()`，然后 `show()` + `focus()`。
- FR-005-003：主窗口不存在（尚未创建或已被销毁）时，第二实例唤回 MUST 交由 007-app-entry 重建窗口，**MUST NOT** 在本模块内部直接建窗。

### 3.2 代理绕过

- FR-005-004：系统 MUST 把 loopback 主机（`127.0.0.1`、`localhost`、`::1`）并入 `NO_PROXY` 与 `no_proxy`（大小写双键），合并 MUST 幂等去重且 MUST 保留用户已有条目。
- FR-005-005：系统 MUST 在 `app.whenReady()` **之前**调用 `app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>')`，使渲染进程对 loopback 直连。
- FR-005-006：代理绕过 MUST 只覆盖 loopback，**MUST NOT** 扩大豁免范围到其它主机（不得使用通配符）。

### 3.3 系统证书

- FR-005-007：系统 MUST 在启动时把系统级 CA 证书（`system` 来源）与默认证书（`default` 来源）合并后写回默认信任集（去重）。
- FR-005-008：底层运行时不提供证书读取/设置能力时，系统 MUST 安全降级：跳过合并、不抛错、不中断启动（记录 INFO/WARN 说明已跳过）。
- FR-005-009：证书合并 MUST NOT 丢弃已有默认证书（只做并集），MUST NOT 修改系统证书存储。

### 3.4 崩溃兜底

- FR-005-010：系统 MUST 注册 `process.on('uncaughtException')` 并记录异常（含消息与栈）。
- FR-005-011：系统 MUST 注册 `process.on('unhandledRejection')` 并记录拒绝原因。
- FR-005-012：崩溃记录 MUST 带来源标记（区分 `uncaughtException` 与 `unhandledRejection`）以便排查。
- FR-005-013：崩溃记录 MUST NOT 静默：必须落应用日志（`<userData>/logs/`），且 SHOULD 经 002 的 loading 页/界面提示用户「应用遇到内部错误，详情见日志」。
- FR-005-014：崩溃记录 MUST NOT 输出凭据、API Key 与会话正文（与 §11.4 S2 一致）。

### 3.5 优雅关闭链与强退

- FR-005-015：系统 MUST 在 `before-quit` 中按固定顺序执行关闭链：**置 `isQuitting` → 停止会话尾随/通知 → 关闭宿主（`HostHandle.close()`）→ 销毁托盘 → 退出进程**。
- FR-005-016：关闭链 MUST 幂等：重复触发（用户重复点击退出、关窗与托盘退出并发）MUST NOT 重复执行各步。
- FR-005-017：关闭链 MUST 有 deadline（`SHUTDOWN_DEADLINE_MS`，默认 5000 ms）；到点未结束 MUST 强制退出进程（`app.exit(0)`），**MUST NOT** 让进程继续挂住。
- FR-005-018：关闭链中 MUST 记录每一步的开始/结束与耗时；被 deadline 强退时 MUST 记录「哪一步未完成」。
- FR-005-019：退出过程 MUST NOT 做清理性删除：**MUST NOT** 删除 `<userData>/pi-dist`、会话文件、日志或用户设置（解压幂等与升级语义见 009）。
- FR-005-020：系统 MUST NOT 在「关窗即退出」路径上拦截窗口关闭（与 002 FR-002-028 一致）。

### 3.6 安全自查配合

- FR-005-021：生产构建 MUST NOT 启用 `--inspect` / `--remote-debugging-port`（§11.4 S1/S4；本模块与 002/010 共同守此约束）。
- FR-005-022：系统 SHOULD 在启动日志中打印运行时常量（Electron 版本、Node 版本、`app.isPackaged`、`agentDir` 路径）作为取证基线，但 MUST NOT 打印任何凭据。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| 单实例守卫 | 锁的持有状态 | `gotLock: boolean`、`secondInstance` 监听 |
| 关闭链（ShutdownChain） | 退出流程的单例状态机 | `isQuitting: boolean`、`running: Promise<void> \| null`、`deadlineTimer`、`completedSteps: string[]` |
| 崩溃记录 | 未处理异常/拒绝的日志条目 | `source: 'uncaughtException' \| 'unhandledRejection'`、`message`、`stack`、`at` |
| 代理豁免表 | `NO_PROXY`/`no_proxy` 的合并结果 | loopback 集合、用户既有条目、去重后字符串 |
| CA 合并结果 | 证书合并是否生效 | `supported: boolean`、`mergedCount: number` |

## 5. 验收场景

### 场景 S1：单实例与唤回

- Given 应用已有一个运行实例且窗口最小化
- When 用户再次启动应用
- Then 第二实例立即退出、不创建窗口/服务器/托盘；已有实例窗口被还原并聚焦

### 场景 S2：代理环境下本地请求直连

- Given 系统配置了代理，且 `NO_PROXY` 已有部分条目
- When 应用启动
- Then loopback 主机被追加进两个大小写键且无重复项；渲染进程对 `http://127.0.0.1:<port>` 的访问直连、不被代理

### 场景 S3：系统 CA 合并

- Given 运行时支持读取/设置默认证书
- When 启动时执行合并
- Then 默认信任集包含系统 CA，且原有默认证书未丢失

### 场景 S4：能力缺失安全降级

- Given 运行时不提供证书合并能力
- When 启动时执行合并
- Then 跳过合并、记录 WARN、启动流程继续（不抛错）

### 场景 S5：未处理异常留痕

- Given 主进程内发生一次未捕获异常
- When 异常抛出
- Then 日志中出现带来源标记的完整记录（消息 + 栈）；不出现「静默退出且无痕迹」

### 场景 S6：优雅退出

- Given 应用运行中（宿主就绪、托盘已创建、尾随在运行）
- When 用户从托盘选择「退出」
- Then 按序：停止尾随 → 关闭宿主 → 销毁托盘 → 进程退出；日志中每步可见；进程列表无残留

### 场景 S7：deadline 强退

- Given 宿主 `close()` 被 SSE 长连接挂住（⚠️ R8）
- When 关闭链超过 deadline（5 s）
- Then 进程被强制退出；日志记录「哪一步未完成」；重新启动应用正常

### 场景 S8：退出不删数据

- Given 应用退出前后比较 `<userData>` 内容
- When 退出链执行完成
- Then `pi-dist/`、会话文件、日志、`pi-desktop-settings.json` 均未被删除

## 6. 非功能需求

- **健壮性**：证书能力缺失降级；代理豁免幂等；关闭链幂等且有强退兜底；任一环节异常不得让退出流程静默停止。
- **可诊断性**：关闭链每步留痕；崩溃记录含来源与栈；⬜ 生产环境是否保留栈的完整度待定（不建议裁剪）。
- **安全性**：只豁免 loopback；只做证书并集；不打印凭据；不启用调试参数（§11.4 S1/S2/S4）。
- **兼容性**：对底层运行时不提供的较新 API 一律用能力探测（`typeof === 'function'`）而非版本比较。
- **启动开销**：三项安全准备均为毫秒级、一次性，无热路径。

## 7. 假设与约束

- **假设（🔶 沿用 dsh）**：三项安全准备的形态（`NO_PROXY` 双键合并、`<-loopback>`、`getCACertificates`/`setDefaultCACertificates` 合并、崩溃兜底记录）沿用 `dsh-desktop` 的已验证范式（§4.5、§4.9）。
- **假设（⬜ 待验证 P0-2）**：Electron 43.7.9 内置 Node 24.21.0 提供 `node:tls` 的 `getCACertificates` / `setDefaultCACertificates`（Node 24.4+ 引入）。若不提供，则按 FR-005-008 降级，并在 `docs/桌面能力清单.md` 登记。
- **假设（⬜ 待验证）**：`proxy-bypass-list <-loopback>` 在 Chromium 150 下对 `webRequest`/fetch 均生效（🔶 dsh 经验）；需在 P0-3 中用「设置假代理」的方式实测。
- **约束**：单实例锁必须在最早时机获取 —— 因此本模块的 `installSingleInstanceGuard()` 必须在 007 的入口顶层、`whenReady` 之前调用，且在 Squirrel 短路之后（安装器进程不应去抢锁）。
- **约束**：关闭链**不负责**关闭「其它进程」（本工程默认无子进程）；若 001 启用候选 B 回退，进程树清理成为额外义务（登记于 001 的 plan §3.4）。
- **约束**：崩溃兜底只做「记录 + 提示」，不做自动重启/自动恢复（避免掩盖问题；重启需求属 Phase 2 评估）。
- **⬜ 待验证**：Electron 主进程内 `SIGINT`/`SIGTERM` 的处理路径是否与 upstream `instrumentation-node.ts` 的 SSE 关闭逻辑衔接（若衔接不上，则 `HostHandle.close()` 可能就是「挂着不退出」，由 deadline 强退兜底）。

## 8. 依赖

**上游（被本模块消费）**

- 001-host：`HostHandle.close()`（关闭链的一步）。
- 004-notification：`stopSessionWatch()` / `stopNotifications()`（关闭链的一步）。
- 003-tray：`disposeTray()`（关闭链的一步）。
- 002-window：`showMainWindow()` / `getMainWindow()`（第二实例唤回）。

**下游（消费本模块）**

- 007-app-entry：入口顶层调用单实例守卫与安全准备；`before-quit` 触发关闭链。

**外部**

- Electron `app`（`requestSingleInstanceLock`、`second-instance`、`before-quit`、`commandLine`、`exit`）、`node:tls`、`process` 事件、操作系统代理与证书存储。
