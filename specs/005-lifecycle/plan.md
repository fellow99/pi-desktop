# 005 — 生命周期与安全（lifecycle）技术实现方案

> **Module:** 005-lifecycle（生命周期与安全）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应规格:** [`./spec.md`](./spec.md)
> **架构基线:** `docs/工程规划.md` §5.1、§4.2、§4.5、§4.7、§11.1 R8、§11.4 S1/S2/S4

## 1. 技术上下文

### 1.1 运行时环境

- **运行位置**：Electron 主进程（Node 24.21.0；Electron **43.7.9**）。
- **调用时机**（两处，全部在 007-app-entry 中接线）：
  1. `installSingleInstanceGuard()` + `installSecurityPrelude()`：**入口顶层**、`whenReady` 之前（Squirrel 短路之后）。
  2. `runShutdownChain()`：`app.on('before-quit')` 中。
- **编译产物**：`src/main/lifecycle.ts` → `.vite/build/main.js`。
- **关键约束**：`app.commandLine.appendSwitch` 必须在 `whenReady` 之前生效；`requestSingleInstanceLock` 必须早于任何窗口/服务器创建。

### 1.2 依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `electron`（`app`） | 内置 | `requestSingleInstanceLock`、`second-instance`、`before-quit`、`commandLine`、`exit` |
| `node:tls`（能力探测后动态 `require`） | 内置 | `getCACertificates('default' \| 'system')` → `setDefaultCACertificates()` |
| `process` | 内置 | `process.env`（`NO_PROXY`/`no_proxy`）、`process.on('uncaughtException'/'unhandledRejection')` |
| `src/main/constants.ts` | 本项目（✅ 已存在） | `SHUTDOWN_DEADLINE_MS=5_000`、`APP_ID`、`PRODUCT_NAME`、`LOG_DIR_NAME` |
| `src/main/logger.ts` | 本项目（✅ 已存在） | `logInfo/logWarn/logError/describeError/getStage` |
| `src/main/windows.ts`（002） | 本工程 | `showMainWindow()`、`getMainWindow()`（第二实例唤回） |
| `src/main/host.ts`（001） | 本工程 | `HostHandle.close()`（关闭链第二步） |
| `src/main/notifications.ts`（004） | 本工程 | `stopSessionWatch()` / `stopNotifications()`（关闭链第一步） |
| `src/main/tray.ts`（003） | 本工程 | `disposeTray()`（关闭链第三步） |

> 无第三方依赖，纯 Electron / Node 内置能力。

## 2. 宪法合规检查

| 原则（`docs/工程规划.md` §3 / §4.5 / §4.7 / §11.4） | 状态 | 说明 |
|---|---|---|
| 单实例前置（§5.1） | ✅ | 入口顶层申请锁，失败即退（FR-005-001） |
| 安全：代理绕过（§4.5） | ✅ | 双键 `NO_PROXY` + `proxy-bypass-list`，只豁免 loopback（FR-005-004…006） |
| 安全：系统 CA 合并 + 能力降级（§4.5） | ✅ | 能力探测 + 并集写回（FR-005-007…009） |
| fail-visible（§3 原则 5、§4.7） | ✅ | 崩溃兜底 + 关闭链逐步骤留痕（FR-005-010…013、FR-005-018） |
| 优雅关闭与 deadline（§4.2、R8） | ✅ | 固定顺序 + `SHUTDOWN_DEADLINE_MS` 强退（FR-005-015…017） |
| 数据安全：不做清理性删除（§8.3） | ✅ | 退出链不删 `pi-dist`/会话/日志（FR-005-019） |
| 安全 S1/S2/S4（§11.4） | ✅ | 不注册调试参数、不打印凭据（FR-005-014、FR-005-021、FR-005-022） |
| 零上游改动（§7） | ✅ | 不涉及上游文件 |
| 代码质量：strict TS、无 `as any`、严禁空 catch | ⬜ | 代码已落地（2026-10-12 复核），待人工评审；`node:tls` 能力探测用局部 interface 断言（非 `as any`，🔶 dsh 做法） |

> 合规结论：安全/生命周期项全部 ✅；⬜ 项在实现落地后复核。

## 3. 研究结论

### 3.1 关键决策与理由

| 决策 | 理由 | 对应 FR |
|---|---|---|
| 单实例锁在入口最早期、Squirrel 短路之后 | 安装器进程不应抢锁；抢占锁之后失败的实例必须立即退出，避免半初始化 | FR-005-001、FR-005-003 |
| 第二实例只唤回、不重建窗口 | 建窗是 002/007 的职责，避免生命周期模块持有窗口逻辑 | FR-005-002、FR-005-003 |
| `NO_PROXY` 大小写双键 + `<-loopback>` | 不同工具读不同键；`<-loopback>` 让渲染进程也直连（🔶 dsh 经验） | FR-005-004、FR-005-005 |
| 证书合并用能力探测（而非版本号比较） | 较新 API 在类型定义与旧运行时都可能缺失；探测最稳且可降级 | FR-005-008 |
| 崩溃兜底「记录 + 提示」，不自动重启 | 自动重启会掩盖问题且与「关窗即退出」语义冲突 | FR-005-010…013 |
| 关闭链固定顺序：尾随/通知 → 宿主 → 托盘 → 退出 | 先停生产事件者（避免关到一半又弹通知）、再关服务（可能阻塞）、再拆 UI 资源 | FR-005-015 |
| deadline 5 s 强退（`app.exit(0)`） | ⚠️ R8：SSE 未断时 `server.close()` 不返回；必须有兜底 | FR-005-017 |
| 退出链**不删**任何用户数据 | 解压幂等由 marker 保证（009）；删除会破坏「升级不残留」与用户数据安全 | FR-005-019 |

### 3.2 上游/参考核实（✅ / 🔶 / ⬜）

| # | 事实 | 依据 |
|---|---|---|
| U1 | 关闭语义：Next 16 的 `server.close()` 在 SSE 长连接未关闭时**永不退出**；upstream `instrumentation-node.ts` 在 `SIGINT`/`SIGTERM` 时先关 SSE | ⚠️ §4.2 + 🔶 HOS 结论；⬜ Electron 主进程内的信号路径是否触达该逻辑待验 |
| U2 | 宿主的关闭 deadline 常量已存在：`SHUTDOWN_DEADLINE_MS = 5_000`；`PI_WEB_SHUTDOWN_DEADLINE_MS` 是登记的上游开关 | ✅ `src/main/constants.ts:52`、`docs/工程规划.md` 附录 B |
| U3 | `NO_PROXY` 双键 + `proxy-bypass-list <-loopback>` 是本工程采用的范式 | 🔶 §4.5（沿用 dsh）；⬜ P0-3 实测代理场景 |
| U4 | 系统 CA 合并：`getCACertificates('default'\|'system')` → `setDefaultCACertificates()`，能力缺失时静默跳过 | 🔶 §4.5（沿用 dsh）；⬜ P0-2 在 Electron 43.7.9（Node 24.21）上确认 API 存在 |
| U5 | 单实例 + 第二实例唤回的实现范式（`requestSingleInstanceLock` + `second-instance` → `restore/show/focus`） | 🔶 §5.1（dsh 范式） |
| U6 | 应用 ID `com.fellow99.pi.desktop` 已作为常量存在（Windows 通知归组依赖它） | ✅ `src/main/constants.ts:10` |
| U7 | 本工程默认**无子进程**，因此关闭链不包含进程树清理；仅当 001 启用候选 B 时追加 | ✅ §4.2（决策 Q2）+ 001 的 plan §3.4 |

### 3.3 退出链时序

```
用户动作（关窗 / 托盘退出 / macOS Cmd+Q）
  → app.quit()
  → 'before-quit'
       ├─ if (chain.running) { event.preventDefault(); return; }        # 幂等（FR-005-016）
       ├─ chain.isQuitting = true
       ├─ event.preventDefault()                                         # 自己掌控退出时机
       ├─ chain.running = (async () => {
       │     t0 = now()
       │     step('stop-watch',   stopSessionWatch + stopNotifications)  # ④ 模块
       │     step('close-host',   host.close())                          # ① 模块（可能阻塞：SSE）
       │     step('dispose-tray', disposeTray())                         # ③ 模块
       │     log每步耗时
       │   })()
       ├─ deadlineTimer = setTimeout(() => {
       │     logError('关闭链超过 deadline，强退；未完成步骤 = ' + chain.completedSteps)
       │     app.exit(0)                                                 # FR-005-017
       │   }, SHUTDOWN_DEADLINE_MS)
       └─ chain.running.finally(() => { clearTimeout(deadlineTimer); app.exit(0) })
```

规则：

- **先 `preventDefault` 再异步关闭**：否则 Electron 会在 `before-quit` 返回后立刻开始销毁，宿主来不及有序关闭。
- **强退只兜底、不替代**：正常路径应当 `close()` 返回后立即 `app.exit(0)`（不等待额外的 `will-quit`）。
- 若 `close()` 抛错（例如服务器早就崩了），记录 WARN 后继续执行后续步骤，**不得**因一步失败而跳过其余步骤。

## 4. 数据模型

### 4.1 实体

| 实体 | 字段 | 说明 |
|---|---|---|
| `SingleInstanceGuard` | `gotLock: boolean` | `requestSingleInstanceLock()` 结果（FR-005-001） |
| `ShutdownChain` | `isQuitting: boolean`、`running: Promise<void> \| null`、`completedSteps: string[]`、`deadlineTimer: NodeJS.Timeout \| null` | 关闭链单例状态（FR-005-015…018） |
| `CrashRecord` | `{ source, message, stack, at }` | 崩溃日志（FR-005-010…012） |
| `ProxyBypass` | `{ upper: string; lower: string }` | 合并后的两个环境变量值 |
| `CaMergeResult` | `{ supported: boolean; mergedCount: number }` | 证书合并结果（FR-005-007、FR-005-008） |

### 4.2 状态机

```
running
  → quitting        （before-quit 首触发：isQuitting = true）
  → closing         （关闭链执行中：completedSteps 递增）
  → exited          （正常结束 或 deadline 强退）

第二实例：running → （唤回窗口）→ running
崩溃：任意状态 → 记录 CrashRecord → 保持运行（或由具体错误决定退出）
```

### 4.3 校验规则

- `NO_PROXY` 合并：按 `,` 拆分 → `trim` → 过滤空串 → 与 loopback 集合取并集 → 用 `,` 重写；用 `Set<string>` 去重（幂等）。
- 证书合并：`Set([...getCACertificates('default'), ...getCACertificates('system')])` → `setDefaultCACertificates([...set])`；仅在两个函数都是 `function` 时执行。
- 关闭链幂等：`chain.running !== null` 时直接 `return`（不重复执行、不重复 preventDefault）。
- 强退判定：`completedSteps` 与预期步骤列表做差集，差集写入错误日志（便于定位「哪一步没走完」）。

## 5. 接口契约

### 5.1 提供接口（本模块导出）

| 导出 | 签名 | 说明 |
|---|---|---|
| `installSingleInstanceGuard(onSecondInstance)` | `(cb: () => void) => boolean` | 申请锁；返回是否获得；注册 `second-instance`（FR-005-001…003） |
| `installProxyBypass()` | `() => void` | 双键 `NO_PROXY` 合并 + `proxy-bypass-list`（FR-005-004、FR-005-005） |
| `setupSystemCertificates()` | `() => void` | CA 并集合并（能力探测 + 降级）（FR-005-007…009） |
| `installCrashHandlers()` | `() => void` | `uncaughtException` / `unhandledRejection` 记录（FR-005-010…013） |
| `installSecurityPrelude()` | `() => void` | 组合：代理绕过 + 证书 + 崩溃兜底（007 一次调用） |
| `runShutdownChain(deps)` | `(d: ShutdownDeps) => Promise<void>` | 关闭链（幂等 + deadline 强退）（FR-005-015…019） |

### 5.2 消费接口（本模块依赖）

| 来源 | 符号 |
|---|---|
| `electron.app` | `requestSingleInstanceLock`、`on('second-instance'/'before-quit')`、`commandLine.appendSwitch`、`exit` |
| `node:tls` | `getCACertificates`、`setDefaultCACertificates`（探测后调用） |
| 001-host / 003-tray / 004-notification | `close()` / `disposeTray()` / `stopSessionWatch()`+`stopNotifications()` |
| 002-window | `showMainWindow()`、`getMainWindow()` |
| `src/main/logger.ts` | `logInfo/logWarn/logError/describeError` |

### 5.3 事件协议

| 事件 | 来源 → 处理 | 说明 |
|---|---|---|
| `second-instance` | Electron → 本模块 → `onSecondInstance` 回调 | 唤回窗口（FR-005-002） |
| `before-quit` | Electron → 本模块 `runShutdownChain()` | 关闭链（FR-005-015） |
| `uncaughtException` / `unhandledRejection` | `process` → 本模块 | 崩溃记录（FR-005-010…012） |

> 无自定义 IPC；不向渲染层发送任何消息（崩溃提示经 002 的 loading 页接口转发）。

## 6. 实现策略

### 6.1 架构模式

**无状态工具函数 + 一个单例关闭链**：`installProxyBypass` / `setupSystemCertificates` / `installCrashHandlers` 彼此独立、幂等、无状态（便于单测）；只有关闭链持有模块级状态（`isQuitting`、`running`）。所有外部依赖（宿主的 `close`、托盘的 `dispose` 等）经 `ShutdownDeps` 注入，避免 `lifecycle.ts` 反向依赖 001/003/004（防止循环 import）。

### 6.2 关键算法

- **代理豁免合并**：见 §4.3（幂等、保留用户条目、只加 loopback）。
- **证书合并**：见 §4.3；`try/catch` 包住两个调用，异常 → `logWarn` + 返回 `{ supported: false }`。
- **崩溃记录**：`logError('[uncaughtException] ' + describeError(err))`；`unhandledRejection` 同理带上 `reason`（可能是非 Error 值，需 `describeError` 归一化）；随后调用 002 的提示接口（若窗口存在）。
- **关闭链**：见 §3.3；每步包 `try/catch`，失败记录 WARN 后继续下一步。

### 6.3 错误处理

- 锁获取失败：**不做任何清理**（本实例什么都没创建），直接 `app.quit()`。
- 关闭链某步失败：记录 + 继续（步骤级隔离）；全部结束后 `app.exit(0)`。
- 强退路径：`logError` 先写盘再 `app.exit(0)`（日志写入在 logger 中是同步 `appendFileSync`，可不丢）。
- **严禁空 catch**：崩溃兜底本身的 `catch` 必须有日志或明确返回值。

### 6.4 性能

- 三件安全准备均为启动期一次性操作（毫秒级）。
- 关闭链的每步都是 IO/网络等待；总时长由 `SHUTDOWN_DEADLINE_MS` 上限约束。
- 不做轮询、不常驻定时器（除 deadline 计时器，退出时清除）。

## 7. 测试考量

| 层次 | 方式 | 覆盖需求 |
|---|---|---|
| 静态 | `npm run typecheck` | 全部 |
| 单元 | 代理豁免合并：`NO_PROXY` 为空 / 已有条目 / 已含 loopback / 含空格与空项 四种输入 | FR-005-004、FR-005-006 |
| 单元 | 证书合并：mock `node:tls` 存在 / 缺失两种分支，断言调用与降级返回 | FR-005-007、FR-005-008 |
| 单元 | 崩溃兜底：mock `process.on`，断言两个事件被注册；再注入一次异常断言日志被调用 | FR-005-010…012 |
| 单元 | 关闭链：注入假 deps（记录调用顺序），断言顺序 = 尾随 → 宿主 → 托盘；重复调用只执行一次 | FR-005-015、FR-005-016 |
| 单元 | 关闭链超时：假 `close()` 永不 resolve + 假计时器 → 断言强退被触发且记录了未完成步骤 | FR-005-017、FR-005-018 |
| 手动 | 双启动唤回、代理环境直连、三平台退出后无残留进程 | FR-005-001…005、FR-005-015 |
| 探针 | **P0-2**：确认 `node:tls` 能力；**P0-3**：代理场景实测；**P0-6**：打包后退出无残留 | FR-005-005、FR-005-008、FR-005-017 |
| 负向 | 让 `host.close()` 抛错 → 断言后续步骤仍执行；把 `SHUTDOWN_DEADLINE_MS` 设为 1 ms → 断言仍能退出 | FR-005-015、FR-005-017 |

## 8. 文件清单

| 文件 | 用途 | 状态（2026-10-12 复核） |
|---|---|---|
| `src/main/lifecycle.ts` | 代理绕过 + 系统 CA + 崩溃兜底 + 关闭快照 | ✅ 已存在（79 行；实际导出 `ensureLoopbackNoProxy` / `setupSystemCertificates` / `installCrashHandlers` / `logShutdownSnapshot`；单实例锁实际在 `src/main/index.ts` 入口顶层） |
| `src/main/constants.ts` | `SHUTDOWN_DEADLINE_MS`、`APP_ID`、`PRODUCT_NAME` | ✅ 已存在（56 行） |
| `src/main/logger.ts` | 关闭链与崩溃记录落盘（`getLogFilePath()`） | ✅ 已存在（86 行） |
| `src/main/host.ts`（001） | 宿主关闭（`closeWithDeadline` 等） | ✅ 已存在（518 行） |
| `src/main/tray.ts`（003） | `destroyTray()` | ✅ 已存在（87 行） |
| `src/main/windows.ts`（002） | 主窗口引用与唤回（`getMainWindow`） | ✅ 已存在（201 行） |
| `src/main/notifications.ts` + `session-watch.ts`（004） | `setupNotifications()` 的取消函数 / `stopSessionWatch()` | ✅ 已存在（63 / 188 行） |
| `src/main/index.ts`（007） | 入口顶层接线 + `before-quit` 绑定 + 关闭链编排 | ✅ 已存在（327 行） |

> §5 的导出名为设计期建议，**以源文件为准**（单实例锁与关闭链编排实际落在入口 `index.ts`）。

## 9. 与规格交叉引用

| 规格需求 | 实现落点 |
|---|---|
| FR-005-001…003（单实例 / 唤回 / 不建窗） | §3.1 决策表 + §5.1 `installSingleInstanceGuard()` |
| FR-005-004…006（代理绕过 / 只豁免 loopback） | §4.3 + §6.2「代理豁免合并」 |
| FR-005-007…009（CA 合并 / 能力降级 / 不丢证书） | §4.3 + §6.2「证书合并」 |
| FR-005-010…014（崩溃兜底 / 来源标记 / 不静默 / 无凭据） | §6.2「崩溃记录」+ `logger.ts` |
| FR-005-015…020（关闭链 / 幂等 / deadline / 不删数据 / 不拦截关窗） | §3.3 时序 + §4.3 校验规则 + §6.2「关闭链」 |
| FR-005-021…022（无调试参数 / 取证基线日志） | §2 合规表 + §6.3 |
| §5 验收场景 S1–S8 | §7 测试考量（S1/S2/S3/S4/S5 单元+手动；S6/S7/S8 手动与负向） |
