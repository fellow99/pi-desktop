# Pi Desktop

> 把 [Pi](https://pi.dev)（可扩展的 agent harness）与其浏览器界面 [Pi Web](https://github.com/agegr/pi-web)
> 封装成 **Windows / macOS / Linux 的一等公民桌面应用**：Electron **43.7.9** 承载
> **`pi-web` 的 Next 服务器（含 agent 与 `/api/*`）**，渲染层同源加载该服务端提供的 Pi Web UI，
> 桌面壳补齐 pi 自己没有的东西（托盘、原生通知、单实例、窗口状态、产物引导、更新引导），
> 界面 **100% 复用上游**、不 fork 前端。

**版本**：`0.1.0`（**骨架阶段：Phase 0 未取证**，见 [docs/构建验证记录.md](docs/构建验证记录.md)）
· **上游基线**：`pi` **v1.1.0**（`Branch_v1.1.0`）+ `pi-web` **v0.11.1**（`Branch_v0.11.1`）
· **运行时**：Electron **43.7.9**（Node **24.21.0** / Chromium **150.0.7871.250** / ABI **148**）
· **应用名 / 可执行名 / 应用 ID**：`Pi Desktop` / `pi-desktop` / `com.fellow99.pi.desktop`
（⬜ 应用 ID 与发布主体需人工确认，规划 §11.3）

**工程规划（source of truth）**：[docs/工程规划.md](docs/工程规划.md) —— 做什么、怎么做、按什么顺序做、有哪些风险。

---

## 这是什么

`Pi` 是一个最小、可扩展的 agent harness：扩展、技能、提示模板、主题都可替换，官方提供
CLI / RPC / JSON / SDK 四种集成入口。`Pi Web` 是它的本地浏览器界面（Next.js 16 App Router 应用），
**一个 Node 进程同时提供 SPA 与 `/api/*`**，agent 在该进程内创建（`lib/rpc-manager.ts` 直接 import
`@earendil-works/pi-coding-agent` 的 SDK，**不需要 `pi` 二进制在 PATH**）。

本工程把这一套装进 Electron 桌面壳：应用启动后**用户直接看到 Pi 的界面**，不需要手动起服务、
不需要开浏览器、不需要输入密码。它**不是**「包一层浏览器指向 localhost」的粗壳 ——
服务端与 agent 跑在 Electron 主进程进程内，桌面壳负责环境装配、产物就位、生命周期与平台能力。

> **非官方声明**：本工程非 Pi / Pi Web 团队构建，与上游作者无隶属关系，未获其背书。
> `Pi`（MIT，[earendil-works/pi](https://github.com/earendil-works/pi)）与
> `Pi Web`（MIT，[agegr/pi-web](https://github.com/agegr/pi-web)）均为上游开源项目，
> 本工程只做**装配**，不 fork、不改上游源码（本版必需补丁 **0 条**，见规划 §7）。

## 核心设计

```
┌─ Pi Desktop（Electron 43.7.9）──────────────────────────────────────────────┐
│  Electron 主进程（Node 24.21.0）                                            │
│    ├─ 环境装配：PI_CODING_AGENT_DIR / PI_WEB_* / NO_PROXY / 代理绕过         │
│    ├─ 产物就位：pi-dist.tar.gz → <userData>/pi-dist（SHA-256 marker 幂等）    │
│    ├─ rotatePreviewSecrets(<pi-dist>/.next)   ← 必须在起服务之前             │
│    ├─ 进程内 Next 服务器：startServer({dir, hostname:'127.0.0.1', port})     │
│    │     ├─ SPA（Pi Web UI）+ /api/* + SSE /api/agent/[id]/events            │
│    │     └─ agent 会话（pi SDK，同进程内）                                    │
│    ├─ 就绪判定：HTTP 轮询 /api/web-auth（**不解析 stdout**）                  │
│    ├─ 桌面能力：托盘 / 原生通知 / 窗口状态 / 单实例 / 检查更新                │
│    └─ 建窗：BrowserWindow → loadURL('http://127.0.0.1:<port>/')             │
│                              ▲ 同源（无 CORS、无自定义协议、数据面零 IPC）    │
│    ┌─────────────────────────┴──────────────────────────────────────────┐   │
│    │ 渲染进程（Chromium 150）：标准 Pi Web UI                             │   │
│    │   fetch('/api/*') 上行 · EventSource('/api/agent/[id]/events') 下行  │   │
│    └────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

启动时序（**失败可见**：任一阶段失败都会在 loading 页显示具体阶段与原因，并落 `<userData>/logs/`）：

```
[lock] 单实例锁 → [env] 环境装配 → [artifact] 产物就位（首启解压）
  → [secret] 预览密钥轮换 → [server] 进程内起 Next（随机端口 + 随机密码）
  → [ready] HTTP 轮询就绪（上限 30 s）→ [load] loadURL(http://127.0.0.1:<port>/) → 首屏
```

### 与「`pi` CLI + 浏览器打开 `pi-web`」的差异

| 维度 | `pi` CLI + 浏览器开 `pi-web` | **Pi Desktop** |
|---|---|---|
| 启动 | 手动起服务、手动开浏览器、手动贴地址 | 一条启动链：解压 → 起服务 → 轮询就绪 → 建窗 |
| 服务端形态 | `bin/pi-web.js` 用 `spawn(process.execPath, [next,'start',…])` 拉**子进程** | **主进程进程内** `startServer({dir,hostname,port})`；无子进程、无孤儿、无进程树清理 |
| 就绪判定 | 解析子进程 stdout 出现 `Ready` | **HTTP 轮询** `/api/web-auth`（免认证探活） |
| 端口 | 固定 `30141`（`PORT`/`-p`） | **随机空闲高位端口**（`listen(0)` 探测后释放） |
| 绑定 | `127.0.0.1`（`PI_WEB_HOSTNAME`/`-H`） | `127.0.0.1`（同，无 loopback 隔离问题） |
| 鉴权 | 手填密码；不设 `PI_WEB_PASSWORD` 即**完全无认证** | **宿主侧生成随机强密码**（不入日志、不回显），壳层注入 **两件凭据**：`pi_web_session` cookie（页面导航）+ `Authorization: Basic pi:<pw>`（`/api/*` 与 SSE）→ **用户永远看不到登录页** |
| 产物位置 | `.next` 在源码目录，密钥轮换写回源码树（不可写则保留构建期密钥） | `pi-dist.tar.gz` 随包，**首启解压到 `<userData>/pi-dist`**（保证可写 → 密钥可轮换） |
| 数据落点 | `~/.pi/agent` | 默认**共享** `~/.pi/agent`（直接用上已有 pi 环境），设置内可切 `<userData>/pi-agent` |
| 桌面能力 | 无 | 托盘、原生通知（会话 JSONL 尾随）、单实例唤回、窗口状态记忆、F11、外链走系统浏览器、检查更新 |
| 关闭 | 终端里 Ctrl-C | 优雅关闭链：置 `isQuitting` → 关 SSE → `httpServer.close()` → `5 s` deadline 后强退 |
| 升级 | 手动 `git pull` + 重建 | 换包即换 `pi-dist.tar.gz`；marker（SHA-256）变化即**重新解压**，不留旧文件 |

## 能力清单

标记口径：**✅ 已核实 / 已实现**｜**⚠️ 条件可用 / 受限**｜**⬜ 未实测**（附将产出该结论的探针编号）｜**❌ 明确不做**。
完整三平台矩阵、依据列与降级矩阵见 **[docs/桌面能力清单.md](docs/桌面能力清单.md)**。

| 能力 | 状态 | 说明 |
|---|---|---|
| Pi Web UI（主界面，同源加载） | ⬜ **P0-1/P0-3** | 链路已按规划落地，真机/实机首屏未取证 |
| 进程内 Next 服务器 + agent | ⬜ **P0-1** | 候选 A `start-server.js` 导出；另有 A′（NextServer API）与 B（显式 sidecar）两条回退 |
| 会话持久化 / 续接（JSONL） | ⬜ **P0-2** | 落 `PI_CODING_AGENT_DIR/sessions/` |
| 模型与凭据（OAuth / API Key） | ⬜ **P0-3 / O5** | 共享 `~/.pi/agent/auth.json` |
| 文件类工具（读/写/编辑/列目录/图片） | ⬜ **P0-2** | 依赖上游 SDK，无平台约束 |
| 终端面板 / PTY | ⬜ **P0-3** | 受 `node-pty` 在 ABI 148 下可加载性制约；不可用则明示降级 |
| MCP（stdio / HTTP） | ⬜ **P0-3** | 桌面无子进程约束，理论恢复 |
| `git` / worktree / diff | ⬜ **P0-3** | 依赖用户机有 `git`；缺失时上游自动降级且不报错 |
| 内容搜索（`rg`/`fd`） | ⚠️ 条件可用 | 需系统已有或允许下载；离线环境不可用（⬜ P0-3） |
| 扩展 / 技能在线安装 | ⚠️ 条件可用 | 需 `npm`/`git` 与网络；`PI_OFFLINE` 可作离线开关 |
| 托盘 / 原生通知 / 单实例 / 窗口状态 | ⬜ **P0-0 / P0-5** | 沿用 `dsh-desktop` 范式；通知事件源为**会话 JSONL 尾随**（零上游补丁） |
| 检查更新（半自动） | ⬜ **数据源待定** | 「检查更新 → 打开下载页」；**不自动下载、不静默安装**（规划 §5.7 / §11.3） |
| 深链 / 开机自启 / 全局快捷键 / 多窗口 | ❌ | 明确不做（Phase 2 视需求评估，规划 §5.8） |
| 代码签名 / 公证 / 静默更新 | ❌ | v1 不做；登记为 Phase 3（规划 §0.4 / §9.2 / §11.3） |
| 交叉打包 | ❌ | 三平台各自构建各自产物（原生件必须与目标平台一致） |

## 目标平台与分发

| 平台 | 产物 | 安装体验（**未签名**） | 状态 |
|---|---|---|---|
| Windows（主验证） | Squirrel `Pi Desktop-<版本> Setup.exe` + `.nupkg` + `RELEASES`、`zip` | 直装；SmartScreen 提示「更多信息 → 仍要运行」 | ⬜ **P0-6** |
| macOS | `.dmg` + `zip` | 需**右键 → 打开**，或 `xattr -dr com.apple.quarantine "/Applications/Pi Desktop.app"` | ⬜ **P0-6** |
| Linux | `.deb` + `.rpm` + `zip` | 直装（无强制签名门禁） | ⬜ **P0-6** |

安装包体积、首启耗时、内存占用均为 ⬜ 待实测（量级参考与推算见规划 §8.3）。发布流程、产物清单、
未签名安装指引与更新行为见 **[docs/发布与更新.md](docs/发布与更新.md)**。

## 技术栈

| 层 | 组件 | 版本 | 说明 |
|---|---|---|---|
| 运行时 | Electron | **43.7.9**（精确钉住，不用 `^`） | Node **24.21.0** / Chromium **150.0.7871.250** / ABI **148** |
| 运行时 | Node（Electron 内置） | 24.21.0 | 满足上游 `engines.node >= 22.19.0`，**无需** 鸿蒙版那套 Node 错位论证 |
| 构建 | Electron Forge | `^7.11.2` | `@electron-forge/plugin-vite` + `@electron/fuses` `^1.8.0` |
| 构建 | Vite | `^7.3.6`（`vite.{main,preload,renderer}.config.ts`） | 主进程入口 `src/main/index.ts` → `.vite/build/main.js` |
| 构建 | TypeScript | `^5.6.0`（strict，`tsc --noEmit`） | `@types/node` `^24.3.0` |
| 构建 | makers | Forge 5 个 maker | Squirrel(win) / ZIP(win,mac,linux) / DMG(mac) / RPM(linux) / DEB(linux) |
| CI | Node | **24.21.0** | 与运行时同版（门禁用同一个 Node 起服务） |
| 上游（随 `pi-dist` 分发） | `pi-web` | **0.11.1**（Next **16.3.8** App Router） | SPA + `/api/*`（约 90 条路由）+ SSE |
| 上游（随 `pi-dist` 分发） | `pi` | **1.1.0**（`@earendil-works/pi-coding-agent` 等） | 进程内 SDK；`packages/*` lockstep 1.1.0 |
| 上游原生件 | `node-pty` | 1.2.0-beta.15 | `serverExternalPackages`；ABI 148 可加载性 ⬜ **P0-3** |

壳层自身运行时依赖只有 `electron-squirrel-startup`；`next` / `@earendil-works/*` / `node-pty` 等全部来自
`pi-dist`（随包的 `pi-dist.tar.gz`），**不参与壳层构建**。

## 开发

### 前置条件

| 项 | 要求 |
|---|---|
| Node | **24.21.0**（官方二进制；与 Electron 43.7.9 内置版本一致）。上游门禁是 `>=22.19.0`，但门禁脚本必须与运行时同版才能代表真实行为 |
| 同级工程 | `../pi`（submodule，`Branch_v1.1.0`）、`../pi-web`（submodule，`Branch_v0.11.1`）—— 本工程用 **sibling 源码引用**，不用 npm 依赖 |
| 包管理 | `npm`（`npm ci` 消费各自的 lockfile） |
| git | 克隆 submodule、`pin:upstream` 记录 SHA、`git/worktree` 能力验证 |
| Linux 打包 | `fakeroot` + `rpm`（CI 已装） |
| 可选 | `ELECTRON_MIRROR`（Electron 二进制下载慢时设置） |

> 为什么 `pi` / `pi-web` 必须是同级源码而不是 npm 依赖：`pi-web` 的 `.next` 必须在**本机可再生**地构建
> （我们要控制 `serverExternalPackages`、按目标平台裁剪原生件、并在打包前完成预览密钥轮换）；
> 且 `pi-web` 依赖 `pi` 的**精确版本 1.1.0**，源码引用可保证两边同源同版本（规划 §2.5）。

### 四阶段构建流水线

```bash
# ① 构建 pi-web 生产产物（../pi-web：npm ci → next build → 按目标平台裁剪 → 轮换预览密钥）
node scripts/prepare-next.mjs

# ② 门禁：用与 Electron 43.7.9 同版 Node（24.21.0）起服务，断言 SPA / API / SSE / SDK 四项
node scripts/smoke-desktop.mjs

# ③ 组装 pi-dist（pi-web 产物 + @earendil-works/* + 预置模板）→ tar.gz(ustar) + SHA-256 marker
node scripts/collect-pi.mjs

# ④ 打包（premake 会自动跑 ①→③，确保一条命令可复现）
npm run make            # 出安装包，产物在 out/make/
npm run package         # 仅打包目录，不出安装包
```

等价写法（`package.json` 里已定义同名 script，供不想敲路径时使用）：

```bash
npm run prepare:next    # = node scripts/prepare-next.mjs
npm run smoke           # = node scripts/smoke-desktop.mjs
npm run collect:pi      # = node scripts/collect-pi.mjs
npm run pin:upstream    # 记录 ../pi 与 ../pi-web 的 commit SHA → upstream.lock.json
```

> ⚠️ 裁剪原生件只在**副本**（`pi-dist`）上做，绝不在 `../pi-web` 源目录里删；
> 三平台**各自构建各自产物**，不做交叉打包（否则 `node-pty` / SWC 的原生件会错平台）。

### 运行

```bash
npm ci && npm start     # Electron Forge + Vite；主进程热重载，渲染层是远程 URL（用 DevTools 调）
```

`npm start` 需要已解压的 `pi-dist`：首次请先跑流水线 ①②③，或用下面的 `PI_DESKTOP_PI_DIST` 指到已有目录。
打包态（安装后）首次启动会自行解压 `<resources>/pi-dist.tar.gz` → `<userData>/pi-dist`。

### 调试

```bash
# 服务端 / UI 直连调试（跳过解压与内嵌服务器）：先在 ../pi-web 里起一个服务
cd ../pi-web && npm ci && npm run build && npm start   # http://127.0.0.1:30141

# 回到本工程，让壳层直连它
PI_DESKTOP_DEV_SERVER=http://127.0.0.1:30141 npm start   # Git Bash
# PowerShell: $env:PI_DESKTOP_DEV_SERVER='http://127.0.0.1:30141'; npm start
```

**环境变量开关（仅用于开发调试，生产不使用）**

| 变量 | 作用 | 状态 |
|---|---|---|
| `PI_DESKTOP_DEV_SERVER` | 直连一个已运行的 pi-web（跳过解压与内嵌服务器），快速迭代 UI/服务端而不必反复打包 | 已落地：`src/main/index.ts` |
| `PI_DESKTOP_PI_DIST` | 指定一个**已解压**的 `pi-dist` 目录（跳过解压与 marker 校验，但会校验 Next 入口与 `@earendil-works/pi-coding-agent` 是否在） | 已落地：`src/main/artifact.ts` |

其它诊断手段：

- **日志**：`<userData>/logs/pi-desktop-<YYYYMMDD>.log`，统一前缀 `[pi-desktop]`；启动每个阶段都落盘，
  凭据只打印长度、**永不回显** `PI_WEB_PASSWORD` 明文。
- **loading / 兜底页**：`index.html` + `src/renderer/renderer.ts`，显示当前阶段与耗时，并提供
  「打开日志」「重试」「退出」三个动作；失败时显示**具体阶段 + 原因**。
- **主进程调试**：`--inspect` 仅限 dev（生产构建必须移除；Fuses 已关 `EnableNodeCliInspectArguments`）。
- **数据落点**：默认 `PI_CODING_AGENT_DIR = ~/.pi/agent`（与 CLI 共享凭据/会话/扩展/MCP）；
  设置里可切到 `<userData>/pi-agent`（`<userData>/pi-desktop-settings.json` 的 `agentDirMode`，
  **切换后必须重启应用**）。⚠️ 不要与 `pi` CLI 对同一会话并发写入（上游明确不支持）。

### 门禁

```bash
npm run typecheck                # strict TS（tsc --noEmit）
node scripts/smoke-desktop.mjs   # 服务端四项断言：SPA / 带凭据 API / SSE / pi SDK 建会话
```

两条必须全绿才允许打包与发布；CI（`.github/workflows/ci.yml`）以同样两条为准。

## 目录结构

本工程与同级工程**并行存放**（`pi-workspace` 是 submodule 容器仓库，构建脚本用 `../兄弟目录` 解析）：

```
pi-workspace/
├── pi/                          # [submodule] 上游宿主 + SDK，固定 Branch_v1.1.0
├── pi-web/                      # [submodule] 上游 UI + 服务端，固定 Branch_v0.11.1
├── pi-desktop/                  # [submodule] ← 本工程（Electron 桌面壳）
│      ├─ ../pi      （宿主 + SDK）  ← 构建期：npm install（产出 @earendil-works/* 依赖树）
│      └─ ../pi-web  （UI + 服务端） ← 构建期：npm ci + next build → 组装 pi-dist
├── pi-desktop-hos/              # [submodule] 鸿蒙版（独立工程；本工程只复用结论与 2 个可移植模块）
├── pi-desktop-website/          # [submodule] 官网/下载页（规划中；更新检查的候选数据源）
├── harmonypc-electron/          # [submodule] Electron-on-鸿蒙 运行时（本工程不使用）
└── harmonypc-electron-versions/ # （普通目录，gitignore）鸿蒙运行时归档（本工程不使用）
```

本工程内部（规划结构，落地状态见下方「现状」）：

```
pi-desktop/
├── src/main/                       # Electron 主进程（装配代码，无业务逻辑）
│   ├── index.ts                    # 入口编排：单实例锁 → 安全准备 → whenReady → 起宿主 → 建窗 → 托盘/通知 → 退出
│   ├── host.ts                     # 进程内 Next 宿主：环境装配、startServer、就绪轮询、鉴权注入、关闭
│   ├── artifact.ts                 # pi-dist 解压 + SHA-256 marker 幂等
│   ├── tar-extract.ts              # 流式 ustar(.gz) 解压器（移植自 pi-desktop-hos）
│   ├── windows.ts                  # BrowserWindow + loading 页 + 加载策略 + 导航加固 + 权限白名单
│   ├── window-state.ts             # window-state.json 持久化（防抖 / 边界校验）
│   ├── tray.ts                     # 托盘与菜单
│   ├── notifications.ts            # 会话 JSONL 尾随 → 原生通知（去重 / 冷却 / 仅后台）
│   ├── session-watch.ts            # 会话文件增量 tail（被 notifications 消费）
│   ├── lifecycle.ts                # NO_PROXY / 系统 CA / 崩溃兜底 / 优雅关闭 / 代理绕过
│   ├── settings.ts                 # 壳层设置（agentDirMode 等）读写
│   ├── update-check.ts             # 检查更新（半自动）
│   └── logger.ts                   # [pi-desktop] 统一日志 → <userData>/logs
├── src/preload/index.ts            # 默认空实现（按需启用最小桥；数据面永不过 IPC）
├── src/renderer/renderer.ts        # 壳层自有页面（loading / 降级页）驱动
├── index.html                      # 兜底 / loading 页（CSP: default-src 'self'）
├── resources/                      # icon.ico / icon.icns / icon.png / tray.png / trayTemplate.png
├── config/                         # 预置模板（settings.json / mcp.json / trust.json 默认值）
├── extensions/ , skills/           # 壳专用 pi 扩展与技能（可选）
├── scripts/
│   ├── prepare-next.mjs            # ① ../pi-web：npm ci → next build → 平台裁剪 → 预览密钥轮换
│   ├── smoke-desktop.mjs           # ② 门禁：Node 24.21 起服务 + SPA/API/SSE/SDK 四项断言
│   ├── collect-pi.mjs              # ③ 组装 pi-dist + tar.gz(ustar) + SHA-256 marker
│   └── pin-upstream.mjs            # 记录 ../pi 与 ../pi-web 的 commit SHA（upstream.lock.json）
├── forge.config.ts                 # packagerConfig（asar / extraResource / executableName）+ makers + plugins
├── vite.{main,preload,renderer}.config.ts , tsconfig.json , forge.env.d.ts
├── .github/workflows/{ci.yml,release.yml}
├── specs/                          # NNN-name/{spec.md,plan.md}
├── docs/                           # 工程规划 + 桌面能力清单 + 构建验证记录 + 发布与更新
├── upstream.lock.json              # 上游 commit SHA 钉住（可复现）
└── README.md
```

### 现状（骨架已落地，**Phase 0 尚未取证**）

| 状态 | 内容 |
|---|---|
| ✅ 已落地 | `package.json`（全部 scripts + `prepackage`/`premake` 钩子）、`forge.config.ts`、`vite.{main,preload,renderer}.config.ts`、`tsconfig.json`、`forge.env.d.ts`、`index.html`、`.gitignore`、`.gitattributes`、`LICENSE`；`src/main/**`（`index` / `host` / `artifact` / `tar-extract` / `windows` / `window-state` / `tray` / `notifications` / `session-watch` / `lifecycle` / `settings` / `update-check` / `logger` / `constants`）、`src/preload/index.ts`、`src/renderer/renderer.ts`、`src/types/globals.d.ts`；`scripts/{prepare-next,smoke-desktop,collect-pi,pin-upstream}.mjs`；`resources/{icon.ico,icon.icns,icon.png,tray.png,trayTemplate.png}`；`config/{settings.json,mcp.json}`；`.github/workflows/{ci.yml,release.yml}`；`specs/`（`README` / `constitution` / `ARCHITECTURE` / `TECH` / `STRUCTURE` / `overall-{spec,plan}` + `001-host`、`002-window`） |
| ⬜ 待产出（构建物，gitignore） | `pi-dist.tar.gz` + `pi-dist.version`（跑流水线 ①③ 后生成）、`upstream.lock.json`（跑 `pin:upstream` 后生成）、`out/`、`.vite/`、`logs/` |
| ⬜ 待落地（可选/后续） | `extensions/`、`skills/`（壳专用扩展与技能，Q7 的可选档）、`specs/003…011` + `201-plugin-runtime` |
| ⬜ 未取证 | **全部运行期结论**（首屏、终端、通知、打包冒烟、安装包体积、首启耗时）→ 逐项见 [docs/桌面能力清单.md](docs/桌面能力清单.md) 与 [docs/构建验证记录.md](docs/构建验证记录.md) |

注 1：本表是「README 建档时点」的快照；文件是否齐备以仓库现状为准（`git status` / `ls`），
结论是否成立一律以 `docs/构建验证记录.md` 的探针记录为准。
注 2：两条门禁在 CI 里的实际执行顺序是 `prepare-next → collect-pi → smoke → electron-forge make`
（`.github/workflows/ci.yml`）；smoke 仍是阻断项，只是放在 collect 之后执行。
注 3：**与规划的已知落差**（需补，见 `docs/工程规划.md`）：① 规划 §7 要求建立 `patches/` 目录并写明「本版本为空」，仓库目前没有该目录；② 规划 §6.2 / `specs/ARCHITECTURE.md` 列出预置模板 `config/trust.json`，
而 `config/` 只有 `settings.json`、`mcp.json`（`src/main/settings.ts` 也只物化这两个）。

## 相关文档

| 文档 | 内容 |
|---|---|
| [docs/工程规划.md](docs/工程规划.md) | **工程规划**：架构、结构、流水线、能力与降级、分阶段计划、风险（source of truth） |
| [docs/桌面能力清单.md](docs/桌面能力清单.md) | 三平台 × 能力矩阵、降级矩阵、证据标注、与鸿蒙版的能力差异 |
| [docs/构建验证记录.md](docs/构建验证记录.md) | 每轮构建/实机验证的台账 + Phase 0 探针（P0-0…P0-6）出口判据 |
| [docs/发布与更新.md](docs/发布与更新.md) | 版本策略、CI/Release 工作流、三平台产物、未签名安装指引、更新行为与升级语义 |
| [specs/](specs/) | 模块规格（`NNN-name/{spec.md,plan.md}`，编号 `001-host`…`011-release-update`、`201-plugin-runtime`）+ `specs/{README,constitution,ARCHITECTURE,TECH,STRUCTURE,overall-spec,overall-plan}.md`；已建 `001-host`、`002-window` |

## 上游声明与许可

- **本工程非官方**：由第三方（`fellow99`）独立实现，与 Pi / Pi Web 上游作者无隶属关系，未获其背书。
- **不 fork、只装配**：本版必需补丁 **0 条**（逐条理由见规划 §7）；对上游只做幂等处理，从不覆盖用户改动。
- **上游许可**：[Pi](https://github.com/earendil-works/pi) MIT · [Pi Web](https://github.com/agegr/pi-web) MIT。
  随包分发的 `pi-dist.tar.gz` 内含上游产物，其许可与版权归上游所有；本工程代码为 MIT（见 [LICENSE](LICENSE)）。
- **名称声明**：本工程名称含 `pi`，仅为说明被封装的上游项目；应用内「关于」页同样标注以上声明。
