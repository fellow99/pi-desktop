# constitution.md — 项目宪法

> pi-desktop 项目宪法（从 [`../docs/工程规划.md`](../docs/工程规划.md) 的决策 Q1–Q7、§3 原则、§4 架构、§4.5 安全、
> §5.6 IPC、§11.4 安全自查中提取，2026-10-12）。
> 本文件是**描述性**的：记录本工程必须遵循的原则，任何模块 `plan.md` 都必须对照本文件做「宪法合规检查」。
> 与源码冲突时以源码为准，并回改本文件（§4.4）。

---

## 1. 架构宪法

1. **零上游改动**：不 fork `pi` / `pi-web`，不新写数据载体。先穷尽上游现成机制（环境变量、SDK、既有脚本），
   再考虑补丁；本版补丁集为 **0 条必需**（工程规划 §7，逐条登记了「为什么不需要」）。
   `patches/<pi-web-tag>/` 目录仍然建立并写明「本版本为空」。
2. **主进程进程内宿主**：`pi-web` 的 Next 服务器（含 agent）跑在 Electron 主进程内（Node 24.21.0），
   **不引入子进程** —— 无孤儿进程、无进程树清理、就绪判定确定（工程规划 Q2、§4.2）。
   入口是 `next/dist/server/lib/start-server.js` 的 `startServer({dir, hostname, port})`
   （✅ 已核实：该导出存在于 `pi-web/node_modules/next/dist/server/lib/start-server.js`，上游内部入口，
   故列为风险 R1）。候选回退 B（子进程 sidecar）**只登记不默认启用**，触发条件见工程规划 §4.2。
3. **只写装配代码**：业务逻辑全在上游。本工程只写：环境装配、产物就位、起服务、建窗、生命周期、
   桌面能力、构建脚本（工程规划 §3 原则 3、§6.2）。
4. **同源数据面**：渲染进程**只认 HTTP**，`BrowserWindow` 同源加载 `http://127.0.0.1:<随机端口>/`
   —— 零 CORS、零自定义协议。`file://` 静态导出与 `app://` 自定义协议均已评估并否决（工程规划 §4.3）。
5. **失败可见（fail-visible）**：每个启动阶段（lock → env → artifact → secret → server → ready → load）
   必须可观测；不允许「卡住但不说」，不允许静默降级（工程规划 §4.7）。
6. **平台差异显式化**：Windows / macOS / Linux 的差异必须同时出现在文档台账与代码注释里
   （工程规划 §9.3）。

---

## 2. 安全宪法

1. **渲染进程隔离基线**：`sandbox: true` + `contextIsolation: true` + **无 `nodeIntegration`**
   （工程规划 §4.5；🔶 沿用 `dsh-desktop` 范式）。
2. **Fuses（打包期固化，六项）**：`RunAsNode: false`、`EnableCookieEncryption: true`、
   `EnableNodeOptionsEnvironmentVariable: false`、`EnableNodeCliInspectArguments: false`、
   `EnableEmbeddedAsarIntegrityValidation: true`、`OnlyLoadAppFromAsar: true`
   （✅ 已核实本工程 `forge.config.ts` 的 `FusesPlugin` 块与之一致）。
3. **导航加固**：`setWindowOpenHandler` **一律 deny**（http/https 交 `shell.openExternal`）；
   `will-navigate` 仅允许同源（应用自身 `http://127.0.0.1:<port>/`）与明确外链白名单；
   应用内不内嵌任意网页（工程规划 §4.5、§5.5、§11.4 S6）。
   > Pi Web UI 本身用 `window.open` 打开 OAuth 登录页与会话导出，因此这条不是「可选加固」而是**必需项**。
4. **权限白名单**：仅 `notifications`（`clipboard-sanitized-write` 如需），且必须校验来源 URL
   与 `webContents.id`（工程规划 §4.5；`setPermissionRequestHandler` 单点收口）。
5. **本地暴露面最小化**：绑定 **`127.0.0.1`** + **随机高位端口** + **随机强密码
   `PI_WEB_PASSWORD`**（宿主启动前生成、不入日志、不回显）。理由是服务端具备**文件读写 + 命令执行**
   能力（终端 / 工具调用），同一台机器上的其他本地进程仍可能访问 loopback 端口，因此不靠「只绑 loopback」兜底
   （工程规划 §4.5、§11.4 S3）。
6. **凭据注入两件，缺一不可**：① 出栈到本服务 host:port 的请求补 `Authorization: Basic pi:<password>`
   （覆盖 `/api/*` 与 SSE）；② 用同一密码按上游算法派生会话 token 并 `session.cookies.set(...)`
   承载**页面导航**。只注入 Basic 会把用户送到 `/login`（✅ 已核实上游源码 + 🔶 `pi-desktop-hos` 已验证；
   工程规划 §4.5、§4.10）。
7. **生产构建不带调试入口**：生产包**不得**带 `--inspect` / `remote-debugging-port`；DevTools 与
   `openDevTools()` 仅 dev 开启（工程规划 §8.4、§11.4 S1/S4；Fuses 已关 `EnableNodeCliInspectArguments`）。
8. **密码与密钥不入日志**：日志中不得出现 `PI_WEB_PASSWORD` 明文（只打印长度）（工程规划 §11.4 S2）。
9. **预览密钥必须轮换**：启动前复用上游 `bin/rotate-preview-secrets.js` 重写
   `<pi-dist>/.next/prerender-manifest.json` 的三个 preview 密钥；这也是产物必须解压到**可写目录**
   （`<userData>/pi-dist`）的原因（工程规划 §2.2、§4.2；默认 5000 ms 退出上限）。

---

## 3. IPC 宪法（薄 IPC）

1. **数据面不过 IPC**：对话、会话、文件、终端、工具调用等业务数据全部走同源 HTTP + SSE
   （`fetch('/api/*')` + `EventSource('/api/agent/[id]/events')`）。**不存在**任何自定义 IPC 数据载体（工程规划 §4.8）。
2. **preload 仅壳层动作**：`src/preload/index.ts` 默认是**空实现**（`export {}`），只为维持 Forge/Vite 的
   preload 构建目标；按需启用时也只承载壳层动作（例如 `piDesktop.notify()`、`piDesktop.showContextMenu(rowInfo)`），
   触发条件登记在工程规划 §5.6。
3. **preload 只对壳层自有文档暴露**：桥只注入壳层页面（`file://` 协议下的 loading / 降级页）；
   同源加载的 Pi Web UI **不注入任何桥**。✅ 已核实实现：`src/preload/index.ts` 的 `isLocalDocument()`
   守卫（`window.location.protocol === 'file:'`），非 `file:` 时 `contextBridge.exposeInMainWorld` 完全不执行。
   > 验收方式：在 Pi Web UI 页面上下文断言 `typeof window.piDesktop === 'undefined'`。
   > ⬜ 待验证：该断言尚未在真实运行中执行（Phase 1 验收项）。
4. **最小暴露**：不向渲染进程暴露 Node 能力；`contextBridge` 只暴露白名单函数（无 `require`、无 `ipcRenderer` 直通）。

---

## 4. 代码质量宪法

1. **TypeScript strict**：`strict: true` 且开启 `noImplicitOverride` / `noUnusedLocals` / `noUnusedParameters` /
   `noFallthroughCasesInSwitch`（✅ 已核实本工程 `tsconfig.json`）。严禁 `as any`、`@ts-ignore`、`@ts-expect-error`
   压制类型错误。
2. **严禁空 catch**：错误处理必须显式（记录日志或显式抛出）。本工程的统一出口是
   `describeError(err)` + `logWarn/logError`（✅ 已核实 `src/main/logger.ts`）。
3. **最小改动**：修 Bug 只做最小改动，严禁顺便重构。**这是本工程的第一条纪律**，因为几乎所有「上游机制」结论
   都带文件路径，任何顺手改动都会让文档与源码脱钩（工程规划 §12.1 硬规则 8）。
4. **源码即真理**：每条声明可追溯到源文件 + 行号；代码与文档冲突时**以代码为准**并标注变更提示。
   本工程全部「上游机制」结论必须带路径（工程规划 §11.1 R10）。
5. **不写占位**：未定事项写 `⬜` + 验证方式 + 决策时限，不留空标题、不写 TBD（`specs/README.md` §五 硬规则 3）。
6. **本工程专属约束**：主进程代码**不得** `import` 上游包（`next` / `@earendil-works/*` / `node-pty`）——
   它们由 `<userData>/pi-dist` 在运行时提供，不在壳层构建图里（✅ 已核实 `vite.main.config.ts` 的 `external` 与注释）。

---

## 5. 生命周期宪法

1. **关窗即退出**：主窗口关闭 → `window-all-closed` → `app.quit()`（v1 口径，对齐 `dsh-desktop`）；
   若存在运行中的 agent 会话，关窗前给一次确认提示（⬜ 会话运行态判定来源见工程规划 §5.4 与 `specs/004-notification`）。
   托盘「退出」是等效退出通道。
2. **优雅关闭链 + deadline 强退**：退出时按序执行
   「置 `isQuitting` → 关闭 SSE（或调用等价钩子）→ `httpServer.close()` → 超时 `app.exit()` 强退」，
   deadline = `PI_WEB_SHUTDOWN_DEADLINE_MS`（默认 **5000 ms**）。
   依据：Next 16 在 `SIGINT`/`SIGTERM` 下会让 `server.close()` 等待所有连接自然结束、**SSE 不结束则永不退出**
   （✅ 已核实 `pi-web/instrumentation-node.ts` 的注释与 `shutdownStreams` 注册；🔶 `pi-desktop-hos` 实测结论）。
3. **单实例**：`app.requestSingleInstanceLock()` **在最早时机**申请；失败即 `app.quit()`；成功则 `second-instance`
   → 主窗口 `restore() → show() → focus()`（工程规划 §5.1）。
4. **崩溃兜底**：主进程 `uncaughtException` / `unhandledRejection` 必须记录（`<userData>/logs/`），
   不静默崩溃；已知代价：宿主在主进程 = 应用级崩溃面（工程规划 §4.7；🔶 沿用 `dsh-desktop` 的同一取舍）。
5. **崩溃与加载失败可见**：`did-fail-load` / `render-process-gone` 记录并提示
   （工程规划 §4.3、§5.2）。

---

## 6. 构建与治理宪法

1. **上游基线 tag 固定**：`pi` = tag **v1.1.0**（`Branch_v1.1.0`）、`pi-web` = tag **v0.11.1**
   （`Branch_v0.11.1`）；CI 用 `git clone --branch <固定分支> --depth 1` 克隆到与本工程**平级**的 `../pi`、`../pi-web`，
   并用 `scripts/pin-upstream.mjs` 把解析到的 commit SHA 写入 `upstream.lock.json` 以保证可复现
   （工程规划 §6.1、§8.5）。
2. **门禁全绿才允许打包**：`npm run typecheck`（strict TS）+ `node scripts/smoke-desktop.mjs`
   （四项断言：SPA / 带凭据的 `/api/*` / SSE 可建连 / pi SDK 可创建 `AgentSession`）**失败即阻断流水线**；
   `prepackage`/`premake` 钩子自动串起 `prepare-next → collect-pi`，保证 `npm run make` 一条命令可复现
   （工程规划 §8.1、§8.4）。
3. **Conventional Commits**：提交注释使用 type 前缀（feat / fix / docs / style / refactor / perf / test / build /
   ci / chore / revert），严禁其它前缀。
4. **规范驱动**：开发遵循 specs-based 流程（规格 → 开发 → 审查 → 测试 → 修复 → 回归）；模块 `spec.md` 与
   `plan.md` **必须成对**，`plan.md` 必须回引 FR 编号（`specs/README.md` §五）。
5. **`specs/` 与 `docs/` 分工固定**（工程规划 §0.1、§12.2）：
   | 文档 | 回答 |
   |---|---|
   | `docs/工程规划.md` | 做什么、怎么做、按什么顺序做、有哪些风险（**唯一权威的规划文档**） |
   | `specs/NNN-name/{spec,plan}.md` | 单个模块/子系统的**可验收规格**（需求 + 设计） |
   | `specs/` 项目级文档 | 工程规划的**收敛版**（只压缩结论 + 回引 § 号，不复制论证） |
   | `docs/桌面能力清单.md` | 三平台能力边界与降级矩阵（Phase 0 后产出） |
   | `docs/构建验证记录.md` | 每轮构建/实机验证的环境、步骤、结论（含探针出口判据） |
   | `README.md` | 构建、运行、调试的**操作说明** |
6. **证据纪律**：`✅ 已核实` / `🔶 沿用` / `⬜ 待验证` / `⚠️ 风险` 四种标记必须带出处；
   `🔶 沿用` 不得在对外说明中当作本工程实测事实（工程规划 §0.2）。
7. **补丁纪律（若将来产生补丁）**：① 幂等（应用前 `git apply --reverse --check`，成功即跳过）；
   ② 冲突即终止（绝不 `--3way` 强合并、绝不覆盖用户改动）；③ 新补丁不得落在既有补丁的连续上下文区间；
   ④ 正反向往返须能 SHA-256 还原（工程规划 §7）。

---

## 7. 本宪法的使用方式

- 每个模块 `plan.md` 的第 2 节是**宪法合规检查表**：逐条列出「合规 / 例外 + 理由 + 落点」。
- 例外必须显式登记（写成 `⚠️ 例外`），不得静默偏离；例外在 `SPECS_CHECKLIST.md` 中有对应条目。
- 本文件随决策演进：新增/修订原则时同步更新 [`ARCHITECTURE.md`](./ARCHITECTURE.md) §5 关键决策表。
