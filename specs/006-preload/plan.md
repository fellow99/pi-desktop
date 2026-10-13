# 006 — 壳层桥（preload）技术实现方案

> **Module:** 006-preload（壳层桥）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应规格:** [`./spec.md`](./spec.md)
> **架构基线:** `docs/工程规划.md` §5.6、§4.8、§5.4、§5.2（无窗口控制 IPC）

## 1. 技术上下文

### 1.1 运行时环境

- **运行位置**：渲染进程的 **preload 隔离世界**（`sandbox: true` + `contextIsolation: true` 基线下的 preload 脚本）。
- **编译产物**：`src/preload/index.ts` → `.vite/build/preload.js`（`vite.preload.config.ts` 已声明该目标；`BrowserWindow` 的 `webPreferences.preload` 指向该文件）。
- **生效范围**：预加载脚本对**该窗口加载的所有文档**生效 —— 因此「只在 `file://` 下暴露」是必需的过滤（否则 Pi Web UI 也会拿到 `piDesktop`）。
- **调用时机**：窗口创建时由 002 装载；`onStage` 的阶段事件由 007 在启动流程中广播。

### 1.2 依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `electron`（`contextBridge`, `ipcRenderer`） | 内置 | 暴露 API 与接收壳层事件 |
| `process.versions` / `process.platform` | 内置（preload 受限访问） | `getInfo()` 的版本信息（⬜ sandbox 下的可见性见 §3.3） |
| `location.protocol` | 渲染进程全局 | 暴露判定（`file:`）（FR-006-004） |
| 主进程侧 handler（007 注册） | 本工程 | `pi-desktop:*` 通道的实现来源 |
| `src/main/logger.ts` / `constants.ts` | 本项目（✅ 已存在） | 主进程侧动作落日志；常量（产品名、日志路径） |
| `src/renderer/renderer.ts` | 本项目（✅ 已存在，86 行） | 唯一消费方（loading/兜底页） |

> 无第三方依赖。v1 的暴露面刻意保持为**六个方法**；新增方法必须走规格追加（spec §7 的触发条件）。

## 2. 宪法合规检查

| 原则（`docs/工程规划.md` §3 / §5.6 / §4.8） | 状态 | 说明 |
|---|---|---|
| 数据面零 IPC（§3 原则 4、§4.8） | ✅ | 桥只承载壳层动作；无数据面通道（FR-006-002、FR-006-003） |
| preload 默认最小（§5.6） | ✅ | 默认 `export {}`；只有壳层页面获得 API（FR-006-001、FR-006-004） |
| IPC 面收敛（§5.6） | ✅ | 六个动作、无参数透传、无通用 `invoke`（FR-006-007） |
| 安全：无 Node 能力进渲染层（§4.5） | ✅ | `contextBridge` 只暴露函数与纯数据（FR-006-014、FR-006-015） |
| 安全：不暴露凭据（§11.4 S2） | ✅ | `getInfo()` 不含密码/端口凭据（FR-006-008） |
| 退出路径唯一（§5.3） | ✅ | `quit()` 走 `app.quit()`（FR-006-011） |
| 明确不做项不偷做（§5.2、§5.8） | ✅ | 无窗口控制 IPC、不接管右键菜单（§1.3 不包含） |
| 代码质量：strict TS、无 `as any`、严禁空 catch | ⬜ | 代码已落地（2026-10-12 复核），待人工评审 |

> 合规结论：数据面与安全项全部 ✅；⬜ 项在实现落地后复核。

## 3. 研究结论

### 3.1 关键决策与理由

| 决策 | 理由 | 对应 FR |
|---|---|---|
| 默认**不暴露**任何 API | 上游 UI 不需要壳层接口；暴露即扩大攻击面并诱发上游依赖（§5.6） | FR-006-001、FR-006-005 |
| 仅为 `file://` 文档暴露 | loading/兜底页没有同源后端，需要一条受控通道；`http://` 文档必须保持「纯上游 UI」 | FR-006-004、FR-006-005 |
| 六个动作的固定清单 | 恰好覆盖 loading 页的真实需求（打开日志、退出、阶段文本、目录、更新、信息）；多一个都是负债 | FR-006-007 |
| 无通用 `invoke` 透传 | 通用透传等于「IPC 面 = 无限」；白名单式暴露才可审计 | FR-006-003 |
| `onStage` 只承载启动阶段 | 业务事件（会话/工具调用）在 SSE 里，主进程不该复制一份数据面 | FR-006-012 |
| `quit()` 不直接 `app.exit()` | 必须走优雅关闭链（003/005），否则会留下挂住的进程（⚠️ R8） | FR-006-011 |

### 3.2 与参考实现的对照（🔶 沿用 dsh）

| 维度 | `dsh-desktop` | 本工程 |
|---|---|---|
| preload 内容 | 改造前：`window.dsh`（窗口控制 min/max/close/isMaximized）；改造后：**空实现** | **空实现 + 条件暴露的六个壳层动作** |
| 数据面 | 不过 IPC | 不过 IPC（同） |
| 窗口控制 IPC | 已移除（改常规标题栏） | **不引入**（同为常规标题栏） |
| 壳层页面动作 | 无（无 `file://` 页面场景） | **有**（loading/兜底页需要，见 002 FR-002-011） |

> 差异原因：dsh 的兜底页与渲染层共用开发服务器/静态资源路径，未出现「页面无后端可用」的问题；本工程的 loading 页在 `file://` 下必须能执行「打开日志 / 重试 / 退出」，因此引入六个动作的最小桥（**这是与 dsh 的有意偏离，须在 `docs/桌面能力清单.md` 登记**）。

### 3.3 暴露判定与 sandbox 下的可见性（⬜ 待验证）

```
preload 顶层：
  if (location.protocol !== 'file:') return;            // FR-006-004 / FR-006-005
  contextBridge.exposeInMainWorld('piDesktop', {
    getInfo, openLog, openSessionDir, checkForUpdates, quit, onStage,
  });
```

- `location.protocol` 判定：preload 运行在渲染进程内，可访问 `location`；`file://` 与 `http://` 两种文档下取值不同（⬜ P0-3 实测确认，见 spec §7）。
- `process.versions` 在 `sandbox: true` 下由 Electron 提供**受限子集**（⬜ 需实测 `process.versions.electron/node/chrome` 是否可读）；若不可读，则 `getInfo()` 改为主进程经 handler 返回（契约不变，只换数据来源）。
- 页面 CSP（`index.html`: `default-src 'self'; script-src 'self'`）**不约束** preload 脚本本身（preload 在隔离世界执行）；但会约束 `renderer.ts` 是否可执行 —— 该文件由 `index.html` 自身声明（`<script type="module" src="/src/renderer/renderer.ts">`），开发态由 Vite 注入、打包态由 renderer 构建输出（⬜ 打包态路径需在 P0-6 实机确认）。

## 4. 数据模型

### 4.1 实体

| 实体 | 字段 | 说明 |
|---|---|---|
| `PiDesktopApi` | `getInfo()`、`openLog()`、`openSessionDir()`、`checkForUpdates()`、`quit()`、`onStage(handler)` | 暴露的六个方法（FR-006-007） |
| `ShellInfo` | `{ productName, version, electron, node, chrome, isPackaged, agentDirMode }` | `getInfo()` 返回；不含凭据（FR-006-008） |
| `StageEvent` | `{ stage: string; detail?: string; elapsedMs?: number; failed?: boolean }` | `onStage` 载荷（FR-006-012） |

### 4.2 状态机（暴露生命周期）

```
preload 执行
  ├─ 文档为 file://   → 暴露 piDesktop（S1 可用）
  ├─ 文档为 http(s):// → 不暴露（window.piDesktop === undefined）
  └─ 其它协议          → 不暴露（最小惊讶：只有壳层自有页面例外）

onStage(handler) → 订阅（返回 cancel）→ 页面卸载/取消 → 解绑
```

### 4.3 校验规则

- 暴露判定只看 `location.protocol === 'file:'`；**不看** hostname/端口（避免把 http 的 loopback 误判为壳层页面）。
- `onStage` 的 handler 必须为函数；非函数 → 不订阅、返回空 cancel（不抛错，避免页面脚本异常导致启动页不可用）。
- `getInfo()` 返回对象 MUST 冻结或一次性克隆（防止页面侧改写影响主进程状态）。
- 通道命名：主进程侧统一 `pi-desktop:<action>`（如 `pi-desktop:get-info`），便于审计与 grep（FR-006-013）。

## 5. 接口契约

### 5.1 提供接口（渲染世界）

| 方法 | 返回 | 说明 |
|---|---|---|
| `getInfo()` | `Promise<ShellInfo>` | 壳层信息（无凭据） |
| `openLog()` | `Promise<void>` | 打开 `<userData>/logs/` |
| `openSessionDir()` | `Promise<void>` | 打开 `agentDir` |
| `checkForUpdates()` | `Promise<{ status: 'none' \| 'available' \| 'error'; version?: string; url?: string }>` | 委托 011 |
| `quit()` | `Promise<void>` | `app.quit()` → 关闭链 |
| `onStage(handler)` | `() => void`（取消订阅） | 启动阶段事件 |

### 5.2 消费接口

| 来源 | 符号 |
|---|---|
| `electron` | `contextBridge`, `ipcRenderer`（`invoke` / `on`） |
| 渲染进程全局 | `location`（暴露判定） |
| 主进程 handler（007 注册） | `pi-desktop:get-info` / `open-log` / `open-session-dir` / `check-for-updates` / `quit`；阶段广播 `pi-desktop:stage` |

### 5.3 事件协议（IPC）

| 通道 | 方向 | 载荷 | 返回 |
|---|---|---|---|
| `pi-desktop:get-info` | 页 → 主（invoke） | — | `ShellInfo` |
| `pi-desktop:open-log` | 页 → 主（invoke） | — | `void` |
| `pi-desktop:open-session-dir` | 页 → 主（invoke） | — | `void` |
| `pi-desktop:check-for-updates` | 页 → 主（invoke） | — | 更新检查结果 |
| `pi-desktop:quit` | 页 → 主（invoke） | — | `void`（触发关闭链） |
| `pi-desktop:stage` | 主 → 页（send） | `StageEvent` | — |

> **纪律**：该表是壳层 IPC 的**全部**内容。任何新增通道必须回到 spec 追加 FR（spec §7）。**数据面永不出现在此表**。

## 6. 实现策略

### 6.1 架构模式

**条件暴露 + 白名单方法**：preload 内部只有一个 `installBridge()` 函数，先判协议，再把六个**具名**方法注册进 `contextBridge`。不做「注册表 + 通用转发」，因为通用转发会把 IPC 面变成不可审计的无限集。

### 6.2 关键算法

- **暴露判定**：`if (typeof location !== 'undefined' && location.protocol === 'file:')` —— `typeof` 守卫防止非窗口环境（未来若被用于 worker）抛错。
- **取消订阅**：`onStage(handler)` 内部保存 `listener` 引用，返回 `() => ipcRenderer.removeListener('pi-desktop:stage', listener)`。
- **错误传递**：`ipcRenderer.invoke` 的 rejection 会让页面侧 Promise 拒绝 —— 页面侧（`renderer.ts`）必须 `try/catch` 并显示可读文案；桥本身不吞错（保留 rejection 语义）。
- **返回对象克隆**：主进程 handler 返回普通对象（Electron 结构化克隆），桥侧不做深拷贝（避免额外开销）。

### 6.3 错误处理

- 页面在未暴露文档下调用 `window.piDesktop` → 页面侧 `undefined` 报错（预期行为）；`renderer.ts` MUST 用特性检测（`if (window.piDesktop)`）。
- 主进程 handler 未注册（启动早期页面先于 handler 就绪）→ invoke 拒绝；bridge SHOULD 捕获并返回可读错误，避免 loading 页「点了没反应」（⬜ 实现时按实测行为定）。
- **严禁空 catch**：桥内的 catch 必须回传可读信息（页面会展示给用户）。

### 6.4 性能

- 六个方法均为低频人为动作；`onStage` 只有启动期数十条事件。
- 桥本身零常驻开销（一次判定 + 一次 `exposeInMainWorld`）。

## 7. 测试考量

| 层次 | 方式 | 覆盖需求 |
|---|---|---|
| 静态 | `npm run typecheck`（类型声明同时被 `src/renderer/renderer.ts` 消费） | FR-006-016 |
| 单元 | 暴露判定：mock `location.protocol` 为 `file:` / `http:` / `https:` / 缺失 四种输入 | FR-006-004、FR-006-005、FR-006-006 |
| 单元 | 白名单：断言暴露对象的键集合恰为六个（防止顺手加接口） | FR-006-007、FR-006-003 |
| 单元 | `onStage` 非函数输入、取消订阅后不再收到事件 | FR-006-012 |
| 探针（P0-3） | ① `file://` 页面 `typeof window.piDesktop === 'object'`；② `http://127.0.0.1:<port>/` 页面为 `undefined`；③ `sandbox:true` 下 `process.versions` 可见性；④ 页面 CSP 对页面脚本无阻断 | FR-006-004、FR-006-005、FR-006-008 |
| 集成 | `quit()` 走完关闭链（配合 005 的关闭链测试）；`openLog()`/`openSessionDir()` 打开正确路径 | FR-006-009、FR-006-011 |
| 负向 | 在 Pi Web UI 里注入 `window.piDesktop.getInfo()` → 断言抛 TypeError 且不产生 IPC 调用 | FR-006-005 |

## 8. 文件清单

| 文件 | 用途 | 状态（2026-10-12 复核） |
|---|---|---|
| `src/preload/index.ts` | 条件暴露的壳层动作（`isLocalDocument()` 判定 + `exposeInMainWorld`） | ✅ 已存在（34 行）。⚠️ **与设计清单的差异**：实际暴露 `getInfo` / `openLog` / `openSessionDir` / `checkForUpdates` / **`retry`** / `quit`（通道 `pi-desktop:info`、`-open-log`、`-open-session-dir`、`-check-updates`、`-retry`、`-quit`），**未提供 `onStage`** —— 阶段文本改由 002 的 `setStageOnWindow()`（`executeJavaScript`）推送。按「FR 只追加不修订」纪律，若要恢复 `onStage` 需追加新 FR，或在对齐后追加一条记录该决定的 FR。 |
| `src/renderer/renderer.ts` | loading 页脚本（阶段渲染 + 动作按钮接线） | ✅ 已存在（86 行，属 002） |
| `index.html` | 壳层自有页面（`file://` 场景） | ✅ 已存在 |
| `vite.preload.config.ts` | preload 构建目标（产物 `.vite/build/preload.js`） | ✅ 已存在 |
| `src/main/windows.ts`（002） | `webPreferences.preload` 指向产物 + 阶段文本推送 | ✅ 已存在（201 行） |
| `src/main/index.ts`（007） | 注册壳层动作 handler + 启动编排 | ✅ 已存在（327 行） |
| `src/main/update-check.ts`（011） | `checkForUpdates()` 实现 | ✅ 已存在（97 行） |

> §5.3 的通道名为设计期建议；**以源文件为准**（实现侧的通道名见上表）。

## 9. 与规格交叉引用

| 规格需求 | 实现落点 |
|---|---|
| FR-006-001…003（默认最小 / 无数据面 / 无透传） | §3.1 决策表 + §6.1 白名单模式 |
| FR-006-004…006（仅 file:// 暴露 / 上游 UI 不可见） | §3.3 判定代码 + §6.2 |
| FR-006-007…013（六个动作与各自语义） | §5.1 接口表 + §5.3 通道表 + §6.2 |
| FR-006-014…017（contextBridge / 克隆 / 类型 / 注释纪律） | §6.2「返回对象克隆」+ §6.3 + §8 |
| §5 验收场景 S1–S6 | §7 测试考量（S1/S2/S4 由 P0-3 探针覆盖；S3 由白名单单元测试覆盖；S5/S6 由集成与单元覆盖） |
