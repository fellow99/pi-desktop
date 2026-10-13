# 004 — 原生通知（notification）技术实现方案

> **Module:** 004-notification（原生通知）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应规格:** [`./spec.md`](./spec.md)
> **架构基线:** `docs/工程规划.md` §5.4、§4.8、§9.3、§11.2 O1、§11.1 R7

## 1. 技术上下文

### 1.1 运行时环境

- **运行位置**：Electron 主进程；尾随器与通知器都在主进程内，**不依赖渲染层**（窗口隐藏或渲染进程重载时通知仍可靠）。
- **调用时机**：007-app-entry 在宿主就绪后调用 `startSessionWatch()` + `initNotifications()`；退出链中调用 `stopSessionWatch()`。
- **编译产物**：`src/main/session-watch.ts`（纯尾随/解析）、`src/main/notifications.ts`（策略 + 弹通知）→ `.vite/build/main.js`。拆成两个文件是为了让「解析」可单测、且策略可独立替换（换事件源时不重写解析）。

### 1.2 依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `electron`（`Notification` / `app`） | 内置 | 原生通知；`app.isReady()` 守卫 |
| `node:fs` | 内置 | `watch`、`statSync`、`openSync`/`readSync`（增量读）或 `createReadStream({start, end})` |
| `node:path` | 内置 | `path.join(agentDir, 'sessions')` 与递归收集 `*.jsonl` |
| `src/main/constants.ts` | 本项目（✅ 已存在） | `NOTIFICATION_COOLDOWN_MS=10_000`、`SESSION_WATCH_INTERVAL_MS=2_000`、`PRODUCT_NAME`、`APP_ID` |
| `src/main/logger.ts` | 本项目（✅ 已存在） | `logInfo/logWarn/logError/describeError` |
| `src/main/windows.ts`（002） | 本工程 | `getMainWindow()` → `isVisible()` / `isFocused()` / `isMinimized()` |
| `src/main/settings.ts`（008） | 本工程（✅ 已存在） | `loadSettings()` / `resolveAgentDir()`（拿 `agentDir`） |

> 无第三方依赖；**不引入 chokidar 之类**：上游 `pi` 的会话目录结构固定（`sessions/<cwd 编码>/*.jsonl`），`fs.watch` + 定时兜底足够，且避免新依赖。

## 2. 宪法合规检查

| 原则（`docs/工程规划.md` §3 / §5.4 / §11.4） | 状态 | 说明 |
|---|---|---|
| 零上游改动优先（§3 原则 1；§7） | ✅ | JSONL 尾随是零补丁路线；不 import 上游内部事件模块（FR-004-001） |
| 只写装配代码（§3 原则 3） | ✅ | 本模块只做「读文件 + 判条件 + 弹通知」 |
| 数据面零 IPC（§3 原则 4） | ✅ | 不引入 IPC；渲染层无关（FR-004-001） |
| 失败可见 fail-visible（§3 原则 5） | ✅ | 统计与延迟落日志；事件源缺失 WARN（FR-004-016、FR-004-017） |
| 隐私与安全 S2（§11.4） | ✅ | 通知与日志不含会话正文；不输出凭据（FR-004-012、FR-004-018） |
| 平台差异显式化（§3 原则 6；§9.3） | ✅ | Windows 依赖 AppUserModelId；Linux 依赖桌面环境；降级为静默 + WARN（FR-004-013、FR-004-015） |
| 明确不做项不偷做（§9.2） | ✅ | 不做通知持久化/免打扰/交互按钮（§1.3 不包含） |
| 代码质量：strict TS、无 `as any`、严禁空 catch | ⬜ | 代码已落地（2026-10-12 复核），待人工评审 |

> 合规结论：架构与隐私项 ✅；⬜ 项集中在「事件源形状」与「代码质量」，前者由 P0-5 定标。

## 3. 研究结论

### 3.1 关键决策与理由

| 决策 | 理由 | 对应 FR |
|---|---|---|
| 事件源 = 会话 JSONL 尾随（方案①） | 零上游补丁、不耦合 `pi-web` 内部模块、与窗口可见性/渲染进程状态无关（✅ §5.4） | FR-004-001 |
| **不采用**备选①「渲染层经 preload 上报」 | 需引入壳层 IPC 与渲染层改动；v1 的 preload 默认空实现（§5.6） | — |
| **不采用**备选②「主进程订阅 `pi-web` SSE/事件模块」 | ⚠️ 耦合上游内部实现，升级即失效（R10） | FR-004-001 |
| 启动基线扫描，不补弹历史 | 历史消息补弹是不可接受的噪音（✅ §5.4 通知策略） | FR-004-009 |
| 仅窗口不可见/未聚焦时弹 | 前台弹通知纯噪音（对齐 dsh 的取舍） | FR-004-007 |
| 同会话冷却 10 s 去重 | 防止同一会话连续事件刷屏 | FR-004-008 |
| 只读、不加锁、不写会话文件 | ⚠️ R7：CLI 与 pi-web 并发写同一会话不受支持；壳层只读即安全 | §7 约束 |
| 事件类型只区分「完成 / 出错 / 会话信息」 | 主进程无审批/工具调用事件源（那在 SSE 里）；不臆造上游语义 | FR-004-010 |

### 3.2 上游/参考核实（✅ / 🔶 / ⬜）

| # | 事实 | 依据 |
|---|---|---|
| U1 | 会话落点：`sessions/--<cwd 编码>--/<timestamp>_<session-id>.jsonl`，version 3 **行式 JSONL**（`pi` 的 `durable` 存储层写 `format`/`type: "commit" \| "record"` 记录） | ✅ `docs/工程规划.md` §2.1；✅ 本机核对 `pi/packages/durable/src/storage/jsonl/storage.ts` 存在行式记录类型 |
| U2 | `pi-web` 事件下行是 **SSE**（`GET /api/agent/[id]/events`），**无 WebSocket**；主进程**没有**现成事件钩子 | ✅ §2.2、§5.4 |
| U3 | `dsh-desktop` 的通知直接订阅宿主进程内 `ctx.on('session/event')` —— 本工程**没有**等价物 | 🔶 §2.3、§5.4（dsh 的 `004-notification/spec.md` 事件源不可移植） |
| U4 | 会话 JSONL 的**写入时机**（turn 结束 vs 流式增量）与「完成/错误」在行中的标识形态 | ⬜ **P0-5 探针**（§5.4、§11.2 O1）；本模块不得硬编码未验证结构 |
| U5 | 上游 e2e 注明：`pi-web` 与 `pi` CLI**并发写同一会话 JSONL 不受支持** | ✅ §11.1 R7 |
| U6 | 日志落点与获取方式：`getLogFilePath()`（`<userData>/logs/pi-desktop-<YYYYMMDD>.log`） | ✅ `src/main/logger.ts:34`、§4.6 |
| U7 | Windows 通知须 `app.setAppUserModelId(APP_ID)` 才正确显示与归组 | ✅ §5.4；常量 `APP_ID='com.fellow99.pi.desktop'` 已存在（`src/main/constants.ts:10`） |

### 3.3 尾随算法（增量、固定内存）

```
collectSessionFiles(agentDir)                  # 递归匹配 sessions/**/*.jsonl（按需缓存在 Map）
for each file:
    size = statSync(file).size
    if (!offsets.has(file)) { offsets.set(file, size); continue; }   # 新文件：默认从末尾起（不补弹）
    if (size < offsets.get(file)) { offsets.set(file, size); continue; }  # 截断/轮转：重置
    if (size === offsets.get(file)) continue
    read from offsets.get(file) to size as Buffer        # 只读增量，不带入整个文件
    split by '\n'；末尾不完整行留在行缓冲，不消费
    for each complete line: parseTurnEvent(line) → TrailingEvent | null
    offsets.set(file, size)
```

要点：

- **新文件默认从末尾起**（而不是 0）：新会话文件在 `fs.watch` 命中时通常已有内容（会话头/首轮），从 0 读会把「刚打开的一次对话」当成事件；同时避免重建索引时的历史回灌。⬜ P0-5 需确认「新建会话的首轮完成」是否会被此策略漏掉（若是，则改为「新文件从 0 读但抑制首条会话头记录」）。
- **固定内存**：只保留 `offsets`（每文件一个数字）+ 每文件的行缓冲（上限一个行长度，超限截断并 WARN）。
- **fs.watch + 定时兜底**：`fs.watch(sessionsRoot, { recursive: true })`（Windows/macOS 支持；Linux recursive 支持有限 → ⬜ 若不支持则对各子目录分别 watch）+ `setInterval(SESSION_WATCH_INTERVAL_MS)` 兜底扫描。

## 4. 数据模型

### 4.1 实体

| 实体 | 字段 | 说明 |
|---|---|---|
| `SessionWatcher` | `agentDir`、`offsets: Map<string, number>`、`buffers: Map<string, string>`、`baselineDone: boolean` | 尾随状态（FR-004-002、FR-004-003） |
| `TrailingEvent` | `kind`、`sessionId`、`sessionName?`、`at` | 识别结果（FR-004-010、FR-004-016） |
| `NotificationState` | `lastNotifiedAt: Map<string, number>`、`counts: { events, notified, suppressed }` | 冷却表与统计（FR-004-008、FR-004-016） |

### 4.2 状态机

```
idle
  → baselining     （首次扫描：仅建立 offsets 基线，不发通知）
  → tailing        （增量读取 + 事件识别 + 通知决策）
  → suspended      （事件源不可用：WARN + 保持静默，定时器保留但不报错）
  → stopped        （stopSessionWatch()：关 watcher、清定时器）

通知决策：foreground（窗口可见且聚焦 → 丢弃）
        / cooldown（同会话在冷却窗口内 → 丢弃）
        / ok（发出 Notification） / no-source（事件源不可用 → 丢弃）
```

### 4.3 校验规则

- 可见性判定：`win = getMainWindow()`；`win && !win.isDestroyed() && win.isVisible() && win.isFocused() && !win.isMinimized()` → 视为前台 → 丢弃。
- 冷却判定：`now - (lastNotifiedAt.get(sessionId) ?? 0) < NOTIFICATION_COOLDOWN_MS` → 丢弃。
- 行解析：`JSON.parse` 失败 → 跳过；行长度超过上限（如 256 KB）→ 截断处理并 WARN（不输出内容）。
- 会话标识：会话名优先，缺失则用 `sessionId` 前 8 位（FR-004-011）。
- 通知可用性：`Notification.isSupported()` 为假 → WARN 并停止发通知（后续仍统计）。

## 5. 接口契约

### 5.1 提供接口（本模块导出）

| 导出 | 签名 | 说明 |
|---|---|---|
| `startSessionWatch(agentDir)` | `(agentDir: string) => void` | 建立基线并开始尾随（幂等） |
| `stopSessionWatch()` | `() => void` | 停止尾随并释放资源（幂等） |
| `onTrailingEvent(handler)` | `(h: (e: TrailingEvent) => void) => void` | 内部订阅（也用于测试注入） |
| `parseTurnEvent(line)` | `(line: string) => TrailingEvent \| null` | 纯函数：行 → 语义事件（唯一受 P0-5 结论影响的点） |
| `startNotifications()` | `() => void` | 装配策略：订阅尾随事件 → 决策 → `new Notification().show()` |
| `stopNotifications()` | `() => void` | 解绑（幂等） |

### 5.2 消费接口（本模块依赖）

| 来源 | 符号 |
|---|---|
| `electron` | `Notification`, `app` |
| `node:fs` | `watch`, `statSync`, `openSync`/`readSync`, `readdirSync`（或 `readdir` with `{ recursive: true }`） |
| `src/main/windows.ts`（002） | `getMainWindow()` |
| `src/main/settings.ts`（008） | `resolveAgentDir(loadSettings())` |
| `src/main/logger.ts` | `logInfo/logWarn/logError/describeError` |

### 5.3 事件协议（内部）

| 事件 | 载荷 | 产生者 → 消费者 |
|---|---|---|
| `trailing-event` | `TrailingEvent` | `session-watch.ts` → `notifications.ts` |
| `notification-suppressed` | `{ sessionId, reason }` | `notifications.ts` → 日志（统计） |
| `notification-shown` | `{ sessionId, kind, latencyMs }` | `notifications.ts` → 日志（P0-5 取证） |

> 无 IPC、无渲染层合同；事件只在主进程内以回调形式传递。

## 6. 实现策略

### 6.1 架构模式

**生产者/消费者分离**：`session-watch.ts` 只负责「文件 → 事件」（可单测、无 Electron 依赖），`notifications.ts` 只负责「事件 → 决策 → 通知」（依赖 002 的窗口状态）。换事件源时只替换生产者（§3.2 U4 的探针结论可能要求替换 `parseTurnEvent`）。

### 6.2 关键算法

- **增量读取**：`fd = openSync(file, 'r')` → `readSync(fd, buf, 0, size - offset, offset)` → `closeSync(fd)`；单次读取上限（如 1 MB/文件/轮）防止大爆发阻塞主进程。
- **行缓冲**：把本次读到的文本拼到该文件的残留缓冲；按 `\n` 切分；最后一段（无换行结尾）留回缓冲。
- **决策顺序**（短路）：事件源可用？→ 前台？→ 冷却？→ 发通知。
- **延迟度量**：`latencyMs = Date.now() - event.at`（`event.at` 来自行内时间戳；缺失则记 `null` 并不计入统计）。

### 6.3 错误处理

- `statSync`/`openSync` 失败（文件被 CLI 删除/重写）：记录 WARN，删除该文件的 `offsets` 条目，等待下轮重新发现（**非空 catch**）。
- `fs.watch` 抛错（Linux recursive 不支持）：回退为「仅定时扫描 + 非递归 watch」，记录 WARN。
- `Notification.show()` 抛错/静默失败：记录 WARN，不重试风暴（每会话冷却表仍然生效）。
- 退出时必须 `clearInterval` + `watcher.close()`；关闭异常只记录 WARN。

### 6.4 性能

- 单轮扫描开销 = O(新增字节)；文件列表缓存 + 定时刷新（不在每轮递归 `readdir` 全树）。
- 内存固定：`offsets`/`buffers` 大小与「会话文件数」成正比（数百个量级），不与会话内容大小成正比。
- 主进程内运行（⚠️ R3）：单次读取上限 + 逐文件串行，避免一次性 IO 抖动影响窗口响应。

## 7. 测试考量

| 层次 | 方式 | 覆盖需求 |
|---|---|---|
| 静态 | `npm run typecheck` | 全部 |
| 单元 | `parseTurnEvent()`：合法完成行 / 合法错误行 / 会话信息行 / 损坏 JSON / 空行 / 超长行 | FR-004-004、FR-004-010 |
| 单元 | 尾随推进：模拟「追加 → 截断 → 再追加」，断言偏移与事件序列（用临时目录 + 真实文件） | FR-004-002、FR-004-003 |
| 单元 | 决策真值表：前台/后台 × 冷却内/外 × 事件源可用/不可用 | FR-004-007、FR-004-008 |
| 单元 | 基线：预置历史文件 → 启动 → 断言零通知；再追加一行 → 断言一次通知 | FR-004-009 |
| 探针（**P0-5**） | 真实跑一次对话：窗口失焦时出通知、聚焦时不出、冷却生效、启动不补弹、记录延迟 | FR-004-001、FR-004-007…010、FR-004-016 |
| 负向 | 删除 `sessions/` 目录 / 把文件设为不可读 → 断言 WARN 且应用继续 | FR-004-017 |
| 手动 | Windows 通知归组（AppUserModelId 生效）、macOS 通知中心、Linux 桌面环境 | FR-004-013、FR-004-015 |

## 8. 文件清单

| 文件 | 用途 | 状态（2026-10-12 复核） |
|---|---|---|
| `src/main/session-watch.ts` | 会话 JSONL 增量尾随 + 行解析（无 Electron 依赖） | ✅ 已存在（188 行；实际导出 `startSessionWatch` / `stopSessionWatch` / `hasRecentActivity`） |
| `src/main/notifications.ts` | 通知策略（可见性/冷却/文案）+ `Notification` 落地 | ✅ 已存在（63 行；`setupNotifications` 返回取消函数） |
| `src/main/constants.ts` | `NOTIFICATION_COOLDOWN_MS`、`SESSION_WATCH_INTERVAL_MS`、`PRODUCT_NAME`、`APP_ID` | ✅ 已存在（56 行） |
| `src/main/logger.ts` | 统计与延迟落日志 | ✅ 已存在（86 行） |
| `src/main/windows.ts`（002） | `getMainWindow()` 可见性/聚焦判定 | ✅ 已存在（201 行） |
| `src/main/settings.ts`（008） | `resolveAgentDir()` | ✅ 已存在（110 行） |
| `src/main/index.ts`（007） | 启动/停止尾随与通知 | ✅ 已存在（327 行） |

> §5 的导出名为设计期建议，**以源文件为准**。

## 9. 与规格交叉引用

| 规格需求 | 实现落点 |
|---|---|
| FR-004-001…006（事件源 / 增量 / 容错 / 停止） | §3.3 尾随算法 + §6.2 + §6.3 |
| FR-004-007…012（可见性 / 冷却 / 基线 / 文案 / 隐私） | §4.3 校验规则 + §6.2「决策顺序」 |
| FR-004-013…015（平台标识 / 点击 / 降级） | §3.1 决策表 + §6.3；AppUserModelId 由 007 设置 |
| FR-004-016…018（度量 / 静默降级 / 日志纪律） | §5.3 事件表 + §6.4 + `logger.ts` |
| §5 验收场景 S1–S7 | §7 测试考量（S1/S2/S3/S4/S5 由 P0-5 探针覆盖；S6/S7 由负向与单元覆盖） |
