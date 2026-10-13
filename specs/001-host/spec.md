# 001 — Host 宿主（host）功能规格

> **Module:** 001-host（Host 宿主）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应方案:** [`./plan.md`](./plan.md)
> **实现落点:** `src/main/host.ts`（配套 `src/main/constants.ts`、`src/main/logger.ts`）
> **规划依据:** `docs/工程规划.md` §4.1、§4.2、§4.4、§4.5、§4.7、§11.1 R1/R3/R8、§11.4 S2/S3

## 1. 模块概述

### 1.1 目的

Host 模块的职责是：**在 Electron 主进程（Node 24.21.0）内完成环境装配，并以进程内方式拉起 pi-web 的 Next 服务器，向渲染层交付一个可访问的 loopback URL 与可幂等关闭的宿主句柄**。

它是本工程的核心装配模块：应用能否可用，取决于 `startServer({ dir, hostname: '127.0.0.1', port })` 这一步能否在主进程内成立（`docs/工程规划.md` §4.2 已决策 Q2）。

### 1.2 解决的问题

- **上游没有 HTTP 服务模式**：`pi` 自身只有 TUI / `--print` / `--mode json` / `--mode rpc` 与进程内 SDK（✅ `pi` 无 `--port`/`--host` 参数；`packages/server` 需 POSIX `process.getuid`，Windows 不可用）。桌面壳必须自己把 `pi-web` 的 Next 服务器拉起来。
- **不能用 `bin/pi-web.js`**：它做四件本工程不能照抄的事 —— spawn 子进程、解析 stdout 的 `Ready`、写 run-record、开浏览器（✅ `pi-web/bin/pi-web.js`）。子进程会带来孤儿进程与进程树清理问题。
- **上游启动前的前置条件容易漏**：预览密钥轮换必须在服务器注册路由**之前**完成（否则烘焙在 `.next/prerender-manifest.json` 里的密钥不变，`x-prerender-revalidate` 可绕过 `proxy.ts`）；`PI_WEB_HOSTNAME` / `PI_WEB_PASSWORD` 也必须在起服务前注入（✅ `pi-web/bin/rotate-preview-secrets.js`、`bin/pi-web-options.js`）。
- **绑定暴露面**：桌面有原生 loopback，因此必须绑 `127.0.0.1` 并把鉴权默认打开（该服务具备文件读写与命令执行能力）。
- **关不干净**：Next 16 的 `server.close()` 在 SSE 长连接未关闭时不会退出（⚠️ `docs/工程规划.md` §4.2 的关闭语义 + R8），必须由壳层自带 deadline 强退兜底。

### 1.3 范围

**包含**

- 启动前的环境装配：`PI_CODING_AGENT_DIR`、`PI_WEB_HOSTNAME`、`PI_WEB_PASSWORD`、`NO_PROXY`/`no_proxy`（后两项与 005 的代理绕过共同生效，本模块只负责会话内变量）。
- 空闲高位的 loopback 端口分配。
- 预览密钥轮换（复用上游脚本，不重写算法）。
- 进程内启动 Next 服务器的**导出探测**（多候选路径/导出形状）与失败时的可读报错。
- 就绪判定（HTTP 轮询，不解析 stdout）与超时上限。
- 宿主句柄（`{ port, url, password, close }`）与幂等关闭。
- 启动阶段的 fail-visible 诊断（阶段名 + 原因 + 全局诊断槽）。

**不包含**

- 子进程回退（候选 B）的实现：仅在 `plan.md` §3.5 登记触发条件与代价，默认**不启用**。
- 凭据**注入**渲染层（cookie/Basic 出栈注入属 002-window）。
- 产物解压与 marker 幂等 → 009-artifact-bootstrap。
- 数据目录策略与预置模板 → 008-runtime-config。
- 单实例锁、`NO_PROXY` 注入、系统 CA、崩溃兜底、强退编排 → 005-lifecycle；入口顺序 → 007-app-entry。
- 服务器自身的业务行为（路由、SSE、agent 会话、插件）→ 上游 pi-web，本工程不实现、不 fork。

## 2. 用户故事

- 作为用户，我双击应用后应当看到 Pi Web UI 而不是白屏，且不需要手工登录（凭据由壳层注入）。
- 作为用户，我不希望应用在后台留下我看不见的残留进程：关掉应用后端口应被释放，重启能再次成功绑定。
- 作为与 CLI 共用同一套 pi 环境的用户，我希望桌面应用里的会话/凭据/扩展与 `pi` CLI 是同一份（默认共享 `~/.pi/agent`）。
- 作为排障者，我希望启动失败时能看到**具体是哪个阶段**失败、原因是什麼，并且能在日志里找到证据，而不是「窗口卡住但不说」。
- 作为维护者，我希望上游 Next 内部入口形态变化时，失败是**立即且可读**的（而不是静默降级或随机崩溃），以便按 `plan.md` §3.5 切回退路径。

## 3. 功能需求

动作词：**MUST** 必须满足；**MUST NOT** 禁止；**SHOULD** 建议；**MAY** 可选。

### 3.1 环境装配

- FR-001-001：系统 MUST 在任何 pi / pi-web 模块被导入**之前**完成环境变量装配（`PI_CODING_AGENT_DIR`、`PI_WEB_HOSTNAME`、`PI_WEB_PASSWORD`、`NO_PROXY`/`no_proxy`）。
- FR-001-002：系统 MUST 把 `PI_CODING_AGENT_DIR` 取值为 008-runtime-config 解析出的数据目录。**MUST NOT** 改写 `HOME`/`USERPROFILE`/`TMPDIR`（桌面无沙箱，见 §4.10 的 HOS 差异）。
- FR-001-003：系统 MUST 在服务器开始处理请求之前设置 `PI_WEB_HOSTNAME=127.0.0.1`。
- FR-001-004：系统 MUST 为每次会话生成高熵随机 `PI_WEB_PASSWORD`（≥32 字符，`randomBytes` 派生）。**MUST NOT** 把明文写入日志、窗口标题、loading 页文本或任何文件。
- FR-001-005：系统 MAY 允许经 `PI_DESKTOP_PASSWORD` 覆盖随机密码（仅用于本地调试），且该覆盖 MUST 同样遵守 FR-001-004 的不外泄约束。
- FR-001-006：系统 MUST 在启动服务器前把 `NO_PROXY` 与 `no_proxy` 都补齐 loopback 项（大小写双键），且 MUST 幂等去重。

### 3.2 产物与预览密钥

- FR-001-007：系统 MUST 在启动服务器**之前**调用 `<pi-dist>/bin/rotate-preview-secrets.js`（`require` 上游实现后调用）。**MUST NOT** 自行重新实现轮换算法。
- FR-001-008：轮换脚本缺失或执行失败时，系统 MUST 以 fail-visible 方式失败（不静默继续）。依据：预览密钥未轮换会留下绕过 `proxy.ts` 的 `x-prerender-revalidate` 口子（✅ `pi-web/bin/rotate-preview-secrets.js` 的告警语义）。
- FR-001-009：系统 MUST 以 pi-dist 目录作为运行根（`startServer({ dir: <pi-dist> })`），使 `.next` 被解析到 `<pi-dist>/.next`。

### 3.3 服务端启动

- FR-001-010：服务器 MUST 在 **Electron 主进程内**启动，调用 Next 的 `startServer` 导出。**MUST NOT** 默认 spawn Node 子进程。
- FR-001-011：启动实现 MUST 做**导出探测**：按候选路径列表逐个尝试加载并断言 `startServer` 为函数，探测顺序与候选清单 MUST 记录在日志中；全部失败时 MUST 抛出含「已探测路径」的可读错误。
- FR-001-012：系统 MUST 探测监听地址为 `127.0.0.1`、端口为运行时选定的空闲高位端口。**MUST NOT** 绑定 `0.0.0.0`、**MUST NOT** 使用固定端口。
- FR-001-013：系统 MUST 在 `startServer` 返回后断言宿主事件循环仍然存活（进程未退出）。若探测到上游请求退出，MUST 记录并 fail-visible。
- FR-001-014：系统 MUST 仅在上游入口不可用（或宿主退出）时启用 `plan.md` §3.5 的子进程回退；启用回退时 MUST 同时补齐进程树清理与双路就绪判定。

### 3.4 就绪判定

- FR-001-015：就绪判定 MUST 使用 **HTTP 轮询**（默认探测 `GET /api/web-auth`，免认证）。**MUST NOT** 依赖任何子进程 stdout 文本。
- FR-001-016：就绪轮询 SHOULD 把 HTTP 状态 `< 500` 视为「服务器已在工作」；轮询间隔 MUST 有下限（避免死循环打满 CPU）。
- FR-001-017：就绪轮询 MUST 有超时上限（默认 30 s，常量 `READY_TIMEOUT_MS`），超时后 MUST 以 fail-visible 方式失败并提示「打开日志 / 重试 / 退出」。

### 3.5 优雅关闭

- FR-001-018：宿主句柄 MUST 暴露幂等的 `close()`；重复调用 MUST NOT 抛错、MUST NOT 造成二次关闭副作用。
- FR-001-019：`close()` MUST 先请求关闭 HTTP 服务器并等待其结束，并在超时（`SHUTDOWN_DEADLINE_MS`，默认 5000 ms）后交由 005-lifecycle 强退，避免「点了退出进程不走」。
- FR-001-020：`close()` 完成或被强退后，端口 MUST 被释放（同一进程/新进程可再次成功绑定同一端口段）。
- FR-001-021：系统 MUST 把 `SHUTDOWN_DEADLINE_MS` 的取值写入 `PI_WEB_SHUTDOWN_DEADLINE_MS`（⬜ 上游是否消费该变量待 P0-1 核实）。

### 3.6 可观测性与诊断

- FR-001-022：每个启动阶段 MUST 输出可读日志，统一前缀 `[pi-desktop]`，格式含阶段名与耗时。
- FR-001-023：启动失败时 MUST 把「阶段名 + 原因」写入应用日志**并**呈现于 loading 页；**MUST NOT** 出现「窗口无说明」的状态。
- FR-001-024：失败原因 MUST 同时挂到全局诊断槽 `globalThis.__hostError`，供探针取证。
- FR-001-025：日志 MUST NOT 输出密码明文（可打印长度或哈希前缀）、API Key、会话内容。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| 宿主句柄（HostHandle） | 本模块对 002/007/005 暴露的唯一契约 | `port: number`、`url: string`（`http://127.0.0.1:<port>/`）、`password: string`、`close(): Promise<void>` |
| 环境装配表 | 启动前要写入 `process.env` 的键值映射 | `PI_CODING_AGENT_DIR`、`PI_WEB_HOSTNAME`、`PI_WEB_PASSWORD`、`NO_PROXY`、`no_proxy`、`PI_WEB_SHUTDOWN_DEADLINE_MS` |
| 导出探测记录 | `startServer` 的候选路径与命中结果 | 候选路径列表、命中路径、函数形状校验结果（`nextEntry: string \| null` 由 009 提供） |
| 就绪探测 | 轮询状态 | 探测 URL、间隔、上限、尝试次数、最终状态 |
| 诊断槽 | 失败证据落点 | `globalThis.__hostError`（字符串，含阶段名） |

## 5. 验收场景

### 场景 A1：冷启动进入主界面

- Given 已安装/已构建的应用产物（`pi-dist.tar.gz` 与 preview 密钥可轮换）
- When 用户启动应用
- Then 服务器在主进程内监听 `127.0.0.1:<随机端口>`；`GET /` 返回 Pi Web UI SPA；窗口加载该地址并进入可交互首屏

### 场景 A2：就绪判定不依赖 stdout

- Given 服务器启动耗时超过 1 s
- When 就绪轮询运行
- Then 进程在 30 s 内以 HTTP 探测判定就绪并加载；日志中不出现任何「读取子进程 stdout」的路径

### 场景 A3：鉴权围栏生效

- Given 服务器已就绪且 `PI_WEB_PASSWORD` 已注入
- When 无凭据访问 `http://127.0.0.1:<port>/api/web-auth` 之外的受保护 API
- Then 返回 401/403；带 `Authorization: Basic pi:<password>` 时返回 200

### 场景 A4：默认无额外子进程

- Given 默认配置（未启用回退）
- When 应用运行中查看进程列表
- Then 只有 Electron 主进程与其渲染/工具进程，无额外的 `node next start` 子进程

### 场景 A5：失败可见

- Given `PI_DESKTOP_PI_DIST` 指向不存在的目录，或 `startServer` 导出探测全部失败
- When 应用启动
- Then 30 s 内进入失败态：loading 页显示阶段名与原因、日志含同一信息、`globalThis.__hostError` 有值

### 场景 A6：关闭与端口释放

- Given 应用运行中
- When 用户退出应用（托盘退出或关窗退出）
- Then 服务器在 deadline 内关闭；若超时则进程被强退；重新启动应用能再次成功绑定端口

### 场景 A7：密码不外泄

- Given 应用完整走完一次启动
- When 检查 `<userData>/logs/` 全部日志与窗口标题
- Then 不含 `PI_WEB_PASSWORD` 明文、不含凭据内容

## 6. 非功能需求

- **启动延迟**：环境装配 + 端口探测 + 密钥轮换 MUST 在秒级完成；解压等长耗时不属本模块（⬜ 首启总耗时待 P0-4 实测）。
- **失败可见（fail-visible）**：任何阶段失败都必须可读可定位，禁止「卡住但不说」与静默降级（`docs/工程规划.md` §3 原则 5）。
- **安全**：绑定仅限 loopback（§11.4 S3）；随机强密码默认开启；密码不落盘、不入日志（§11.4 S2）。
- **可测试性**：环境装配 SHOULD 抽成纯函数（输入 `userData`/设置，输出键值映射），以便在不启动 Electron 的情况下单测。
- **健壮性**：`close()` 幂等；轮询有上限；上游入口形态变化时立即报错而非半死状态。
- **内存**：本模块 MUST NOT 读取/缓存 pi-dist 内容；服务器进程内运行，内存主要由上游决定（⚠️ R3）。

## 7. 假设与约束

- **假设（✅ 已核实）**：`pi-web/node_modules/next/dist/server/lib/start-server.js` 存在且导出 `startServer(serverOptions)`；`pi-web/bin/rotate-preview-secrets.js`、`pi-web/lib/web-auth.ts`、`pi-web/bin/pi-web-options.js` 均存在。依据：本机源码核对 + `docs/工程规划.md` §4.2。
- **假设（🔶 沿用 HOS）**：进程内 `startServer` 不会导致宿主退出，页面/API/SSE 全通（HOS 真机实测结论，本工程未复现）。
- **约束**：上游内部入口不是公开 API —— 升级 `pi-web` 时必须复核导出形态（✅ `docs/工程规划.md` §11.1 R1；`plan.md` §3.4 的探测清单就是为此设计）。
- **约束**：不 fork、不打补丁（§7 补丁集 0 条必需）；形态变化时走回退候选 B 而非改上游。
- **约束**：Node 版本门禁天然满足（Electron 43.7.9 内置 Node 24.21.0 ≥ 上游 `>=22.19.0`），因此本模块**不需要** HOS 那套 Node 错位论证。
- **⬜ 待验证（P0-1）**：`startServer` 的导出名与参数形状在 Next 16.3.8 下的精确形态；`dir` 参数是否足以解析 `.next`（是否还需要 `cwd`）。
- **⬜ 待验证（P0-1）**：上游是否读取 `PI_WEB_SHUTDOWN_DEADLINE_MS`；SSE 连接是否需要在 `close()` 前显式断开（当前由 upstream `instrumentation-node.ts` 在信号路径处理，壳层直接调 `close()` 的效果待实测）。
- **⬜ 待验证**：`/api/web-auth` 作为探活端点在启用密码时是否稳定返回 2xx/4xx（而非 5xx）；若不稳定则退用 `/login`（`plan.md` §3.7）。

## 8. 依赖

**上游（被本模块消费）**

- 009-artifact-bootstrap：提供 `nextEntry`（已校验的 Next 入口路径）与 `piDistRoot`。
- 008-runtime-config：提供 `agentDir`（`PI_CODING_AGENT_DIR` 取值）。
- 005-lifecycle：提供代理绕过/系统 CA/崩溃兜底的运行时前提，并在退出链中调用本模块的 `close()`。
- 上游源码：`pi-web/node_modules/next/dist/server/lib/start-server.js`、`pi-web/bin/rotate-preview-secrets.js`。

**下游（消费本模块）**

- 002-window：用 `url` 建窗并加载，用 `password` 注入 cookie/Basic 双凭据。
- 003-tray：托盘「检查更新」之外的菜单项需要宿主就绪态与 URL 状态。
- 004-notification：需要 `agentDir` 定位会话目录（经 008）。
- 007-app-entry：按 `plan.md` 的时序编排本模块。

**外部**

- 操作系统网络栈（loopback 端口分配）、`node:net`、`node:crypto`、Electron `app`（路径与生命周期事件）。
