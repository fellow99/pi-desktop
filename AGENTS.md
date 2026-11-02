# AGENTS.md — pi-desktop（Pi Desktop · Electron 桌面版）

> 本文件是本工程（`pi-desktop`）的 AI Agent 工作规范与导航入口。
> 事实权威：`docs/工程规划.md` ＋ `specs/`；行为权威：`specs/constitution.md`。本文档只做收敛与回引，不复制论证。

---

## 一、项目定位

**Pi Desktop** —— 把上游 [Pi](https://github.com/earendil-works/pi)（agent harness）与
[Pi Web](https://github.com/agegr/pi-web)（Next.js 浏览器 UI）封装成 **Windows / macOS / Linux 的一等公民桌面应用**
（Electron **43.7.9** / Node **24.21.0** / Chromium **150** / ABI **148**）。

核心形态：**Electron 主进程内**跑起 `pi-web` 的 Next 服务器（含 agent 与 `/api/*`），渲染层同源加载该服务的 UI；
桌面壳补齐托盘 / 原生通知 / 单实例 / 窗口状态 / 产物引导 / 更新引导。**UI 100% 复用上游，0 条上游补丁，不 fork 前端。**

- 应用名 / 可执行名 / ID：`Pi Desktop` / `pi-desktop` / `com.fellow99.pi.desktop`
- 上游基线：`pi` **v1.4.0** + `pi-web` **v0.13.0**（钉住在 `upstream.lock.json`）
- 版本：`0.13.0`（tag `v0.13.0`）

## 二、关键目录

| 路径 | 作用 |
|---|---|
| `src/main/` | Electron 主进程（环境装配、产物就位、进程内 Next 服务器、就绪判定、托盘/通知/窗口/更新、生命周期） |
| `src/preload/`、`src/renderer/` | 预加载与渲染层（渲染层即官方 Pi Web UI） |
| `src/types/` | 全局类型 |
| `scripts/` | 装配/构建脚本：`collect-pi.mjs`（产物打 tar.gz）、`brand-assets.mjs`（品牌物料）、`pin-upstream.mjs`（钉上游）、`prepare-next.mjs`、`probe-renderer.mjs`、`smoke-desktop.mjs` |
| `resources/` | 应用图标 / 托盘 / `brand/` 品牌镜像 |
| `specs/` | 规格文档集（模块 `011/012/013` + `1XX` 基础 + `201` 插件） |
| `docs/` | 工程规划、桌面能力清单、构建验证记录（事实证据） |
| `.github/workflows/` | CI / 发布流水线（依赖兄弟目录 `../pi`、`../pi-web`） |

**构建前提**：本工程依赖兄弟目录布局（`../pi`、`../pi-web`、`../assets`），脱离 `pi-workspace` 单独 clone 会构建失败。

## 三、常用命令

```bash
npm install            # 安装依赖（勿提交 lockfile，除非 PI_ALLOW_LOCKFILE_CHANGE=1）
npm run check          # 类型 + 检查（提交前必须全绿）
npm run brand          # 单独跑品牌物料脚本
npm run start          # 开发运行
npm run package        # 打包（Forge）
```

## 四、规格文档（specs）

- 编号规则：`0XX` 公共模块（011 版本 / 012 构建工作流 / 013 品牌化）· `1XX` 基础模块 · `2XX` 插件模块。
- 每个模块目录成对提供 `spec.md`（需求/验收）＋ `plan.md`（方案）；复杂模块再加 `tasks.md` / `test-cases.md`。
- **证据纪律**：`✅ 已核实`（读源码）· `🔶 沿用`（承接他工程，不得当本工程实测）· `⬜ 待验证`（未拿证据不得写成结论）· `⚠️ 风险`。
- 数据面（`/api/*`、SSE）由上游 `pi-web` 提供，本工程**不自有 API**，故无 `API.md`。

## 五、CodeGraph 代码地图规范

> 本工程已建立 CodeGraph 语义索引，AI 探索**优先走 CodeGraph**，grep/Read 仅用于细节确认。

- 索引位置：`.codegraph/`（不入库，`git status` 应忽略）。
- **自动更新**：git `post-commit` 钩子（`.git/modules/pi-desktop/hooks/post-commit`）在每次提交后自动 `codegraph sync` 增量更新，非阻塞、不破坏提交。
- 常用命令：
  - `codegraph status` —— 索引健康检查（Journal 应为 `wal`）
  - `codegraph context "<任务描述>"` —— 探索一个功能区域
  - `codegraph query <符号>` / `callers` / `callees` / `impact` —— 符号与调用关系
  - `codegraph affected <改了哪些文件>` —— 收紧回归测试范围
- 改动大量源码后，若查询不到符号，先 `codegraph sync` 再查。

## 六、提交纪律

- 提交信息使用 Conventional Commits（`feat`/`fix`/`docs`/`style`/`refactor`/`perf`/`test`/`build`/`ci`/`chore`/`revert`）。
- **严禁** `git add -A` / `git add .`：只暂存本会话改动的文件（父子工程可能有并发的 pi 会话）。
- 提交前跑 `npm run check`，无新增错误。
- 严禁提交密钥 / Token / 口令（`.env`、`*.local.json`、签名材料等已忽略）。

## 七、安全红线

- 严禁 `as any` / `@ts-ignore` / `@ts-expect-error` 压制类型错误。
- 严禁空的 `catch(e) {}`。
- 修复 Bug 只做最小改动，禁止顺手重构；禁止臆测未读取的代码。
