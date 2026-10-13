# ARCHITECTURE.md — 整体架构

> pi-desktop 整体架构（2026-10-12）。核心设计见 [`../docs/工程规划.md`](../docs/工程规划.md) §4；
> 本文件是它的**收敛版**：只保留结构、数据流与决策结论，论证过程回引 § 号。

---

## 1. 架构一句话

基于 Electron 43 的 Pi 桌面封装 —— **主进程内嵌 `pi-web` 的 Next 服务器（含 `pi` agent，进程内 SDK）**，
渲染进程**同源**加载 `http://127.0.0.1:<随机端口>/` 上的标准 Pi Web UI；桌面壳只补 Pi 自己没有的东西
（托盘、原生通知、单实例、窗口状态、首启产物引导、更新引导），**不 fork 上游、不重写前端、数据面不过 IPC**
（工程规划 §1.1、§3、§4.1）。

---

## 2. 进程模型

```
┌─ Pi Desktop（Electron 43.7.9 / Node 24.21.0 / Chromium 150.0.7871.250 / ABI 148）──────────┐
│  Electron 主进程（Node 24.21.0）                                                           │
│    ├─ 环境装配：PI_CODING_AGENT_DIR / PI_WEB_* / NO_PROXY / proxy-bypass-list              │
│    ├─ 产物就位：pi-dist.tar.gz → <userData>/pi-dist（SHA-256 marker 幂等）                   │
│    ├─ rotatePreviewSecrets(<pi-dist>/.next)      ← 必须在起服务之前                          │
│    ├─ 进程内 Next 服务器：startServer({dir, hostname:'127.0.0.1', port})                    │
│    │     ├─ SPA（Pi Web UI）+ /api/* + SSE /api/agent/[id]/events                          │
│    │     └─ agent 会话（pi SDK，**同进程内**，pi-web 用 globalThis.__piSessions 持有）        │
│    ├─ 就绪判定：HTTP 轮询（**不解析 stdout** —— 那是 CLI 启动器的做法）                       │
│    ├─ 桌面能力：托盘 / 原生通知 / 窗口状态 / 单实例 / 检查更新                                │
│    └─ 建窗：BrowserWindow → loadURL('http://127.0.0.1:<port>/')                            │
│                              ▲ 同源（零 CORS、零自定义协议、数据面零 IPC）                    │
│    ┌─────────────────────────┴───────────────────────────────────────────────────────┐   │
│    │ 渲染进程（Chromium 150）：**标准 Pi Web UI，100% 复用**                             │   │
│    │   fetch('/api/*') 上行 · EventSource('/api/agent/[id]/events') 下行（无 WebSocket）│   │
│    └───────────────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

**进程数**：主进程 1 + 渲染进程 1（+ Electron 自身的 GPU/utility 子进程）+ 用户触发的工具/终端子进程
（由上游按需 spawn）。**本工程不引入任何自有子进程**（工程规划 Q2、§4.2）。

图示来源：工程规划 §4.1；服务端构成 ✅ 已核实上游源码（`pi-web/bin/pi-web.js`、`lib/rpc-manager.ts`、
`next.config.ts` 的 `serverExternalPackages`），"宿主不退出" 为 🔶 `pi-desktop-hos` 实测结论，本工程 ⬜ 待探针 **P0-1** 复现。

---

## 3. 分层

| 层 | 组件（本工程路径） | 职责 |
|---|---|---|
| 入口编排 | `src/main/index.ts` | 单实例锁 → 安全准备 → `AppUserModelId` → 起宿主 → 建窗 → 托盘/通知 → `activate`/退出 |
| 宿主接线 | `src/main/host.ts` | 环境装配、产物定位、`startServer`、HTTP 轮询就绪、优雅关闭（含 deadline 强退） |
| 产物引导 | `src/main/artifact.ts` + `src/main/tar-extract.ts` | `pi-dist.tar.gz` 流式解压 → `<userData>/pi-dist`，SHA-256 marker 幂等 |
| 窗口层 | `src/main/windows.ts` + `src/main/window-state.ts` | `BrowserWindow`、loading 页（阶段可见）、加载策略、导航加固、权限白名单、窗口状态持久化 |
| 桌面能力 | `src/main/tray.ts` / `notifications.ts` / `session-watch.ts` / `update-check.ts` | 托盘、原生通知（会话 JSONL 尾随）、检查更新（半自动） |
| 横切 | `src/main/lifecycle.ts` / `settings.ts` / `logger.ts` / `constants.ts` | `NO_PROXY`、系统 CA、崩溃兜底、代理绕过、数据目录策略、统一日志、常量接缝 |
| 壳层页面（渲染） | `index.html` → `src/renderer/renderer.ts` | 仅「启动中 / 启动失败」兜底页（CSP `default-src 'self'`）；**主界面来自内嵌服务端** |
| 壳层桥（preload） | `src/preload/index.ts` | 默认空实现；按需启用**只承载壳层动作**的最小桥（数据面永不过 IPC） |
| 宿主（上游） | `<pi-dist>/.next`（`pi-web` 16.3.8）+ `@earendil-works/*` | SPA + `/api/*` + SSE + 进程内 agent 会话 |
| 配置与模板 | `config/`（`settings.json` / `mcp.json` / `trust.json` 默认值） | 壳层预置（**只在文件不存在时写入**，不覆盖用户改动） |

> 分层口径与 `dsh-desktop` 相同（工程规划 §6.3 的「保留范式」行）；`dsh-desktop` 的
> `src/main/runtime.ts`（便携 Node/pnpm 市场运行时）、`profiles/desktop/`、`dsh-dist/` 在本工程**均无对应物**
> （§4.9、§6.3）。

---

## 4. 数据流

| 方向 | 通道 | 说明 |
|---|---|---|
| **上行（unary）** | 渲染进程 `fetch('/api/<route>')`（同源） → Next 服务器 → `pi-web` 路由 → `pi` SDK | 约 90 条路由（`sessions/**`、`agent/**`、`files/**`、`git/**`、`worktrees`、`terminal/**`、`auth/**`、`models/**`、`mcp/**`、`plugins/**`、`skills/**`、`subagents/**`、`cwd/**`、`project-trust`、`web-auth`、`push/**`）（✅ 已核实上游，工程规划 §2.2） |
| **下行（事件帧）** | 渲染进程 `EventSource('/api/agent/[id]/events')` → `text/event-stream` | 终端同理 `/api/terminal/[id]/events`。**`pi-web` 没有 WebSocket**（与 `dsh-desktop` 的关键差异，工程规划 §2.6） |
| **壳层事件源（托盘/通知）** | 主进程尾随会话 JSONL：`fs.watch` + 增量 tail `<agentDir>/sessions/**/*.jsonl` | 为什么不用宿主事件：`pi-web` 的事件只通过 SSE 暴露给渲染层，主进程**没有**现成钩子；尾随方案**零上游补丁**、不耦合上游内部模块、**与窗口可见性/渲染进程状态无关**（工程规划 §5.4） |
| **壳层 IPC** | **无**（默认） | 数据面不经 IPC；只有 §5.6 登记的按需最小桥例外 |

**数据落点**（工程规划 §4.6）：

| 变量/路径 | 目标 |
|---|---|
| `PI_CODING_AGENT_DIR` | 默认 `~/.pi/agent`（`os.homedir()`）；设置内可切 `<userData>/pi-agent` |
| `HOME` / `USERPROFILE` / `TMPDIR` | **不改**（桌面无沙箱 —— 与 `pi-desktop-hos` 的关键差异） |
| `pi-dist` | `<userData>/pi-dist/`（首启由 `pi-dist.tar.gz` 解压；marker `.pi-dist.sha256` 的语义见 [overall-data-model.md](./overall-data-model.md) §1.2） |
| 窗口状态 | `<userData>/window-state.json` |
| 应用日志 | `<userData>/logs/pi-desktop-<YYYYMMDD>.log` |

---

## 5. 关键架构决策

| # | 决策 | 理由 | 出处 |
|---|---|---|---|
| 1 | **三平台**（Windows 主验证 + macOS/Linux CI 出包） | 与 `dsh-desktop` 一致；上游本就跨三平台 | Q1、§1.1 |
| 2 | **主进程进程内嵌 Next 服务器**（sidecar 登记为回退 B，不默认启用） | 同型于 `dsh-desktop`；生命周期最简（无孤儿进程）；`pi-desktop-hos` 已实证进程内可行 | Q2、§4.2 |
| 3 | **渲染通道唯一形态 = `BrowserWindow` 同源加载 `http://127.0.0.1:<port>/`** | 与上游认证 / Host / Origin / `Sec-Fetch-Site` 校验天然兼容（IP 字面量放行）。`file://` 静态导出**不可行**（`pi-web` 不可静态导出）；自定义协议会触发 Host/Origin 403 | §4.3 |
| 4 | **产物分发 = `pi-dist.tar.gz` 随包 + 首启解压到 `<userData>/pi-dist`**（SHA-256 marker 幂等） | 安装包只增 ≈116 MB；**解压目标可写 → 预览密钥可轮换**（只读目录会保留构建期密钥，留下 `x-prerender-revalidate` 绕过 proxy 的口子）；升级语义明确 | Q3、§4.2、§8.3 |
| 5 | **Electron 43.7.9** 精确钉版本（Node 24.21.0 / ABI 148） | 天然满足上游 `node>=22.19.0` 门禁（无需 HOS 那套错位论证）；与 `dsh-desktop` 同主版本；含安全补丁 | Q4、§4.4 |
| 6 | **鉴权 = 上游自带 `PI_WEB_PASSWORD` 随机强密码 + cookie/Basic 双凭据注入** | 服务端有文件读写 + 命令执行能力，仅靠 loopback 不够；上游已提供围栏，壳层只做注入 | §4.5 |
| 7 | **数据落点默认共享 `~/.pi/agent`**，可切应用私有目录 | 桌面版价值在「直接用上你已有的 pi 环境」（凭据/会话/扩展/MCP 立即可见）；私有目录作隔离退路，切换需重启 | Q6、§4.6 |
| 8 | **扩展层沿用上游 UI（Plugins/Skills/MCP/Agents）+ 壳层少量预置**，不另建市场工程 | 上游已内置可视化插件管理，自建市场属重复建设 | Q7、§6.3 |
| 9 | **不签名 + 无静默更新**，但做「检查更新 → 引导下载」半自动层 | 关键风险在架构而非发布工程；签名/公证后置 Phase 3 | Q5、§5.7 |
| 10 | **桌面能力事件源 = 会话 JSONL 尾随**（而非宿主事件钩子或渲染层上报） | 零上游补丁；与窗口可见性无关；不耦合上游内部实现 | §5.4 |
| 11 | **关窗即退出 + 优雅关闭链 + deadline 强退** | `pi-web` 的 SSE 会让 Next 16 的 `server.close()` 永不退出；必须由壳层按时序配合，deadline 5000 ms | §4.2 ⚠️、§5.2 |
| 12 | **安全基线**：`sandbox` + `contextIsolation` + 无 `nodeIntegration` + 六项 Fuses + 导航加固 + 权限白名单 | 渲染层加载的是「本地服务提供的可执行能力界面」，按不可信内容对待 | §4.5、§11.4 |

---

## 6. 与参考工程的差异

### 6.1 与 `dsh-desktop`（方案模板）

| 维度 | `dsh-desktop` | **本工程** | 说明 |
|---|---|---|---|
| 被封装的服务端 | dsh Host（cordis profile，`runProfile('desktop')`） | **`pi-web` 的 Next 服务器 + 内嵌 agent** | 等价 `next start` |
| 下行事件 | **WebSocket**（`/api/events.mux`） | **SSE**（`/api/agent/[id]/events`） | `pi-web` 无 WebSocket，链路更简单 |
| 宿主进程 | 主进程进程内 | 主进程进程内 | 同构 |
| 鉴权 | Host 启动令牌（`?token=` → cookie 交换） | `PI_WEB_PASSWORD` 随机强密码 + 双凭据注入 | 上游自带围栏 |
| 产物分发 | 原始目录走 `extraResources`（≈1 GB / 5.6 万文件） | **`pi-dist.tar.gz`（≈116 MB）首启解压** | 体积差 ~10×；并解决只读导致的密钥不可轮换 |
| 插件分发 | 独立市场工程（`201-dsh-market`） | 沿用上游 Plugins/Skills/MCP UI（**无市场工程**） | Q7 |
| 事件源（托盘/通知） | 宿主 `ctx.on('session/event')` | **壳层尾随会话 JSONL** | 零补丁、与窗口可见性无关 |
| profile / 配置 | `profiles/desktop/` + `cordis.patch.yml` | `config/` 预置模板 + `agentDirMode` 设置 | `pi` 无 profile 概念 |
| 补丁 | 2 条必需（HMR、原生目录对话框） | **0 条必需**（逐条登记理由） | §7 |
| 自动更新 | 不做 | **半自动**：检查更新 → 引导下载 | Q5 |
| 平台 | Windows 主 / macOS / Linux | Windows 主 / macOS / Linux | 一致 |

### 6.2 与 `pi-desktop-hos`（同族已验证实现）

| 维度 | `pi-desktop-hos`（Electron-on-鸿蒙 37.2.3） | **本工程（Electron 43.7.9）** | 说明 |
|---|---|---|---|
| 宿主形态 | 主进程进程内 Next | 主进程进程内 Next | 结论**复用**（同 `next` 16.3.8 内部入口 + 导出探测 + 回退） |
| 产物引导 | `tar-extract.js` 流式 ustar + SHA-256 marker | **移植同一实现**（`src/main/tar-extract.ts`） | 与平台无关 |
| 凭据注入 | 预览密钥轮换 + cookie/Basic 双凭据 | **复用同一逻辑** | 上游认证机制相同 |
| 绑定地址 | `0.0.0.0` + 局域网 IP 加载（平台 loopback 隔离） | **`127.0.0.1` + 随机端口** | ❌ 不复用其暴露面 |
| `HOME` / `TMPDIR` | 必须重定向到沙箱 + monkey-patch | **不改** | ❌ 不复用（桌面无沙箱） |
| Node 门禁 | Node 22.17 低于上游要求 → 专门论证 + WASM SWC | Node 24.21 天然满足；桌面有原生 SWC | ❌ 不复用 |
| 终端 / PTY、MCP stdio、OAuth 回环、`git`/worktree、`rg`/`fd`、在线安装扩展 | 均受限或降级 | **全部恢复** | ⚠️ 与 HOS 的关键差异（受 `node-pty` ABI ⬜ 制约除外） |
| 扩展来源 | PL1 仅本地源 + `PI_OFFLINE=1` | 默认可联网安装（保留 `PI_OFFLINE` 作可选开关） | ❌ 不复用 |
| 分发 | HarmonyOS 签名 / ACL / 上架合规 | GitHub Release（不签名，Phase 3 决策） | 不适用 |

> 详细的能力恢复矩阵见工程规划 §9.3；复用清单见 §4.10。

---

## 7. 部署拓扑

- **分发**：Electron Forge 5 个 maker → GitHub Actions 三 OS 矩阵 → Release 资产
  （Windows：Squirrel `.exe` + `.nupkg` / macOS：`.dmg` + `.zip` / Linux：`.deb` + `.rpm` + `.zip`）（工程规划 §8.5）。
- **不签名、不公证**（v1）：Windows 直装（SmartScreen 警告）、macOS 需**右键打开**或
  `xattr -dr com.apple.quarantine`、Linux 直装。⬜ 是否签名/公证见工程规划 §11.3 待确认事项。
- **运行时依赖**：`pi-dist.tar.gz`（≈116 MB，含 `pi-web` 的 `.next` 产物与其运行依赖）随包；
  壳层依赖只有 `electron-squirrel-startup`。
- **上游依赖**：`../pi`（tag v1.1.0）与 `../pi-web`（tag v0.11.1）为 **sibling 源码引用**，
  CI 用 `git clone --depth 1` 克隆到平级目录，commit SHA 记录在 `upstream.lock.json`
  （为什么不用 npm 包：`.next` 必须本机可再生产、需按目标平台裁剪原生件、`pi-web` 依赖 `pi` 的精确版本 1.1.0）。⚠️
- **无服务端基础设施**：本工程不部署任何服务器；「本地服务器」只存在于用户机器上的应用进程内。
