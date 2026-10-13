# TECH.md — 技术选型

> pi-desktop 技术选型记录（2026-10-12）。版本以**本工程 `package.json`** 为准（✅ 已核实）；
> 上游版本以 `../pi/package.json`、`../pi-web/package.json` 为准（✅ 已核实）。
> 选型结论的来源是 [`../docs/工程规划.md`](../docs/工程规划.md) §4.4、§8.2、§11。

---

## 1. 技术栈版本表

| 类别 | 技术 | 版本 | 用途 |
|---|---|---|---|
| 桌面运行时 | **Electron** | **`43.7.9`（精确钉住，不用 `^`）** | 桌面壳：主进程（Node 24.21.0）+ 渲染进程（Chromium 150） |
| 运行时组成 | Node / Chromium / ABI | **24.21.0 / 150.0.7871.250 / 148** | ✅ 官方发布矩阵（工程规划 §4.4、Q4）。⬜ 本机未复测，Phase 0 P0-0 出口复核 |
| 构建/打包 | **Electron Forge** | `^7.11.2` | 脚手架与 `start` / `package` / `make` / `publish` 生命周期 |
| 构建插件 | `@electron-forge/plugin-vite` | `^7.11.2` | 用 Vite 编译 main / preload / renderer 三段 |
| 构建插件 | `@electron-forge/plugin-fuses` | `^7.11.2` | 打包期固化 Fuses（六项，见 [constitution.md](./constitution.md) §2.2） |
| 安全加固 | `@electron/fuses` | `^1.8.0` | `FuseV1Options` 定义 |
| 打包器 | `@electron-forge/maker-squirrel` | `^7.11.2` | Windows 安装器（`.exe` + `.nupkg`） |
| 打包器 | `@electron-forge/maker-zip` | `^7.11.2` | 免安装目录包（darwin / linux / win32） |
| 打包器 | `@electron-forge/maker-dmg` | `^7.11.2` | macOS 镜像 |
| 打包器 | `@electron-forge/maker-deb` / `maker-rpm` | `^7.11.2` | Linux 包（deb 需 `fakeroot`+`dpkg`，rpm 需 `rpm-build`） |
| 前端/TS 构建 | Vite | `^7.3.6` | 编译 TypeScript（main / preload / renderer） |
| 语言 | TypeScript | `^5.6.0` | 类型安全（`strict`，见 [constitution.md](./constitution.md) §4.1） |
| 类型定义 | `@types/node` | `^24.3.0` | 与运行时 Node 24 对齐 |
| Windows 依赖 | `electron-squirrel-startup` | `^1.0.1` | Squirrel 安装/卸载短生命周期处理（**唯一运行期依赖**） |
| CI Node（规划） | Node.js | **24.21.0**（与运行时同版） | `smoke-desktop` 门禁必须用同版 Node 才有意义（工程规划 §8.5）。`ci.yml` / `release.yml` 已就位（⬜ 未在 CI 上执行过） |
| 包管理器 | npm | 随 CI 镜像 | 本工程 `npm ci` / `npm run make`；`../pi`（monorepo）由 `../pi-web` 的依赖链消费 |

---

## 2. 选型理由

### 2.1 Electron 43.7.9（而非 37 / 39 / 40 / 44）

| 候选 | 组成 | 判断 |
|---|---|---|
| 37.2.3 | Node 22.17.0 / Chromium 138 / ABI 136 | ❌ 与 `pi-desktop-hos` 同族，但 Node 22.17 **低于上游 `>=22.19.0`**（HOS 为此专门做了门禁论证） |
| 39.0.0 | Node 22.20.0 / Chromium 142 / ABI 140 | 🔶 备选：贴合上游 engines，但 Chromium 落后两个大版、与 `dsh-desktop` 不同族 |
| 40.0.0 | Node 24.11.1 / Chromium 144 / ABI 143 | 🔶 备选 |
| **43.7.9** | **Node 24.21.0 / Chromium 150.0.7871.250 / ABI 148** | ✅ **选定** |
| 44.7.0 | Node 24.21.0 / Chromium 152 / ABI 149 | 🔶 触发式升级目标（Phase 2 评估；需重验 Forge/Maker 与原生模块） |

**选定理由**（工程规划 Q4、§4.4）：

1. **天然满足上游引擎要求**：Node 24.21.0 ≥ `>=22.19.0`（✅ `pi/package.json`、`pi-web/package.json` 均声明此门禁），
   且覆盖 `node:sqlite`（`pi/durable` 使用）与 Next 16 的运行时要求 —— **不需要** HOS 那套「Node 版本错位」论证。
2. **与 `dsh-desktop` 同主版本（Electron 43）**：Forge / Vite / Fuses 配置形态可照搬，降低脚手架风险。
3. **含安全补丁**：Chromium 150 相对 138/142/144 领先三个大版。
4. **精确钉版本**：`package.json` 写死 `43.7.9`（不用 `^`），升级走独立需求（tag 化），CI 与文档同步记录版本。

### 2.2 构建工具：Electron Forge + plugin-vite（而非 electron-vite + electron-builder）

- 与方案模板 `dsh-desktop` 完全同型（工程规划 §6.3「保留」行）：`forge.config.ts`、`vite.*.config.ts`、
  Fuses 组合、CI/Release 形态都可直接复用形态、替换内容。
- Forge `plugin-vite` 的 `build[]` 入口数组天然匹配本工程 `src/main` / `src/preload` / `src/renderer` 布局
  （✅ 已核实 `forge.config.ts` 的 `build[]` + `renderer: [{ name: 'main_window' }]`）。
- `prepackage` / `premake` 钩子让「一条命令从零产出安装包」成立（工程规划 §8.1 ④、§8.4）。
- 已知代价：`plugin-vite` 在 Forge 官方标注 experimental，但对本工程（主进程为主、渲染层极薄）足够（🔶 沿用 `dsh-desktop` 的同款取舍）。

### 2.3 Fuses 六项（打包期固化）

见 [constitution.md](./constitution.md) §2.2（✅ 已核实 `forge.config.ts`）。要点：
`RunAsNode: false` 关闭「Electron 当 Node 用」；`EnableNodeOptionsEnvironmentVariable` / `EnableNodeCliInspectArguments`
关闭调试入口（配合 §11.4 S1「生产不带 `--inspect`」）；`OnlyLoadAppFromAsar` + 完整性校验防篡改。

### 2.4 壳体为什么不引入任何上游 npm 依赖

`vite.main.config.ts` 的 `external` 只有 `electron` / `electron-squirrel-startup` / `node:*`（✅ 已核实）——
`next`、`@earendil-works/*`、`node-pty` **不参与壳体构建**，它们由 `<userData>/pi-dist` 在运行时提供。
理由：① `pi-dist` 必须按目标平台裁剪（§8.2）；② 预览密钥要在解压后轮换（Q3）；③ 壳体依赖面越小，
Fuses/asar 下的攻击面越小。

### 2.5 宿主消费方式：sibling 源码引用（而非 npm 依赖）

`../pi`（tag v1.1.0）与 `../pi-web`（tag v0.11.1）为**同级目录源码引用**（工程规划 §2.5、§6.1）：

1. `pi-web` 的 `.next` 必须**本机可再生**地构建（我们要控制 `serverExternalPackages`、按平台裁剪原生件、
   并在打包前完成预览密钥轮换）；
2. 上游 npm tarball 里的预构建 `.next` 来自 Windows/macOS 构建机，**无法做目标平台裁剪**（🔶 沿用 HOS 结论）；
3. `pi-web` 依赖 `pi` 的**精确版本 1.1.0**（✅ `pi-web/package.json`），sibling 引用保证两边同源同版本。

CI 只 checkout 本仓库 → 流水线第一步用 `git clone --branch <固定分支> --depth 1` 把 `pi`、`pi-web`
克隆到平级目录，并记录 commit SHA 到 `upstream.lock.json`（工程规划 §6.1、§8.5）。

---

## 3. 上游依赖表

### 3.1 直接封装的上游

| 上游 | 版本/基线 | 形态 | 本工程如何消费 |
|---|---|---|---|
| `pi`（`earendil-works/pi`，MIT） | tag **v1.1.0**（`Branch_v1.1.0`）；monorepo 全部包 lockstep **1.1.0**；`engines.node >= 22.19.0` ✅ | CLI + 进程内 TypeScript SDK | **不直接调用 CLI**：`pi-web` 通过 SDK 在使用者进程内加载 agent（`createAgentSession*` / `SessionManager`） |
| `pi-web`（`agegr/pi-web`，MIT） | tag **v0.11.1**（`Branch_v0.11.1`）；`engines.node >= 22.19.0` ✅ | Next.js App Router 应用（SPA + `/api/*` + SSE），bin `pi-web` | **以进程内 Next 服务器形态承载**（不经 `bin/pi-web.js`）；其 `.next` 产物 + 运行依赖被组装进 `pi-dist.tar.gz` |

### 3.2 `pi-web` 的关键运行依赖（随 `pi-dist` 分发）

| 包 | 版本 | 角色 | 本工程处置 |
|---|---|---|---|
| `next` | **16.3.8** | 框架 | 进程内启动用其**内部入口** `next/dist/server/lib/start-server.js` 的 `startServer` 导出（✅ 已核实该导出存在）→ ⚠️ 风险 R1 |
| `@earendil-works/pi-coding-agent` | **1.1.0**（精确） | agent SDK（`pi` 的 coding-agent 包） | 进程内加载；`next.config.ts` 的 `serverExternalPackages` 列出 → 不打包进 `.next` |
| `@earendil-works/pi-agent-core` | **1.1.0**（精确） | agent 运行时 | 同上 |
| `@earendil-works/pi-ai` | **1.1.0**（精确） | 多 provider LLM API | 同上 |
| `@earendil-works/pi-tui` | **1.1.0**（精确） | 终端 UI 库（自带 N-API 原生件） | 同上；原生剪贴板/修饰键件自带 prebuilds（✅ darwin/linux/win32 × x64/arm64），加载失败在上游即优雅降级 |
| `node-pty` | **1.2.0-beta.15** | 终端 PTY（唯一原生依赖） | ⬜ 探针 **P0-3**：确认其 prebuilds 是否 N-API（若是则 Electron 下直接可用）；否则 `@electron/rebuild` 按 ABI 148 重编；再否则**裁剪 + 终端面板降级**（fail-visible）。构建期按目标平台只保留对应 prebuilds（✅ 现有 6 个平台目录） |
| `react` / `react-dom` | `^19.2.4` | UI 运行时 | 随 `.next` 产物，无需单独处理 |
| `undici` / `web-push` | `8.11.0` / `^3.6.7` | HTTP 客户端 / Web Push | `serverExternalPackages`（纯 JS），保留 |
| `@xterm/xterm` / `@xterm/addon-fit` | `6.0.0` / `0.11.0` | 终端前端 | 随产物 |
| `proper-lockfile` / `js-yaml` / `semver` | `4.1.2` / `^5.2.3` / `7.8.5` | 会话锁 / 配置解析 / 版本比较 | 保留 |

**不需要的原生件**：`better-sqlite3` **不存在**（`pi-web` 会话是 JSONL；`pi/durable` 用的 `node:sqlite` 在 Node 24 内置），
因此 `npm ci` 不需要额外编译链（工程规划 §8.2）。

### 3.3 上游可复用脚本与扩展点（✅ 已核实）

| 上游资源 | 本工程用法 |
|---|---|
| `pi-web/bin/rotate-preview-secrets.js` | 起服务**之前** `require` 并调用（**不重新实现**）：重写 `.next/prerender-manifest.json` 的三个 preview 密钥 |
| `pi-web/bin/pi-web-options.js` | 默认值参照：端口 `30141`、主机 `127.0.0.1`（本工程改用随机端口 + 固定 `127.0.0.1`） |
| `pi-web/proxy.ts` + `lib/web-auth.ts` + `lib/request-security.ts` | 认证与门禁的**既有围栏**：matcher `["/", "/login", "/api/:path*"]`；`pi_web_session` cookie（30 天）；Basic 用户名固定 `pi`；Host 白名单放行 IP 字面量；`/api/web-auth` 免认证（用作探活） |
| `pi-web/instrumentation-node.ts` | 关闭语义参照：`SIGINT`/`SIGTERM` 下先关 SSE，否则 Next 16 的 `server.close()` 永不退出 |
| 浏览器事件 `pi-web:session-row-contextmenu` | 会话行右键菜单原生接管的候选入口（Phase 2；v1 不启用） |
| 保活注册表 `Symbol.for("@agegr/pi-web/session-liveness/v1")` | 会话运行态判定的候选来源（⬜ 工程规划 §11.2 O8） |

---

## 4. 已知兼容风险

| # | 风险 | 判定状态 | 处置 |
|---|---|---|---|
| **1** | **进程内 Next 使用上游内部入口** `next/dist/server/lib/start-server.js`：上游升级可能改变导出形态或行为 | ⬜ **探针 P0-1**（Electron 主进程内 `startServer({dir,hostname:'127.0.0.1',port})` → ① 监听成功 ② `GET /` 返回 SPA ③ 带凭据 `/api/*` 200 ④ **主进程不退出** ⑤ 预览密钥已轮换）。导出存在性 ✅ 已核实；「宿主不退出」🔶 沿用 HOS 实测、本工程未复现 | ① 基线固定 tag（v0.11.1）；② 启动期导出探测 + 明确报错（fail-visible）；③ 回退候选 B（sidecar `spawn` + `ELECTRON_RUN_AS_NODE=1`，代价见 §4.2）；④ 升级清单加入「内部入口复核」（R1） |
| **2** | **`node-pty` 1.2.0-beta.15 在 Electron ABI 148 下能否加载** | ⬜ **探针 P0-3**：判定 prebuilds 是否 N-API；结论出来前**终端面板可用性未知** | 可用则保留；不可用先 `@electron/rebuild`（按 ABI 148）；仍不可用则**裁剪 + 明示降级**（终端非核心链路，R2） |
| **3** | 主进程内跑 Next 使**主进程变重**（内存、事件循环、GC 与窗口管理相互影响） | ⬜ 待实测（首启与交互延迟；工程规划 §11.2 O4） | 必要时调低 `PI_WEB_IDLE_TIMEOUT_MS`（默认 600000）；极端情况切 sidecar（R3） |
| **4** | **SSE 长期连接 + 主进程退出**：`server.close()` 可能挂住 | ✅ 机制已核实（`instrumentation-node.ts` 的注释与 `shutdownStreams`）；⬜ 本工程退出链待实测 | 退出链按时序（关 SSE → `close()` → deadline 强退），deadline `PI_WEB_SHUTDOWN_DEADLINE_MS` = 5000 ms（R8） |
| **5** | **会话 HTML 导出会 spawn `pi` CLI**：Electron 下 `process.execPath` 是 Electron 本体，行为与 Node CLI 不同 | ⬜ Phase 0 实测该 API（O3） | 按上游 API 参数/环境变量规避（**不改上游**）；必要时登记候选补丁（R6） |
| **6** | **`pi-web` 与 `pi` CLI 并发写同一会话 JSONL 不受支持**（上游 e2e 已注明） | ⬜ 文档与 UI 提示待落地 | 默认共享 `~/.pi/agent` 下明示「不要与 CLI 对同一会话并发写入」；提供「切到应用私有目录」一键退路（R7） |
| **7** | **未签名安装包的用户体验**（Windows SmartScreen / macOS Gatekeeper） | ⬜ 是否签名/公证待人工确认（§11.3） | 文档明示右键打开 / `xattr -dr com.apple.quarantine`；Phase 3 决策（R4） |
| **8** | **首启解压耗时**（27k+ 文件量级）与中途失败 | ⬜ 待实测（🔶 HOS 同源参考：115.9 MB / 约 15 s 含就绪） | marker 幂等 + 断点可重入（重新解压覆盖）；loading 页显示阶段与文件数；失败可见 + 「打开日志」（R5） |
| **9** | **更新检查数据源未定**（GitHub API 未认证限流 vs 官网静态 feed） | ⬜ 待人工确认（§11.3 第 2 条） | 超时/失败静默降级（不阻塞、不误报）；`DEFAULT_UPDATE_FEED` 可被 env 覆盖（R9） |
| **10** | **上游漂移**：`pi-web` 升级后 `bin/` 结构、认证算法、`request-security` 规则可能变化 | ⬜ 每次升级逐条复核 | 基线 tag + 分支；本工程所有「上游机制」结论**带文件路径**；升级时按清单复核（R10） |
| **11** | **跨平台 CI 一致性与时长**（三 OS × 完整构建） | ⬜ `ci.yml` 已就位（未在 CI 上跑过） | `concurrency` 取消在途；缓存 npm；三平台各建各的产物；`fail-fast: false`（R11） |
| **12** | **安装包体积**（Electron ≈250 MB 解压 + `pi-dist.tar.gz` ≈116 MB + 壳层数 MB） | ⬜ 实测后定基线（O4） | 按目标平台裁剪原生件；剔除 `.next/cache`、devDependencies、非目标平台 prebuilds（R12） |

> 未在此表内的开放问题（通知事件源延迟、OAuth 回环逐 provider、托盘图标平台规范等）见工程规划 §11.2。

---

## 5. 运行环境与门禁

- **平台**：Windows（主验证）+ macOS（CI 出包）+ Linux（CI 出包）—— Q1。
- **运行时 Node**：Electron 43.7.9 内置 **24.21.0**；本工程**不使用**系统 Node 作为运行时（与 `pi-desktop-hos`
  的「宿主用 Node 22.17」形成对照）。
- **开发/门禁 Node**：本地与 CI 使用 **24.21.0**（与运行时同版），否则 `smoke-desktop` 的结论没有意义（工程规划 §8.5）。
- **质量门**：`npm run typecheck`（strict TS）+ `node scripts/smoke-desktop.mjs`（四项断言）——**两者全绿才允许打包**
  （[constitution.md](./constitution.md) §6.2）。✅ 类型门已通过（`npx tsc --noEmit` 退出码 0，2026-10-12）；⬜ 冒烟脚本已就位但未执行（需 `pi-dist` 产物）。
- **调试开关**：`PI_DESKTOP_DEV_SERVER=http://127.0.0.1:30141` 可跳过解压与内嵌服务器，直接加载
  `../pi-web` 的 `npm run dev`（工程规划 §8.4）；`--inspect` 仅 dev（§11.4 S1）。
