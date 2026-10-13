# STRUCTURE.md — 目录与文件结构

> pi-desktop 目录结构记录。**基线**：[`../docs/工程规划.md`](../docs/工程规划.md) §6.1–§6.3 的规划结构；
> **as-built 快照时间**：2026-10-12（`pi-desktop/` 工作树扫描，不含 `.git`、`node_modules`）。
> 快照之后新增/移动的文件以工作树为准（宪法「源码即真理」，见 [constitution.md](./constitution.md) §4.4）。

---

## 1. 顶层目录树（逐项注释）

```
pi-desktop/
├── package.json                # Electron Forge 工程清单：name=pi-desktop / productName=Pi Desktop / main=.vite/build/main.js
│                               #   scripts: start / package / make / publish / typecheck / smoke / prepare:next / collect:pi / pin:upstream
│                               #   prepackage + premake 钩子自动串起 prepare:next → collect:pi（一条命令可复现，§8.1）
├── package-lock.json           # npm 依赖锁（⬜ 尚未生成：本工程未跑过 npm install / npm ci）
├── forge.config.ts             # Forge 配置：packagerConfig（asar/prune:false/derefSymlinks/executableName/ignore/extraResource/appBundleId）
│                               #   + 5 makers + VitePlugin + FusesPlugin（六项 Fuse）
├── forge.env.d.ts              # Forge/Vite 注入的全局类型（MAIN_WINDOW_VITE_DEV_SERVER_URL / MAIN_WINDOW_VITE_NAME）
├── tsconfig.json               # TypeScript 配置：commonjs / strict / noUnused* / noImplicitOverride；include: src + 根配置
├── vite.main.config.ts         # 主进程构建：cjs，输出 main.js，external: electron / electron-squirrel-startup / node:*
├── vite.preload.config.ts      # preload 构建：输出 preload.js，external: electron
├── vite.renderer.config.ts     # 渲染层构建：只承载壳层兜底页（应用主界面来自内嵌服务端）
├── index.html                  # 壳层兜底/loading 页（CSP: default-src 'self'；阶段文本 + 打开日志/重试/退出三个动作）
├── .gitignore                  # 构建产物与密钥外置：/.vite /dist /out /pi-dist* /upstream.lock.json /logs /node_modules / .env*
├── .gitattributes              # 文本归档 eol 归一：*.patch 强制 LF（CRLF 会让 git apply 失败）、*.md/*.json/*.mjs/*.ts = lf
├── LICENSE                     # MIT
├── README.md                   # 构建/运行/调试操作说明；当前版本与状态（✅ 已存在）
│
├── docs/                       # 工程级文档（与 specs/ 分工见 constitution.md §6.5）
│   ├── 工程规划.md              # **唯一权威的规划文档**（Q1–Q7、§4 架构、§6 结构/模块、§9 范围、§10 阶段、§11 风险）
│   ├── 桌面能力清单.md           # 三平台能力边界与降级矩阵（Phase 0 后持续维护）
│   ├── 构建验证记录.md           # 每轮构建/实机验证的环境、步骤、结论（含探针出口判据）
│   └── 发布与更新.md             # 制包、Release、更新源与升级指导的操作手册
│
├── specs/                      # 规格文档（索引见 specs/README.md）
│   ├── README.md               # 索引：模块清单 + 编号规则 + 文档规范 + 阅读顺序
│   ├── constitution.md         # 项目宪法（架构/安全/IPC/代码质量/生命周期/构建与治理）
│   ├── ARCHITECTURE.md         # 整体架构（进程模型/分层/数据流/关键决策/差异表）
│   ├── TECH.md                 # 技术选型（版本表/选型理由/上游依赖/兼容风险）
│   ├── STRUCTURE.md            # 本文件
│   ├── overall-spec.md         # 整体规格（FR-000-*）
│   ├── overall-plan.md         # 整体技术方案
│   ├── overall-data-model.md   # 数据模型（壳层实体 + 状态机 + 数据边界）
│   ├── SPECS_CHECKLIST.md      # 规格与模块完成度检查表
│   ├── 001-host/{spec.md,plan.md}   # 001 模块规格 + 方案（✅ 成对）
│   └── 002-window/{spec.md,plan.md} # 002 模块规格 + 方案（✅ 成对）；003–011、201 的 spec/plan 待生成
│
├── src/
│   ├── main/                   # Electron 主进程（**只写装配代码**，见 constitution.md §1.3）
│   │   ├── index.ts            # 入口编排：单实例锁 → Squirrel 短生命周期 → whenReady → 建窗/加载 → 托盘/通知 → 退出
│   │   ├── host.ts             # 进程内 Next 宿主：环境装配、端口探测、预览密钥轮换、导出探测、就绪轮询、凭据注入、deadline 关闭
│   │   ├── artifact.ts         # 产物引导：pi-dist.tar.gz 定位、SHA-256 计算、marker 幂等、解压落位
│   │   ├── tar-extract.ts      # 流式 ustar(.gz) 解压器（从 pi-desktop-hos/src-main/tar-extract.js 移植，固定内存 O(n)）
│   │   ├── windows.ts          # BrowserWindow + loading 页 + 加载策略 + 导航加固 + 权限白名单 + 壳层 IPC 收口
│   │   ├── window-state.ts     # window-state.json 持久化（防抖 / getNormalBounds / 多显示器可见性校验）+ F11 全屏
│   │   ├── tray.ts             # 托盘单例与菜单（显示主窗口 / 会话目录 / 打开日志 / 检查更新 / 退出）
│   │   ├── notifications.ts    # 原生通知策略（仅后台弹、同会话冷却去重、启动历史不补弹）
│   │   ├── session-watch.ts    # 会话 JSONL 增量尾随（fs.watch + 轮询兜底 + 字节偏移游标）
│   │   ├── lifecycle.ts        # NO_PROXY 并入、系统 CA 合并、崩溃兜底、退出快照日志
│   │   ├── settings.ts         # 壳层设置（agentDirMode）+ 预置模板物化 + agent 目录树补齐
│   │   ├── update-check.ts     # 检查更新（半自动：查询 → 比较 → 打开下载页）
│   │   ├── constants.ts        # 常量接缝（应用标识、文件/环境变量名、超时、窗口尺寸；镜像上游处注明上游路径）
│   │   └── logger.ts           # 统一日志 [pi-desktop] → <userData>/logs + 阶段状态 + describeError
│   ├── preload/index.ts        # 壳层桥：**只对 file:// 文档暴露**（protocol 守卫），只暴露壳层动作（无数据面）
│   ├── renderer/renderer.ts    # 壳层兜底页脚本（阶段文本/日志/重试/退出）
│   └── types/globals.d.ts      # electron-squirrel-startup 声明（无自带类型）+ Vite 常量声明
│
├── resources/                  # 打包与应用图标（✅ 已存在：icon.ico / icon.icns / icon.png / tray.png / trayTemplate.png）
├── config/                     # 预置模板源（✅ settings.json: packages/defaultProjectTrust=ask；mcp.json: mcpServers={}）
├── patches/                    # 上游补丁目录（⬜ 待建：**本版 0 条必需**，只放 README 说明理由，工程规划 §7）
├── scripts/                    # 构建脚本（✅ 已存在 4 件；未执行过完整流水线）
│   ├── prepare-next.mjs        # ① ../pi-web：npm ci → next build → 平台裁剪 → 预览密钥轮换（裁剪做在副本上）
│   ├── smoke-desktop.mjs       # ② 门禁：Node 24.21 起服务 + SPA/API/SSE/SDK 四项断言
│   ├── collect-pi.mjs          # ③ 组装 pi-dist + tar.gz(ustar) + SHA-256 marker
│   └── pin-upstream.mjs        # 记录 ../pi 与 ../pi-web 的 commit SHA → upstream.lock.json
│
├── .github/workflows/          # ✅ 已存在：ci.yml（三 OS 矩阵 + concurrency）/ release.yml（tag v* → GitHub Release）
├── upstream.lock.json          # ⬜ 待生成（gitignore）：由 scripts/pin-upstream.mjs 写出，钉住上游 commit SHA
├── pi-dist.tar.gz              # ⬜ 构建期产物（gitignore）：pi-web 运行产物归档，随包分发
└── out/                        # ⬜ 构建期产物（gitignore）：Forge 的 make 输出
```

> **不进仓库的目录**（`.gitignore`）：`/.vite`（Vite 构建）、`/dist`、`/out`（Forge）、`/pi-dist`、`/pi-dist.tar.gz`、
> `/pi-dist.version`、`/upstream.lock.json`、`/logs`、`/node_modules`、`.env*`、`*.local.json`（密钥外置）。

---

## 2. 进程入口（Vite 三段）

| 进程 | 入口源文件 | Forge/Vite 目标 | 构建产物 | 说明 |
|---|---|---|---|---|
| 主进程 | `src/main/index.ts` | `target: 'main'`（`vite.main.config.ts`） | **`.vite/build/main.js`** | `package.json` 的 `"main"` 指向此处；主进程同时承载内嵌 Next 服务器与 agent（进程内宿主） |
| preload | `src/preload/index.ts` | `target: 'preload'`（`vite.preload.config.ts`） | **`.vite/build/preload.js`** | `output.entryFileNames = 'preload.js'`；用 `location.protocol === 'file:'` 守卫，只在壳层页面暴露桥 |
| 渲染进程 | `index.html` → `src/renderer/renderer.ts` | `renderer: [{ name: 'main_window' }]`（`vite.renderer.config.ts`） | **`.vite/renderer/main_window/`** | 只承载「启动中 / 启动失败」兜底页；**生产环境主界面由主进程 `loadURL('http://127.0.0.1:<port>/')` 提供** |

> ✅ 已核实：三段入口与产物路径来自本工程 `forge.config.ts` 的 `plugins[0].config.build[] / renderer[]`、
> `package.json` 的 `main`、以及 `vite.{main,preload}.config.ts` 的输出名设置。
> ⚠️ 注意：`index.html` 与 `src/renderer/renderer.ts` **不是**应用主界面 —— 主界面 100% 复用 Pi Web UI，
> 由内嵌服务端提供（工程规划 §4.3、§2.6）。

---

## 3. 关键配置文件

| 文件 | 作用 | 关键内容（as-built） |
|---|---|---|
| `package.json` | 工程清单与脚本 | `name: pi-desktop`、`productName: Pi Desktop`、`main: .vite/build/main.js`、`engines.node: >=22.19.0`；依赖只有 `electron-squirrel-startup ^1.0.1`（运行期）+ Forge/Vite/TS/Electron 开发依赖 |
| `forge.config.ts` | 打包与插件 | `asar:true`、`prune:false`、`derefSymlinks:true`、`icon: resources/icon`、`executableName: 'pi-desktop'`、`appBundleId: 'com.fellow99.pi.desktop'`；`extraResource: ['pi-dist.tar.gz', 'resources/icon.png', 'resources/tray.png', 'resources/trayTemplate.png']`；`ignore` 排除 `out/logs/pi-dist*/docs/specs/scripts/.vite/upstream.lock.json`；makers = squirrel + zip(darwin,linux,win32) + dmg + rpm + deb；FusesPlugin 六项（见 [constitution.md](./constitution.md) §2.2） |
| `tsconfig.json` | 类型与语言级别 | `target: ESNext`、`module: commonjs`、`moduleResolution: node`、`strict`、`noImplicitOverride`、`noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`、`sourceMap:false`、`types: ['node']`；include = `src` + `forge.env.d.ts` + `forge.config.ts` + 三个 vite 配置 |
| `vite.main.config.ts` | 主进程构建 | `lib.entry = src/main/index.ts`、`formats: ['cjs']`、`fileName: () => 'main.js'`；**external: `electron` / `electron-squirrel-startup` / `node:*`** —— 壳层**不打包** `next` / `@earendil-works/*` / `node-pty`（运行时由 `<userData>/pi-dist` 提供） |
| `vite.preload.config.ts` | preload 构建 | `external: ['electron']`、`output.entryFileNames = 'preload.js'` |
| `vite.renderer.config.ts` | 渲染层构建 | 空配置（兜底页极薄） |
| `index.html` | 壳层启动页 | CSP `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'`；`<script type="module" src="/src/renderer/renderer.ts">` |
| `config/settings.json` / `config/mcp.json` | 预置模板源 | `{ "packages": [], "defaultProjectTrust": "ask" }` / `{ "mcpServers": {} }`；运行时**只在文件不存在时写入** agent 目录（不覆盖用户改动） |
| `forge.env.d.ts` / `src/types/globals.d.ts` | 全局类型声明 | `MAIN_WINDOW_VITE_DEV_SERVER_URL` / `MAIN_WINDOW_VITE_NAME`；`electron-squirrel-startup` 模块声明 |
| `.gitattributes` | 换行归一 | `*.patch text eol=lf`（CRLF 会让 `git apply` 失败）、`*.sh`/`*.md`/`*.json`/`*.mjs`/`*.ts` = lf、`*.ps1` = crlf |
| `scripts/*.mjs`、`.github/workflows/*.yml` | 流水线与可复现性 | ✅ 已存在 4 脚本 + 2 工作流；⬜ 未执行完整流水线，`upstream.lock.json` 与 `pi-dist.tar.gz` 属构建期产物（gitignore，当前未生成） |

---

## 4. 运行期目录（`<userData>`，与仓库无关）

| 路径 | 内容 | 说明 |
|---|---|---|
| `<userData>/pi-dist/` | 内嵌宿主产物（`pi-web` 的 `.next` + 运行依赖） | 由 `pi-dist.tar.gz` 首启解压；**必须可写**（预览密钥轮换的前提） |
| `<userData>/pi-dist.sha256` | 幂等 marker（内容 = 已解压归档的 SHA-256） | 与随包的 `pi-dist.version` 比对；**不是存在性判断** |
| `<userData>/pi-desktop-settings.json` | 壳层设置（`agentDirMode`） | 切换需重启应用（§4.6） |
| `<userData>/window-state.json` | 窗口尺寸/位置/最大化 | 多显示器可见性校验，异常回退默认 |
| `<userData>/logs/pi-desktop-<YYYYMMDD>.log` | 统一日志（前缀 `[pi-desktop]`） | fail-visible 的唯一落盘出口 |
| `<userData>/pi-agent/` | agent 数据目录（仅 `agentDirMode = 'app'`） | 默认模式是共享 `~/.pi/agent`（Q6） |
| `~/.pi/agent/`（或上述私有目录） | `settings.json` / `models.json` / `auth.json` / `mcp.json` / `trust.json` / `extensions/` / `skills/` / `prompts/` / `themes/` / `sessions/` | 业务数据的**唯一**落点（✅ 上游 `pi/packages/coding-agent/src/config.ts`；工程规划 §2.1） |

> 各平台 `<userData>` 实际位置：Windows `%APPDATA%\Pi Desktop`、macOS `~/Library/Application Support/Pi Desktop`、
> Linux `~/.config/Pi Desktop`（工程规划 §9.3）。

---

## 5. 说明

1. 本文件是**结构记录**，不是设计文档：结构决策与工程映射见 [ARCHITECTURE.md](./ARCHITECTURE.md) §3，
   `dsh-desktop` ⇄ 本工程的保留/剔除/替换映射见工程规划 §6.3。
2. 模块编号与目录的对应关系见 [README.md](./README.md) §三；模块级规格目录 `specs/<NNN>-<kebab-name>/`
   **必须成对**提供 `spec.md` + `plan.md`。
3. 单文件职责与宪法约束（主进程不得 import 上游包、数据面不过 IPC）见 [constitution.md](./constitution.md) §3.4、§4.6。
