# SPECS_CHECKLIST.md — 规格与模块检查清单

> pi-desktop 规格文档与模块完成度追踪。**快照时间：2026-10-12**（对 `pi-desktop/` 工作树扫描，
> 不含 `.git`、`node_modules`）。标记：`✅` 已存在且内容完整 · `🔶` 已存在但部分/进行中 · `⬜` 未开工（写明理由与出口）。
> 依据：[`../docs/工程规划.md`](../docs/工程规划.md) §6.4（模块编号）、§10（分阶段计划）、§11（风险）、§12（文档体系）。

---

## 1. 项目级文档（`P-01 … P-09`）

| # | 文档 | 路径 | 状态 | 说明 |
|---|---|---|---|---|
| P-01 | 文档索引 | [README.md](./README.md) | ✅ | 文档总览 / 项目级文档 / 模块清单（001–011 + 201）/ 编号规则 / 文档结构规范 / 阅读顺序 |
| P-02 | 项目宪法 | [constitution.md](./constitution.md) | ✅ | 架构 / 安全 / IPC / 代码质量 / 生命周期 / 构建与治理 六章 + 使用方式 |
| P-03 | 整体架构 | [ARCHITECTURE.md](./ARCHITECTURE.md) | ✅ | 一句话架构 / 进程模型图 / 分层 / 数据流 / 12 条关键决策 / 与 `dsh-desktop`、`pi-desktop-hos` 差异 / 部署拓扑 |
| P-04 | 技术选型 | [TECH.md](./TECH.md) | ✅ | 版本表 / 5 条选型理由 / 上游依赖表 / 12 条兼容风险 / 运行环境与门禁 |
| P-05 | 目录与结构 | [STRUCTURE.md](./STRUCTURE.md) | ✅ | 目录树逐项注释 / 进程入口三段 / 关键配置文件表 / 运行期目录 |
| P-06 | 整体规格 | [overall-spec.md](./overall-spec.md) | ✅ | 目的与用户 / 9 条用户故事 / **49 条 `FR-000-*`**（生命周期 9 + 宿主 10 + 桌面壳 10 + 安全 10 + 构建发布 10）/ 非功能需求 / 系统边界 |
| P-07 | 整体技术方案 | [overall-plan.md](./overall-plan.md) | ✅ | 技术上下文 / 宪法合规检查表 / 启动编排（13 步 + boot 七阶段）/ 宿主集成 / 窗口与安全 / 托盘与通知 / 横切 / 门禁 / 构建 / 部署与更新 |
| P-08 | 数据模型 | [overall-data-model.md](./overall-data-model.md) | ✅ | 7 个壳层实体（含 as-built 差异说明）/ 3 个状态机 / 数据边界表 |
| P-09 | 检查清单 | [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) | ✅ | 本文件 |

> 本规格集**不含** `API.md` / `overall-api.md` / `overall-test-cases.md`：数据面在 `pi-web` 侧（约 90 条 HTTP 路由 + SSE），
> 本工程无自有 API 清单（[README.md](./README.md) §一 注）。

**项目级合计：9 / 9 ✅。**

---

## 2. 模块级文档（`M-01 … M-13`）

口径：`spec.md` 与 `plan.md` **必须成对**（[constitution.md](./constitution.md) §6.4）；
「未生成」**不是缺漏**，而是 Phase 1 的排期产物 —— 未生成的模块**不允许**在代码里出现与规格冲突的结论。

| # | 编号 / 模块 | `spec.md` | `plan.md` | 状态 | 理由 / 出口 |
|---|---|---|---|---|---|
| M-01 | `001-host`（Host 宿主） | ✅ [spec.md](./001-host/spec.md) | ✅ [plan.md](./001-host/plan.md) | ✅ 成对 | 已生成（192 + 225 行）；实现落点 `src/main/host.ts`（+ `constants.ts`/`logger.ts`） |
| M-02 | `002-window`（窗口管理） | ✅ [spec.md](./002-window/spec.md) | ✅ [plan.md](./002-window/plan.md) | ✅ 成对 | 已生成（212 + 238 行）；实现落点 `src/main/windows.ts`（+ `window-state.ts`） |
| M-03 | `003-tray`（系统托盘） | ✅ [spec.md](./003-tray/spec.md) | ✅ [plan.md](./003-tray/plan.md) | ✅ 成对 | 已生成（173 + 185 行）；实现落点 `src/main/tray.ts` |
| M-04 | `004-notification`（原生通知） | ✅ [spec.md](./004-notification/spec.md) | ✅ [plan.md](./004-notification/plan.md) | ✅ 成对 | 已生成（171 + 216 行）；实现落点 `src/main/notifications.ts` + `session-watch.ts`；⬜ 事件源待 P0-5 取证 |
| M-05 | `005-lifecycle`（生命周期与安全） | ✅ [spec.md](./005-lifecycle/spec.md) | ✅ [plan.md](./005-lifecycle/plan.md) | ✅ 成对 | 已生成（188 + 233 行）；实现落点 `src/main/lifecycle.ts` |
| M-06 | `006-preload`（壳层桥） | ✅ [spec.md](./006-preload/spec.md) | ✅ [plan.md](./006-preload/plan.md) | ✅ 成对 | 已生成（158 + 142 行）；实现落点 `src/preload/index.ts`（`file://` 守卫） |
| M-07 | `007-app-entry`（应用入口编排） | ✅ [spec.md](./007-app-entry/spec.md) | ✅ [plan.md](./007-app-entry/plan.md) | ✅ 成对 | 实现落点 `src/main/index.ts`（Squirrel→锁→安全准备→whenReady→窗→托盘→boot→退出链） |
| M-08 | `008-runtime-config`（运行时配置） | ✅ [spec.md](./008-runtime-config/spec.md) | ✅ [plan.md](./008-runtime-config/plan.md) | ✅ 成对 | 实现落点 `src/main/settings.ts` + `config/*.json`；⬜ 预置模板合并策略（O6）待定 |
| M-09 | `009-artifact-bootstrap`（产物引导） | ✅ [spec.md](./009-artifact-bootstrap/spec.md) | ✅ [plan.md](./009-artifact-bootstrap/plan.md) | ✅ 成对 | 实现落点 `src/main/artifact.ts` + `tar-extract.ts`；P0-4 取证 3/4（解压期内存曲线未采样） |
| M-10 | `010-build-pipeline`（构建流水线） | ✅ [spec.md](./010-build-pipeline/spec.md) | ✅ [plan.md](./010-build-pipeline/plan.md) | ✅ 成对 | 脚本 `scripts/*.mjs` + `forge.config.ts` + `vite.*.config.ts`；轮次 1 复核 prebuilds 裁剪**未丢文件** |
| M-11 | `011-release-update`（发布与更新） | ✅ [spec.md](./011-release-update/spec.md) | ✅ [plan.md](./011-release-update/plan.md) | ✅ 成对 | `.github/workflows/*` + `src/main/update-check.ts`；⬜ 更新数据源待人工确认 |
| M-12 | `201-plugin-runtime`（扩展投放，可选档） | ⬜ | ⬜ | ⬜ 未生成 | 上游 UI 已内置 Plugins/Skills/MCP 管理（Q7）；本工程是否需要该档**尚未决策**（工程规划 §10 Phase 2 之后） |
| M-13 | `012-branding`（品牌化，**版本需求型**） | ✅ [spec.md](./012-branding/spec.md) | ✅ [plan.md](./012-branding/plan.md) | ✅ 成对（+ [`test-cases.md`](./012-branding/test-cases.md) 含执行结果） | 15 条 `FR-012-*` / 7 条 `AC-*`；轮次 1 打包态端到端 **TC 16 PASS / 0 FAIL**（证据 `logs/20261013-0/`，见 [../../docs/构建验证记录.md](../../docs/构建验证记录.md) 轮次 1） |

**模块级合计（2026-10-13 复核）：12 / 12 成对 ✅（`001`–`012`，含本轮的 `012-branding`）；`201-plugin-runtime` 仍为 ⬜（是否要做尚未决策）。**

> ⚠️ 本表原按 **2026-10-12 快照**填写（当时 `007`–`011` 标为「未生成」）；2026-10-13 复核发现这些目录内的 `spec.md` / `plan.md` **均已存在**，故已改判「✅ 成对」。
> 行数未逐项复核；**最新状态以 `specs/<NNN>-<name>/` 目录内的实际文件为准**。

---

## 3. 代码与工程落点（as-built，2026-10-12 快照）

> 这一节**不是**规格完成度，而是「规格声称的落点是否存在」的对照，供评审快速定位。
> 快照之后的变化以工作树为准（[constitution.md](./constitution.md) §4.4）。

| 模块 | 声称落点 | 实际 | 备注 |
|---|---|---|---|
| 001-host | `src/main/host.ts` | ✅ | 含 `resolveFreePort` / `assembleEnv` / `resolvePassword` / `rotatePreviewSecrets` / `waitForReady` / `startHost` / `installAuthInjection` / `installAuthForWindow` / `closeWithDeadline` |
| 002-window | `src/main/windows.ts`、`window-state.ts` | ✅ | 含 loading 页阶段回传、导航加固、权限白名单、`registerShellIpc`、F11 |
| 003-tray | `src/main/tray.ts` | ✅ | 含 `TrayActions` 的就绪态禁用 |
| 004-notification | `src/main/notifications.ts`、`session-watch.ts` | ✅ | 冷却去重 + 后台判定 + 启动基线（不补弹） |
| 005-lifecycle | `src/main/lifecycle.ts` | ✅ | `ensureLoopbackNoProxy` / `setupSystemCertificates` / `installCrashHandlers` |
| 006-preload | `src/preload/index.ts` | ✅ | `location.protocol === 'file:'` 守卫 + 6 个壳层动作 |
| 007-app-entry | `src/main/index.ts` | ✅ | Squirrel → 锁 → 安全准备 → whenReady → 窗 → 托盘 → boot → 退出链 |
| 008-runtime-config | `src/main/settings.ts`、`config/*.json` | ✅ | `AgentDirMode` / `ShellSettings` / 预置模板物化 |
| 009-artifact-bootstrap | `src/main/artifact.ts`、`tar-extract.ts` | ✅ | 流式 ustar + marker 幂等 |
| 010-build-pipeline | `scripts/*.mjs`、`forge.config.ts`、`vite.*.config.ts` | ✅ | 四脚本 + `prepackage`/`premake` 钩子 |
| 011-release-update | `.github/workflows/{ci,release}.yml`、`src/main/update-check.ts` | ✅ | 三 OS 矩阵 + Release 资产 + 半自动更新检查 |
| — | `specs/` 项目级 9 件 | ✅ | 本次交付 |
| — | `docs/工程规划.md` | ✅ | 唯一权威规划文档 |
| — | `docs/{桌面能力清单,构建验证记录,发布与更新}.md` | ✅ | 工程规划 §12.2 的产出（内容由各自主责作者维护） |
| — | `README.md`（构建/运行/调试说明） | ✅ | 工程规划 §12.2 的操作说明文档，已存在 |
| — | `patches/` 目录 | ⬜ | **本版 0 条必需补丁**；目录与 README 尚未建立（工程规划 §7 要求「目录仍然建立」） |
| — | `upstream.lock.json` | ⬜ | 构建期由 `scripts/pin-upstream.mjs` 生成（gitignore），当前未执行 |
| — | `pi-dist.tar.gz` / `pi-dist.version` / `out/` | ⬜ | 构建期产物，当前未执行完整流水线 |

---

## 4. 未开工项与出口判据

| # | 项 | 状态 | 出口判据（可证伪） |
|---|---|---|---|
| G-01 | **P0-0 骨架**：`npm ci` + `npm start` 出空窗 | 🔶 | `npm ci` 已执行（`node_modules` 存在）+ `npm run typecheck` 通过；⬜「窗口显示 loading 页」未见证据（`npm start` 未记录） |
| G-02 | **P0-1 进程内 Next 宿主探针** | ⬜ | ① 监听成功 ② `GET /` 返回 SPA ③ 带凭据 `/api/*` 200 ④ 主进程不退出 ⑤ 预览密钥已轮换 |
| G-03 | **P0-2 Node 24.21 兼容性探针** | ⬜ | `smoke-desktop.mjs` 四项断言全绿；`AgentSession` 可创建；无 `ERR_*` 启动失败 |
| G-04 | **P0-3 渲染与 `node-pty` 探针** | ⬜ | 首屏完整渲染；`fetch /api/*` 200；SSE 长连接稳定；`localStorage`/`crypto.subtle` 可用；`window.open` 被拦截；终端面板可开（或判定需 `@electron/rebuild` / 降级） |
| G-05 | **P0-4 产物引导探针** | ⬜ | 解压文件数与源目录一致；二次启动不再解压；tar 包变更后重新解压；解压期间内存不随条目增长 |
| G-06 | **P0-5 通知事件源探针** | ⬜ | 失焦时能出通知、聚焦时不出；冷却/去重生效；启动历史不补弹；延迟记录 |
| G-07 | **P0-6 打包冒烟** | ⬜ | 安装后可启动到首屏；卸载不残留孤儿进程 |
| G-08 | **门禁执行记录** | 🔶 | `npm run typecheck` ✅ **通过**（2026-10-12：`npx tsc --noEmit` 退出码 0；首轮曾报 `src/main/windows.ts(202,10) TS2304: Cannot find name 'app'`，已修复）；`node scripts/smoke-desktop.mjs` ⬜ 未执行（需 `pi-dist` 产物与 `../pi-web` 生产构建）。两者全绿前不得打包 |
| G-09 | **三平台实机验证** | ⬜ | Windows 必过；mac/Linux 至少「安装 + 首屏 + 一轮对话」（工程规划 §10 Phase 1 出口判据） |
| G-10 | **§11.4 安全自查 6 项** | ⬜ | S1 产物无 `--inspect` / S2 日志无密码明文 / S3 仅绑 loopback / S4 DevTools 仅 dev / S5 Fuses 六项 / S6 外链走系统浏览器 —— 需构建产物核对脚本 |
| G-11 | **人工确认 5 项**（§11.3） | ⬜ | 应用 ID 与发布主体 / 更新检查数据源 / 签名与公证 / 数据目录默认值 / 上游升级责任人 |
| G-12 | **`patches/` 目录与说明** | ⬜ | 目录存在且 README 写明「本版本为空」及其理由（工程规划 §7） |

---

## 5. 完成度统计

- **项目级文档**：9 / 9 ✅（100%）。
- **模块级规格**（快照）：6 / 12 成对；6 / 12 未生成 —— 但 5 个未生成的模块**实现代码已在树内**，缺口在规格两侧。
- **代码落点**：主进程 14 个模块文件 + preload/renderer/types 全部在位；构建脚本 4 件、CI/Release 工作流 2 件在位；`patches/` 未建。
- **探针与门禁**：**0 项完成、2 项部分推进**（G-01 骨架：`npm ci` + 类型门通过；G-08 门禁：类型门 ✅，冒烟脚本未执行）。
  当前最大的未知面 = P0-1（进程内 Next 内部入口）与 P0-3（`node-pty` 在 ABI 148 下能否加载）。
- **未登记例外**：无。
