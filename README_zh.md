[English](./README.md) | 中文

---

# Pi Desktop

> 把 [Pi](https://github.com/earendil-works/pi)（可扩展的 agent harness）与其浏览器界面
> [Pi Web](https://github.com/agegr/pi-web) 封装成 **Windows / macOS / Linux 的一等公民桌面应用**：
> Electron **43.7.9** 承载 **`pi-web` 的 Next 服务器（含 agent 与 `/api/*`）**，渲染层同源加载该服务端
> 提供的 Pi Web UI，桌面壳补齐 pi 自己没有的东西（托盘、原生通知、单实例、窗口状态、产物引导、更新引导），
> 界面 **100% 复用上游**、不 fork 前端。

**版本**：`0.11.1`（tag `v0.11.1`；**Phase 0 已取证**，见 [docs/构建验证记录.md](docs/构建验证记录.md)）
· **上游基线**：`pi` **v1.1.0**（`Branch_v1.1.0`）+ `pi-web` **v0.11.1**（`Branch_v0.11.1`）
· **运行时**：Electron **43.7.9**（Node **24.21.0** / Chromium **150.0.7871.250** / ABI **148**）
· **应用名 / 可执行名 / 应用 ID**：`Pi Desktop` / `pi-desktop` / `com.fellow99.pi.desktop`

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
│    ├─ chdir(<pi-dist>)                        ← Next 的项目根基准（跨盘符必须）│
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
  → [secret] 预览密钥轮换 → [cwd] 切工作目录到产物根 → [server] 进程内起 Next（随机端口 + 随机密码）
  → [ready] HTTP 轮询就绪（上限 30 s）→ [auth] 注入会话凭据 → [load] loadURL(http://127.0.0.1:<port>/) → 首屏
```

### 与「`pi` CLI + 浏览器打开 `pi-web`」的差异

| 维度 | `pi` CLI + 浏览器开 `pi-web` | **Pi Desktop** |
|---|---|---|
| 启动 | 手动起服务、手动开浏览器、手动贴地址 | 一条启动链：解压 → 起服务 → 轮询就绪 → 建窗 |
| 服务端形态 | `bin/pi-web.js` 用 `spawn(process.execPath, [next,'start',…])` 拉**子进程** | **主进程进程内** `startServer({dir,hostname,port})`；无子进程、无孤儿、无进程树清理 |
| 就绪判定 | 解析子进程 stdout 出现 `Ready` | **HTTP 轮询** `/api/web-auth`（免认证探活，要求 **200**） |
| 端口 | 固定 `30141`（`PORT`/`-p`） | **随机空闲高位端口**（`listen(0)` 探测后释放） |
| 绑定 | `127.0.0.1`（`PI_WEB_HOSTNAME`/`-H`） | `127.0.0.1`（同，无 loopback 隔离问题） |
| 鉴权 | 手填密码；不设 `PI_WEB_PASSWORD` 即**完全无认证** | **宿主侧生成随机强密码**（不入日志、不回显），壳层注入 **两件凭据**：`pi_web_session` cookie（页面导航）+ `Authorization: Basic pi:<pw>`（`/api/*` 与 SSE）→ **用户永远看不到登录页** |
| 产物位置 | `.next` 在源码目录，密钥轮换写回源码树（不可写则保留构建期密钥） | `pi-dist.tar.gz` 随包，**首启解压到 `<userData>/pi-dist`**（保证可写 → 密钥可轮换） |
| 数据落点 | `~/.pi/agent` | 默认**共享** `~/.pi/agent`（直接用上已有 pi 环境），设置内可切 `<userData>/pi-agent` |
| 桌面能力 | 无 | 托盘、原生通知（会话 JSONL 尾随）、单实例唤回、窗口状态记忆、F11、外链走系统浏览器、检查更新 |
| 品牌 | 上游 `Pi Web` 文案与图标 | **`Pi Desktop` 品牌 + 父工程物料图标**（见下节） |
| 关闭 | 终端里 Ctrl-C | 优雅关闭链：置 `isQuitting` → 关 SSE → `httpServer.close()` → `5 s` deadline 后强退 |
| 升级 | 手动 `git pull` + 重建 | 换包即换 `pi-dist.tar.gz`；marker（SHA-256）变化即**重新解压**，不留旧文件 |

## 品牌与图标（需求 012-branding）

本工程是「装配」工程，因此品牌化**只施加在自己的产物上**（`pi-dist/` 副本与 `resources/`），上游三仓零改动：

| 项 | 做法 |
|---|---|
| UI 文案 | 构建期在 `pi-dist` 副本内把带空格的字面量 `Pi Web` → `Pi Desktop`（本轮实测 **1035 处 / 36 文件**）；技术标识符（`pi-web`、`PI_WEB_*`、`PiWeb`…）计数**替换前后逐项不变**（757 → 757） |
| 页面 Logo | 只替换**渲染用** `<img src>` → 物料矢量 `/icons/logo.svg`（6 处）；`rel="apple-touch-icon"` 元数据与 `public/sw.js` 预缓存**不动** |
| web 位图图标 | `public/icons/{icon-512,icon-192,apple-touch-icon}.png` + `favicon.ico` 路由体由物料生成并**回读 IHDR 校验**（512² rgb24 不透明；其余带 alpha） |
| 应用图标 | `resources/{icon.png,icon.ico,icon.icns,tray.png,trayTemplate.png}` 由物料**逐字节固化**，窗口图标显式使用物料 |
| 物料来源 | **父工程 `<workspace>/assets/`**（唯一来源，缺失/尺寸不符/透明度不符 ⇒ **构建失败**）；同时镜像到 `resources/brand/` 供 CI 使用 |
| 版本检测 | 运行时置位 `PI_WEB_SKIP_VERSION_CHECK=1`：`/api/app-update` 返回 `updateAvailable=false`、`releaseUrl=""`，但**保留 `currentVersion` 显示**（实测 `0.11.1`）；壳层自己的「检查更新」是唯一更新引导 |
| 实现 | `scripts/brand-assets.mjs`（可 `npm run brand` 单独跑）+ `scripts/collect-pi.mjs` 接线；末尾三层断言 + 全树终检（`Pi Web` = 0 处） |

## 能力清单

标记口径：**✅ 已实测**｜**⚠️ 条件可用 / 受限**｜**⬜ 未实测**（附将产出该结论的探针编号）｜**❌ 明确不做**。
完整三平台矩阵、依据列与降级矩阵见 **[docs/桌面能力清单.md](docs/桌面能力清单.md)**；每轮取证见
**[docs/构建验证记录.md](docs/构建验证记录.md)**（Windows 已取证的轮次 1 / 轮次 2）。

| 能力 | Windows | 说明 |
|---|---|---|
| Pi Web UI（主界面，同源加载） | ✅ | 打包态首屏达成；UI 标记命中；`document.title = Pi Desktop` |
| 进程内 Next 服务器 + agent | ✅ | `startServer({dir,…})` 监听成功、`/api/*` 全 200、主进程不退出、预览密钥已轮换（P0-1） |
| 会话持久化 / 续接（JSONL） | ✅ | 建会话 200、SSE 首块到达、真实对话拿到回复（P0-2 / TC-14） |
| 模型与凭据（API Key） | ✅ | 打包态设置 DeepSeek API Key → 一轮真实对话成功（共享 `~/.pi/agent/auth.json`） |
| 文件类工具（读/写/编辑/列目录/图片） | ✅ | 随 agent 调用；依赖上游 SDK，无平台约束 |
| 终端面板 / PTY | ✅ | `node-pty` 在 ABI 148 下**可加载**并跑通命令（`POST /api/terminal` → 写入 → 流内拿到输出） |
| MCP（stdio / HTTP） | ⬜ | 桌面无子进程约束，理论恢复；未逐项实测 |
| `git` / worktree / diff | ⬜ | 依赖用户机有 `git`；缺失时上游自动降级且不报错 |
| 内容搜索（`rg`/`fd`） | ⚠️ | 需系统已有或允许下载；离线环境不可用（`PI_OFFLINE=1`） |
| 扩展 / 技能在线安装 | ⚠️ | 需 `npm`/`git` 与网络；上游 UI 已内置管理 |
| 托盘 / 单实例 / 窗口状态 | ✅ | 托盘创建成功；单实例锁 + 第二实例唤回；窗口状态持久化 |
| 原生通知 | ✅ | 仅窗口不可见/未聚焦时弹；同一会话 10 s 冷却去重；启动不补弹；实测延迟 **2054 ms** |
| 浏览器安全上下文（`crypto.subtle` / `localStorage`） | ✅ | loopback 属可信来源：`isSecureContext=true`、SHA-256 实算通过、localStorage 可读写 |
| `window.open` 拦截 | ✅ | 返回 `null`，外链交系统浏览器 |
| 检查更新（半自动） | ✅ | 「检查更新 → 打开下载页」；**不自动下载、不静默安装** |
| 深链 / 开机自启 / 全局快捷键 / 多窗口 | ❌ | 明确不做（Phase 2 视需求评估） |
| 代码签名 / 公证 / 静默更新 | ❌ | v1 不做；登记为 Phase 3 |
| 交叉打包 | ❌ | 三平台各自构建各自产物（原生件必须与目标平台一致） |

## 目标平台与分发

| 平台 | 产物 | 安装体验（**未签名**） | 状态 |
|---|---|---|---|
| Windows（主验证） | Squirrel `Pi Desktop-<版本> Setup.exe` + `.nupkg` + `RELEASES`、`zip` | 直装；SmartScreen 提示「更多信息 → 仍要运行」 | ✅ 已实测：`make` → 安装 → 启动到首屏 → 卸载（见下） |
| macOS | `.dmg` + `zip` | 需**右键 → 打开**，或 `xattr -dr com.apple.quarantine "/Applications/Pi Desktop.app"` | ⬜ 未在 mac 上跑过 |
| Linux | `.deb` + `.rpm` + `zip` | 直装（无强制签名门禁） | ⬜ 未在 Linux 上跑过 |

**Windows 实测数据（轮次 2）**：`Pi Desktop-0.11.1 Setup.exe` = **351,521,280 B**；安装落点
`%LOCALAPPDATA%\pi_desktop\app-0.11.1`；安装后**启动已安装副本**即到首屏（对该副本重跑 `probe-renderer`
仍 7 PASS / 0 FAIL）；卸载后注册表项消失、**孤儿进程 0**。
⚠️ Squirrel 卸载会保留安装根（`Update.exe` + 壳目录，实测 ≈2.7 MB），`<userData>` 按设计保留 —— 详见
[docs/发布与更新.md](docs/发布与更新.md) §4「卸载行为与残留」。

发布流程、产物清单、未签名安装指引与更新行为见 **[docs/发布与更新.md](docs/发布与更新.md)**；
`.github/workflows/release.yml` 由 **tag `v*`**（或手动 `workflow_dispatch`）触发，三 OS 矩阵构建后发布 Release 资产。

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
| 上游原生件 | `node-pty` | 1.2.0-beta.15 | `serverExternalPackages`；**ABI 148 下实测可加载**（轮次 2），并有构建期完整性守卫（`FR-010-027`） |

壳层自身运行时依赖只有 `electron-squirrel-startup`；`next` / `@earendil-works/*` / `node-pty` 等全部来自
`pi-dist`（随包的 `pi-dist.tar.gz`），**不参与壳层构建**。

## 开发

### 前置条件

| 项 | 要求 |
|---|---|
| Node | **24.21.0**（官方二进制；与 Electron 43.7.9 内置版本一致）。上游门禁是 `>=22.19.0`，但门禁脚本必须与运行时同版才能代表真实行为 |
| 同级工程 | `../pi`（submodule，`Branch_v1.1.0`）、`../pi-web`（submodule，`Branch_v0.11.1`）—— 本工程用 **sibling 源码引用**，不用 npm 依赖 |
| 品牌物料 | `../assets/`（父工程：`logo.svg`、`logo.png`、`logo-1024-with-bg.png`、`logo-200-with-bg.png`、`logo.ico`、`logo.icns`）——缺失即构建失败（可用 `--assets` 或 `PI_ASSETS_DIR` 覆盖） |
| 包管理 | `npm`（`npm ci` 消费各自的 lockfile） |
| git | 克隆 submodule、`pin:upstream` 记录 SHA、`git/worktree` 能力验证 |
| Linux 打包 | `fakeroot` + `rpm`（CI 已装） |
| 可选 | `ELECTRON_MIRROR`（Electron 二进制下载慢时设置）、`ffmpeg`（生成 web 位图图标时需要） |

> 为什么 `pi` / `pi-web` 必须是同级源码而不是 npm 依赖：`pi-web` 的 `.next` 必须在**本机可再生**地构建
> （我们要控制 `serverExternalPackages`、按目标平台裁剪原生件、并在打包前完成预览密钥轮换）；
> 且 `pi-web` 依赖 `pi` 的**精确版本 1.1.0**，源码引用可保证两边同源同版本（规划 §2.5）。

### 四阶段构建流水线

```bash
# ① 构建 pi-web 生产产物（../pi-web：npm ci → 原生依赖完整性校验 → next build）
node scripts/prepare-next.mjs

# ② 门禁：用与 Electron 43.7.9 同版 Node（24.21.0）起服务，断言 SPA / API / SSE / SDK 四项
node scripts/smoke-desktop.mjs

# ③ 组装 pi-dist（pi-web 产物 + @earendil-works/* + 预置模板）→ 品牌化 → 终检 → tar.gz(ustar) + SHA-256 marker
node scripts/collect-pi.mjs

# ④ 打包（premake 会自动跑 ①→③，确保一条命令可复现）
npm run make            # 出安装包，产物在 out/make/
npm run package         # 仅打包目录，不出安装包
```

等价写法（`package.json` 里已定义同名 script）：

```bash
npm run prepare:next    # = node scripts/prepare-next.mjs
npm run smoke           # = node scripts/smoke-desktop.mjs
npm run collect:pi      # = node scripts/collect-pi.mjs
npm run brand           # = node scripts/brand-assets.mjs（物料校验 + 图标固化 + pi-dist 品牌化）
npm run pin:upstream    # 记录 ../pi 与 ../pi-web 的 commit SHA → upstream.lock.json
npm run probe:renderer  # 对**运行中**的应用做渲染层/终端断言（需 --debug-port）
```

> ⚠️ 裁剪原生件只在**副本**（`pi-dist`）上做，绝不在 `../pi-web` 源目录里删；
> 三平台**各自构建各自产物**，不做交叉打包（否则 `node-pty` / SWC 的原生件会错平台）。
>
> ⚠️ 原生依赖完整性是构建门禁的一部分（`FR-010-027`）：`prepare-next` 会检查 `node-pty` 是否真有
> `build/Release/*.node` 或 `prebuilds/<platform>-<arch>/*.node`；**空壳目录即构建失败**并给出修法。
> 起因：上游 `scripts/prebuild.js` 只判断目录是否存在，空目录会被误判为「已预构建」而跳过 `node-gyp`，
> 症状要到运行期终端 500 才暴露（本机实测踩到过）。

### 运行

```bash
npm ci && npm start     # Electron Forge + Vite；主进程热重载，渲染层是远程 URL（用 DevTools 调）
```

`npm start` 需要已解压的 `pi-dist`：首次请先跑流水线 ①②③，或用下面的 `PI_DESKTOP_PI_DIST` 指到已有目录。
打包态（安装后）首次启动会自行解压 `<resources>/pi-dist.tar.gz` → `<userData>/pi-dist`（数万文件，约 2 分钟；
marker 一致时跳过）。

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
| `PI_DESKTOP_PI_DIST` | 指定一个**已解压**的 `pi-dist` 目录（跳过解压与 marker 校验）；值会被解析成绝对路径（`chdir` 后仍然可用） | 已落地：`src/main/artifact.ts` |
| `PI_DESKTOP_HOST_MODE=spawn` | 显式改用 sidecar（`next start` 子进程）而非进程内宿主；用于对照排查 | 已落地：`src/main/host.ts` |

其它诊断手段：

- **日志**：`<userData>/logs/pi-desktop-<YYYYMMDD>.log`，统一前缀 `[pi-desktop]`；启动每个阶段都落盘，
  凭据只打印长度、**永不回显** `PI_WEB_PASSWORD` 明文。
- **loading / 兜底页**：`index.html` + `src/renderer/renderer.ts`，显示当前阶段与耗时，并提供
  「打开日志」「重试」「退出」三个动作；失败时显示**具体阶段 + 原因**。
- **主进程调试**：`--inspect` 仅限 dev（生产构建必须移除；Fuses 已关 `EnableNodeCliInspectArguments`）。
- **数据落点**：默认 `PI_CODING_AGENT_DIR = ~/.pi/agent`（与 CLI 共享凭据/会话/扩展/MCP）；
  设置里可切到 `<userData>/pi-agent`（`<userData>/pi-desktop-settings.json` 的 `agentDirMode`，
  **切换后必须重启应用**）。⚠️ 不要与 `pi` CLI 对同一会话并发写入（上游明确不支持）。

### 门禁与探针

```bash
npm run typecheck                # strict TS（tsc --noEmit）
node scripts/smoke-desktop.mjs   # 服务端四项断言：SPA / 带凭据 API / SSE / pi SDK 建会话

# 打包态端到端（需先启动打包产物，再对**运行中的实例**断言；不启动/不终止任何进程）
"out/Pi Desktop-win32-x64/pi-desktop.exe" --remote-debugging-port=9333
node scripts/probe-renderer.mjs --debug-port 9333 --cwd <可写目录>   # R1–R7
```

`typecheck` 与 `smoke` 两条必须全绿才允许打包与发布；CI（`.github/workflows/ci.yml`）以同样两条为准
（顺序为 `prepare-next → collect-pi → smoke → make`）。

## 目录结构

本工程与同级工程**并行存放**（`pi-workspace` 是 submodule 容器仓库，构建脚本用 `../兄弟目录` 解析）：

```
pi-workspace/
├── pi/                          # [submodule] 上游宿主 + SDK，固定 Branch_v1.1.0
├── pi-web/                      # [submodule] 上游 UI + 服务端，固定 Branch_v0.11.1
├── assets/                      # 品牌物料（父工程；本工程经 ../assets 消费）
├── pi-desktop/                  # [submodule] ← 本工程（Electron 桌面壳）
│      ├─ ../pi      （宿主 + SDK）  ← 构建期：npm install（产出 @earendil-works/* 依赖树）
│      └─ ../pi-web  （UI + 服务端） ← 构建期：npm ci + next build → 组装 pi-dist
├── pi-desktop-hos/              # [submodule] 鸿蒙版（独立工程；本工程只复用结论与 2 个可移植模块）
├── pi-desktop-website/          # [submodule] 官网/下载页（更新检查的候选数据源）
├── harmonypc-electron/          # [submodule] Electron-on-鸿蒙 运行时（本工程不使用）
└── harmonypc-electron-versions/ # （普通目录）鸿蒙运行时归档与 Node 头文件指导（本工程不使用）
```

本工程内部：

```
pi-desktop/
├── src/main/                       # Electron 主进程（装配代码，无业务逻辑）
│   ├── index.ts                    # 入口编排：单实例锁 → 安全准备 → whenReady → 起宿主 → 建窗 → 托盘/通知 → 退出
│   ├── host.ts                     # 进程内 Next 宿主：环境装配、密钥轮换、chdir 到产物根、startServer、就绪轮询、鉴权注入、关闭
│   ├── artifact.ts                 # pi-dist 解压 + SHA-256 marker 幂等 + PI_DESKTOP_PI_DIST 出口
│   ├── tar-extract.ts              # 流式 ustar(.gz) 解压器（移植自 pi-desktop-hos）
│   ├── windows.ts                  # BrowserWindow + loading 页 + 加载策略 + 导航加固 + 权限白名单 + 窗口图标
│   ├── window-state.ts             # window-state.json 持久化（防抖 / 边界校验）
│   ├── tray.ts                     # 托盘与菜单
│   ├── notifications.ts            # 会话 JSONL 尾随 → 原生通知（冷却 / 去重 / 仅后台）
│   ├── session-watch.ts            # 会话文件增量 tail（被 notifications 消费）
│   ├── lifecycle.ts                # NO_PROXY / 系统 CA / 崩溃兜底 / 优雅关闭 / 代理绕过
│   ├── settings.ts                 # 壳层设置（agentDirMode 等）读写
│   ├── update-check.ts             # 检查更新（半自动）
│   └── logger.ts                   # [pi-desktop] 统一日志 → <userData>/logs
├── src/preload/index.ts            # 默认空实现（按需启用最小桥；数据面永不过 IPC）
├── src/renderer/renderer.ts        # 壳层自有页面（loading / 降级页）驱动
├── index.html                      # 兜底 / loading 页（CSP: default-src 'self'）
├── resources/                      # icon.ico / icon.icns / icon.png / tray.png / trayTemplate.png
├── resources/brand/                # 物料镜像（入库，供 CI 在无父工程时使用）
├── config/                         # 预置模板（settings.json / mcp.json 默认值）
├── scripts/
│   ├── prepare-next.mjs            # ① ../pi-web：npm ci → 原生依赖完整性校验 → next build
│   ├── smoke-desktop.mjs           # ② 门禁：Node 24.21 起服务 + SPA/API/SSE/SDK 四项断言
│   ├── collect-pi.mjs              # ③ 组装 pi-dist → 品牌化 → 终检 → tar.gz(ustar) + SHA-256 marker
│   ├── brand-assets.mjs            # 物料校验/固化 + pi-dist 文案·Logo·图标品牌化 + 三层层断言
│   ├── probe-renderer.mjs          # 打包态渲染层/终端探针（R1–R7，连 CDP）
│   └── pin-upstream.mjs            # 记录 ../pi 与 ../pi-web 的 commit SHA（upstream.lock.json）
├── forge.config.ts                 # packagerConfig（asar / extraResource / executableName）+ makers + plugins
├── vite.{main,preload,renderer}.config.ts , tsconfig.json , forge.env.d.ts
├── .github/workflows/{ci.yml,release.yml}
├── specs/                          # NNN-name/{spec.md,plan.md[,test-cases.md]}（001…012 + 201）
├── docs/                           # 工程规划 + 桌面能力清单 + 构建验证记录 + 发布与更新
├── upstream.lock.json              # 上游 commit SHA 钉住（可复现；构建期生成）
├── README.md / README_zh.md        # 本文件（英文 / 中文）
└── logs/                           # 每轮构建与实机验证的证据（未入库）
```

### 现状

| 状态 | 内容 |
|---|---|
| ✅ 已实现 | `src/main/**`（14 个模块）、`src/preload`、`src/renderer`、6 个构建/探针脚本、`resources/`（含品牌物料镜像）、`config/`、Forge + Vite + TS 配置、`.github/workflows/{ci,release}.yml`、`specs/`（`001`–`012` 已成对，`201` 待定）、`docs/` 四份文档 |
| ✅ 已实测（Windows） | 打包态首屏、进程内宿主、品牌化（文案/Logo/图标/版本检测）、跨盘符默认布局启动、PTY、原生通知、Squirrel 安装→启动→卸载（详见 [docs/构建验证记录.md](docs/构建验证记录.md) 轮次 1 / 轮次 2） |
| ⬜ 未实测 | macOS / Linux 全链路；`make` 的 dmg/deb/rpm 安装体验；P0-4 的「解压期内存曲线」；MCP / `git` / 搜索类工具的逐项实测；托盘与通知的**视觉**呈现（可编程判据之外） |
| ⬜ 待落地（后续） | `extensions/`、`skills/`（壳专用扩展与技能，可选档）；`specs/003`–`011` 已生成规格但未做端到端取证的部分；`patches/` 目录（规划 §7 要求建立并写明「本版本为空」，目前仓库无该目录）；预置模板 `config/trust.json`（规划 §6.2 列出，当前只有 `settings.json` / `mcp.json`） |
| ❌ 明确不做 | 深链 / 开机自启 / 全局快捷键 / 多窗口；代码签名 / 公证 / 静默更新；交叉打包 |

注：本表是「README 快照」；文件是否齐备以仓库现状为准（`git status` / `ls`），
结论是否成立一律以 [docs/构建验证记录.md](docs/构建验证记录.md) 的轮次记录与
[docs/桌面能力清单.md](docs/桌面能力清单.md) 的能力矩阵为准。

## 相关文档

| 文档 | 内容 |
|---|---|
| [docs/工程规划.md](docs/工程规划.md) | **工程规划**：架构、结构、流水线、能力与降级、分阶段计划、风险（source of truth） |
| [docs/桌面能力清单.md](docs/桌面能力清单.md) | 三平台 × 能力矩阵、降级矩阵、证据标注、与鸿蒙版的能力差异 |
| [docs/构建验证记录.md](docs/构建验证记录.md) | 每轮构建/实机验证的台账 + Phase 0 探针（P0-0…P0-6）实测判定与证据路径 |
| [docs/发布与更新.md](docs/发布与更新.md) | 版本策略、CI/Release 工作流、三平台产物、未签名安装指引、卸载残留、更新行为与升级语义 |
| [specs/](specs/) | 模块规格（`NNN-name/{spec.md,plan.md}`）与项目级文档（`README` / `constitution` / `ARCHITECTURE` / `TECH` / `STRUCTURE` / `overall-{spec,plan}`） |

## 上游声明与许可

- **本工程非官方**：由第三方（`fellow99`）独立实现，与 Pi / Pi Web 上游作者无隶属关系，未获其背书。
- **不 fork、只装配**：本版必需补丁 **0 条**（逐条理由见规划 §7）；对上游只做幂等处理，从不覆盖用户改动。
- **上游许可**：[Pi](https://github.com/earendil-works/pi) MIT · [Pi Web](https://github.com/agegr/pi-web) MIT。
  随包分发的 `pi-dist.tar.gz` 内含上游产物，其许可与版权归上游所有；本工程代码为 MIT（见 [LICENSE](LICENSE)）。
- **名称声明**：本工程名称含 `pi`，仅为说明被封装的上游项目；应用内「关于」页同样标注以上声明。
