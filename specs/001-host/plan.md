# 001 — Host 宿主（host）技术实现方案

> **Module:** 001-host（Host 宿主）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应规格:** [`./spec.md`](./spec.md)
> **架构基线:** `docs/工程规划.md` §4.1、§4.2、§4.4、§4.5、§4.6、§4.7、§8.3、§11.1 R1/R3/R8、§11.4 S2/S3

## 1. 技术上下文

### 1.1 运行时环境

- **运行位置**：**Electron 主进程**（Node 24.21.0 / Chromium 150 / ABI 148；Electron **43.7.9** 精确钉版，🔶 与 `dsh-desktop` 同主版本）。
- **编译产物**：`src/main/host.ts` → `.vite/build/main.js`（`vite.main.config.ts`：cjs lib 构建，`external: ['electron', 'electron-squirrel-startup', 'node:*']`）。
- **进程模型**：服务器与 agent 都在主进程内，不引入子进程（✅ 决策 Q2）。因此本模块**不持有** `ChildProcess`，也**不需要**进程树清理（候选 B 除外，见 §3.4）。
- **调用时机**：由 007-app-entry 在 `app.whenReady()` 之后、建窗之前调用（§4.7 启动时序的 `[env] → [artifact] → [secret] → [server] → [ready]` 段）。

### 1.2 依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `electron`（`app`） | 内置 | `app.getPath('userData')`、`app.isPackaged`、`process.resourcesPath` |
| `node:net` | 内置 | `resolveFreePort()`（`createServer().listen(0, '127.0.0.1')` 探测后释放） |
| `node:crypto` | 内置 | `randomBytes(32).toString('base64url')` 生成 `PI_WEB_PASSWORD` |
| `node:path` / `node:fs` | 内置 | 候选入口路径拼接、轮换脚本存在性判定 |
| `<pi-dist>/bin/rotate-preview-secrets.js` | 上游源码 | 预览密钥轮换（`require` 后调用，✅ 存在） |
| `<pi-dist>/node_modules/next/dist/server/lib/start-server.js` | 上游内部入口 | `startServer({ dir, hostname, port })`（✅ 存在；⬜ 导出形状待 P0-1 定标） |
| `src/main/constants.ts` | 本项目（✅ 已存在，56 行） | `LOG_PREFIX`、`READY_TIMEOUT_MS=30_000`、`READY_INTERVAL_MS=400`、`READY_PROBE_PATH='/api/web-auth'`、`SHUTDOWN_DEADLINE_MS=5_000` |
| `src/main/logger.ts` | 本项目（✅ 已存在，86 行） | `logInfo/logWarn/logError/describeError/setStage/getStage` |
| `src/main/artifact.ts` | 009 模块（✅ 已存在，163 行） | `ensureArtifact(userData)` → `{ archivePath, piDistRoot, markerPath, nextEntry }` |
| `src/main/settings.ts` | 008 模块（✅ 已存在，110 行） | `loadSettings()`、`resolveAgentDir(settings)` |

> 本模块**不引入任何第三方 npm 依赖**：壳层依赖只有 `electron-squirrel-startup`，运行时依赖（`next` / `@earendil-works/*` / `node-pty`）全部来自 `<userData>/pi-dist`，不参与主进程构建。

## 2. 宪法合规检查

| 原则（`docs/工程规划.md` §3 / §7 / §11.4） | 状态 | 说明 |
|---|---|---|
| 零上游改动优先（§3 原则 1；§7 补丁集 0 条） | ✅ | 只 `require` 上游脚本与内部入口，不改 `../pi-web` 任何文件（FR-001-007） |
| 主进程进程内宿主（§3 原则 2） | ✅ | `startHost()` 在主进程内 `startServer`，无 spawn（FR-001-010） |
| 只写装配代码（§3 原则 3） | ✅ | 业务逻辑（路由/SSE/agent）全在上游；本模块只做装配与探测 |
| 同源数据面 / 数据面零 IPC（§3 原则 4） | ✅ | 本模块不经 IPC；只把 URL 交给 002（FR-001-015） |
| 失败可见 fail-visible（§3 原则 5） | ✅ | 阶段日志 + 诊断槽 + loading 页文本（FR-001-022…024） |
| 安全 S2「密码不入日志」（§11.4） | ✅ | 只打印长度/指纹前缀（FR-001-004、FR-001-025） |
| 安全 S3「仅绑 loopback」（§11.4） | ✅ | 断言 `hostname === '127.0.0.1'`（FR-001-003、FR-001-012） |
| 安全 S1/S4「生产不带 --inspect / DevTools 仅 dev」 | ✅ | 本模块不注册任何调试端口 |
| 代码质量：TypeScript strict、无 `as any`、严禁空 catch | ⬜ | 代码已落地（2026-10-12 复核），待人工评审（`tsconfig.json` 已 `strict: true`） |

> 合规结论：架构与安全项全部 ✅；代码质量项在 `src/main/host.ts` 落地后复核。

## 3. 研究结论

### 3.1 关键决策与理由

| 决策 | 理由 | 对应 FR |
|---|---|---|
| 进程内 `startServer`（候选 A，不与 sidecar 并存） | 无孤儿进程、无进程树清理、就绪判定确定（✅ 决策 Q2；🔶 HOS 已实证宿主不退出） | FR-001-010 |
| 随机高位端口 + 绑 `127.0.0.1` | 桌面无 loopback 隔离（与 HOS 相反），loopback 即最小暴露面；固定端口会与用户/CLI 起实例冲突 | FR-001-012 |
| `PI_WEB_PASSWORD` **默认开启**随机强密码 | 该服务具备文件读写 + 命令执行能力，同机其他本地进程/用户仍可访问 loopback（✅ §4.5） | FR-001-004 |
| 预览密钥轮换**先于**起服务，且复用上游脚本 | 密钥烘焙在 `.next/prerender-manifest.json`；自己重写算法会在上游升级时静默失配（✅ `pi-web/bin/rotate-preview-secrets.js`） | FR-001-007、FR-001-008 |
| 就绪判定用 HTTP 轮询，不解析 stdout | stdout `Ready` 是 CLI 启动器的判据（`bin/pi-web.js`），进程内无 stdout 可解析（✅ §4.2 步骤 6） | FR-001-015 |
| 环境装配抽成纯函数 | 可在不启动 Electron 的情况下断言映射表（本模块唯一的可单测部分） | FR-001-001…006 |
| 关闭幂等 + deadline 强退 | Next 16 的 `server.close()` 在 SSE 未断时不退出（⚠️ R8） | FR-001-018、FR-001-019 |

### 3.2 上游源码核实（✅ 已核实 / 🔶 沿用 / ⬜ 待验证）

| # | 事实 | 依据 |
|---|---|---|
| U1 | 导出形态：`next/dist/server/lib/start-server.js` 存在（HOS 侧已核对文件内 `async function startServer(serverOptions)`） | ✅ 本机核对路径存在；⬜ 导出名与签名在 Electron 内待 P0-1 定标 |
| U2 | `bin/pi-web.js` 的行为 = 解析参数 → `rotatePreviewSecrets(.next)` → `spawn(next start)` → 等 stdout `Ready` → 写 run-record → 开浏览器 | ✅ `pi-web/bin/pi-web.js` |
| U3 | 默认端口 30141 / 默认 hostname `127.0.0.1` 由 `bin/pi-web-options.js` 决定；`port 0` 被明确禁止（「OS 会选一个我们永远不知道的端口」） | ✅ `pi-web/bin/pi-web-options.js` |
| U4 | 未设 `PI_WEB_PASSWORD` = 完全无认证；设置后页面导航只认 cookie `pi_web_session`，Basic **只在 `/api/*`** 校验（用户名固定 `pi`） | ✅ `pi-web/proxy.ts`、`lib/web-auth.ts`（凭据注入在 002 实现） |
| U5 | Host 门禁对 **IP 字面量直接放行**，同源请求 Origin 天然通过 → 无需改写上游安全策略 | ✅ `pi-web/lib/request-security.ts` |
| U6 | 进程内宿主不退出、SPA/API/SSE 全通 | 🔶 沿用 HOS 真机结论（本工程 P0-1 复现） |
| U7 | `instrumentation-node.ts` 在 `SIGINT`/`SIGTERM` 时先关 SSE 再关服务器（否则 `server.close()` 永不退出） | 🔶 沿用 HOS 结论；⚠️ Electron 主进程内是否收到同等信号路径 ⬜ |

### 3.3 环境装配的时序纪律

pi 在**模块加载时**就可能读取 agent 目录（默认值与目录常量在模块顶层计算）。因此：

- 顶层**禁止**静态 `import` 任何 pi / pi-web 侧模块；需要时用 `await import()`，且必须在环境装配完成之后。
- Electron / Node 内置模块不受此约束。
- 009 的解压也必须在任何 pi 模块加载之前完成（它决定 `PI_CODING_AGENT_DIR` 下的文件是否已就位）。

### 3.4 导出探测与回退（⬜ P0-1）

探测顺序（命中即停，清单写入日志）：

1. `<piDistRoot>/node_modules/next/dist/server/lib/start-server.js` 的 `startServer`（首选，✅ 路径存在）。
2. 同目录下的其它导出名（`default`、名字含 `start` 的别名变体）——按 `Object.keys(mod)` 动态匹配「函数且名字含 `start`」。
3. `next/dist/server/next.js` 的 `createServer` / `next({ dev: false, dir })` 再 `prepare()`（次选，语义等价但生命周期需自行控制）。
4. 全部失败 → 抛含「已探测路径 + 导出键名」的错误（fail-visible）。

**候选 B（子进程，登记不默认启用）**

```js
spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(port)], {
  cwd: piDistRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
```

- 触发条件（任一）：① P0-1 失败（导出不可用或宿主退出）；② 上游升级后形态变化且短期无法适配；③ 产品验收要求「服务端崩溃隔离/热重启」。
- 代价（必须登记）：Windows 需 `taskkill /T /F` 清进程树、孤儿 `next-server` 占端口、就绪判定退化为「轮询 + stdout」双路。
- `ELECTRON_RUN_AS_NODE=1` 不可省：`process.execPath` 指向 Electron 本体，否则会再起一个 Electron 实例（🔶 HOS 结论）。

## 4. 数据模型

### 4.1 实体

| 实体 | 字段 | 说明 |
|---|---|---|
| `HostHandle` | `port: number`、`url: string`、`password: string`、`close(): Promise<void>`、`isReady(): boolean` | 对 002/005/007 暴露的唯一契约（FR-001-018） |
| `StartHostOptions` | `userData: string`、`agentDir: string`、`piDistRoot: string`、`nextEntry: string` | 全部由调用方（007）装配完成后传入，本模块不自行解析设置 |
| `EnvPlan` | `Record<string, string>`（纯函数输出） | 环境装配的可断言映射表（FR-001-001…006） |
| `ProbeResult` | `candidates: string[]`、`hit: string`、`exportName: string` | 导出探测记录（FR-001-011） |

### 4.2 状态机

```
idle
  → env              （环境装配完成；PI_WEB_PASSWORD 已生成）
  → rotated          （预览密钥轮换成功）
  → listening        （startServer 返回，端口已绑定；断言 hostname=127.0.0.1）
  → ready            （HTTP 轮询命中；url 可交付）
  → closing          （close() 已调用，等待 HTTP 服务器结束）
  → closed           （deadline 内结束）或被 005 强退（deadline 超时）

任一步失败 → failed(stage, message)：写日志 + globalThis.__hostError + loading 页
```

### 4.3 校验规则

- `PI_WEB_PASSWORD`：长度 ≥ 32；生成后立即写入 `process.env`，进程内不再回显。
- 端口：`1024 ≤ port ≤ 65535`；由 `listen(0)` 由 OS 分配后读回，不做「猜测 + 重试固定值」。
- hostname：硬编码 `127.0.0.1`；不允许从设置/环境变量改写（防误配成 `0.0.0.0`）。
- `nextEntry`：必须存在且 `basename` 属于探测清单（由 009 的 `assertPayloadComplete` 先行保证）。

## 5. 接口契约

### 5.1 提供接口（本模块导出）

| 导出 | 签名 | 说明 |
|---|---|---|
| `buildHostEnv(options)` | `(o: StartHostOptions) => EnvPlan` | 纯函数：环境映射表（便于单测） |
| `resolveFreePort()` | `() => Promise<number>` | 取空闲高位端口 |
| `resolveNextEntry(piDistRoot)` | `() => { path: string; exportName: string }` | 导出探测（内部使用；也可被 009 复用） |
| `startHost(options)` | `(o: StartHostOptions) => Promise<HostHandle>` | 装配 + 轮换 + 启动 + 就绪；失败抛出 |
| `HostHandle.close` | `() => Promise<void>` | 幂等关闭（FR-001-018、FR-001-019） |

### 5.2 消费接口（本模块依赖）

| 来源 | 符号 |
|---|---|
| `src/main/artifact.ts`（009） | `ensureArtifact(userData): Promise<ArtifactState>` |
| `src/main/settings.ts`（008） | `loadSettings()`、`resolveAgentDir(settings)` |
| `src/main/logger.ts` | `logInfo/logWarn/logError/describeError/setStage` |
| 上游 `<pi-dist>` | `bin/rotate-preview-secrets.js`、`node_modules/next/dist/server/lib/start-server.js` |

### 5.3 事件协议

- **无自定义 IPC 通道**（数据面永不过 IPC）。
- 阶段推进经由 002 的 loading 页契约：002 暴露 `pushStage(text)` / `pushFailure(text)`（实现为对 `index.html` 页内全局函数的 `executeJavaScript` 调用），001 只调用，不关心实现。
- 诊断槽：`globalThis.__hostError`（字符串；探针经 DevTools/CDP 读取）。

## 6. 实现策略

### 6.1 架构模式

**单文件时序编排 + 一个纯函数**：`src/main/host.ts` 导出 `startHost()`，内部按 `env → rotate → listen → ready` 四阶段线性推进；环境装配抽成 `buildHostEnv()`（无副作用）以便单测。不拆更多文件：本模块是一次性启动编排，拆分只会引入跨文件隐式耦合（🔶 沿用 HOS 的单文件编排口径）。

### 6.2 关键算法

- **端口探测**：`net.createServer().listen(0, '127.0.0.1')` → 读 `address().port` → `close()` → 返回该端口。存在「探测与真正绑定之间被抢占」的窗口，因此 `startServer` 报 `EADDRINUSE` 时 MUST 重试（上限 3 次）。
- **导出探测**：`require()` 候选路径（`try/catch` 每项独立）→ 断言 `typeof mod[name] === 'function'`；失败项只 `logWarn`，不抛；全部失败才抛。
- **就绪轮询**：`while (Date.now() < deadline)` → `fetch(probeUrl, { redirect: 'manual' })` → `status < 500` 即就绪；间隔 `READY_INTERVAL_MS`（400 ms）；每 N 次打一行进度日志。
- **幂等关闭**：`let closing: Promise<void> | null = null; closing ??= doClose()`。

### 6.3 错误处理

- 统一出口 `fail(stage, error)`：`logError` + `globalThis.__hostError = '[pi-desktop] <stage>: <message>'` + 通知 002 更新 loading 页。
- **严禁空 catch**：允许「记录后继续」的只有两类 —— ① 导出探测的单项失败；② 关闭过程中的 `EPIPE`/已关闭错误（记录 WARN）。
- 轮换脚本缺失 = **硬失败**（不许跳过）：跳过会使预览密钥保持构建期值（FR-001-008）。

### 6.4 性能

- 环境装配与端口探测为毫秒级；预览密钥轮换为单个 JSON 读写（毫秒级）。
- 就绪轮询总时长上限 30 s；轮询本身不占 CPU（间隔 400 ms）。
- 本模块不读取 pi-dist 内容、不缓存任何大对象；内存压力来自上游服务器（⚠️ R3，必要时调低 `PI_WEB_IDLE_TIMEOUT_MS`）。

## 7. 测试考量

| 层次 | 方式 | 覆盖需求 |
|---|---|---|
| 静态 | `npm run typecheck`（strict TS，🔶 沿用 dsh 的脚手架质量门口径） | 全部 |
| 单元 | `buildHostEnv()` 映射表断言（Node 内置 test runner）：`PI_CODING_AGENT_DIR` 取值、密码长度、hostname 固定、`NO_PROXY` 去重幂等 | FR-001-001…006 |
| 单元 | `resolveFreePort()` 返回值范围与两次调用不冲突 | FR-001-012 |
| 集成（**门禁**） | `scripts/smoke-desktop.mjs`（用与 Electron 同版 Node 24.21.0 起服务，四项断言：SPA / 带凭据 API / SSE / SDK AgentSession） | FR-001-009、FR-001-015、FR-001-017 |
| 探针 | **P0-1**：Electron 主进程内 `startServer`，观察宿主存活 + 预览密钥已轮换 + SPA/API/SSE 全通 | FR-001-010、FR-001-011、FR-001-013 |
| 负向 | 把 `nextEntry` 指向不存在路径 → 断言错误信息含候选清单；`PI_WEB_PASSWORD` 生成后 `grep` 全量日志不得命中明文 | FR-001-008、FR-001-011、FR-001-025 |
| 边界 | 端口被抢占（先占住一个端口再强制使用）→ 断言重试逻辑；`close()` 连调两次 → 断言不抛 | FR-001-018、FR-001-020 |

## 8. 文件清单

| 文件 | 用途 | 状态（2026-10-12 复核） |
|---|---|---|
| `src/main/host.ts` | 环境装配 + 导出探测 + 进程内启动 + 就绪轮询 + 幂等关闭 | ✅ 已存在（518 行；实际导出 `assembleEnv` / `resolvePassword` / `rotatePreviewSecrets` / `waitForReady` / `installAuthInjection` / `startHost` / `closeWithDeadline`） |
| `src/main/constants.ts` | 端口/就绪/关闭相关常量（`READY_*`、`SHUTDOWN_DEADLINE_MS`、`PI_WEB_SESSION_*`） | ✅ 已存在（56 行） |
| `src/main/logger.ts` | `[pi-desktop]` 前缀日志、阶段文本、错误描述 | ✅ 已存在（86 行） |
| `src/main/artifact.ts`（009） | `ensureArtifact()` 提供 `piDistRoot` / `nextEntry` | ✅ 已存在（163 行） |
| `src/main/settings.ts`（008） | `loadSettings()` / `resolveAgentDir()` | ✅ 已存在（110 行） |
| `src/main/index.ts`（007） | 调用 `startHost()` 并按序编排 | ✅ 已存在（327 行） |
| `src/main/windows.ts`（002） | 消费宿主句柄，负责凭据注入与加载 | ✅ 已存在（201 行） |

> §5「接口契约」的导出名是**设计期建议**，以源文件为准（实现侧采用 `assembleEnv` / `startHost` 等命名，语义一致）。本模块**不新增**其它文件；`src/main/tar-extract.ts`（✅ 已存在，218 行）属 009。

## 9. 与规格交叉引用

| 规格需求 | 实现落点 |
|---|---|
| FR-001-001…006（环境装配） | §3.3 时序纪律 + §6.1 的 `buildHostEnv()` 纯函数 |
| FR-001-007…009（预览密钥 / 运行根） | §3.1 决策表 + §6.4；`<pi-dist>/bin/rotate-preview-secrets.js` |
| FR-001-010…014（进程内启动 / 探测 / 端口 / 回退） | §3.4 探测清单 + §6.2 |
| FR-001-015…017（HTTP 轮询就绪） | §6.2「就绪轮询」+ `READY_PROBE_PATH` |
| FR-001-018…021（幂等关闭 / deadline） | §6.2「幂等关闭」+ `SHUTDOWN_DEADLINE_MS`，强退由 005 执行 |
| FR-001-022…025（日志与诊断） | §6.3 `fail()` + `logger.ts` |
| §5 验收场景 A1–A7 | §7 测试考量逐条对应（A1↔集成、A5↔负向、A6↔边界） |
