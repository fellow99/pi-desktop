# 规格文档索引

**项目名称：** pi-desktop
**产品名：** Pi Desktop
**技术栈：** Electron **43.7.9**（Node **24.21.0** / Chromium **150.0.7871.250** / ABI **148**）+ Electron Forge **^7.11.2**（plugin-vite + plugin-fuses）+ Vite **^7.3.6** + TypeScript **^5.6**；封装的宿主是 `pi` **v1.1.0** + `pi-web` **v0.11.1**（Next.js **16.3.8**）
**上游基线：** `pi` tag **v1.1.0**（`Branch_v1.1.0`）· `pi-web` tag **v0.11.1**（`Branch_v0.11.1`）
**文档生成时间：** 2026-10-12
**最后更新：** 2026-10-12

---

## 一、文档总览

| 层级 | 说明 |
|---|---|
| 项目级顶层文档 | 架构、技术、宪法、结构、整体规格 / 方案 / 数据模型 + 检查清单 |
| 模块规格 `0NN-<name>/` | 桌面壳基础模块（主进程装配、构建与配置），编号 **001–011** |
| 扩展模块 `2NN-<name>/` | 编号从 **201** 起；v1 只有 `201-plugin-runtime` 一个可选档 |

每个模块目录下**必须成对**提供 `spec.md`（需求与验收）+ `plan.md`（设计与实现方案）；
复杂模块可再增加 `tasks.md`（任务拆解）、`test-cases.md`（测试用例）。

> **证据标注口径**（全文一致，沿用 [`../docs/工程规划.md`](../docs/工程规划.md) §0.2）：
> `✅ 已核实`（读上游源码或本工程文件得到，附出处）· `🔶 沿用`（沿用 `dsh-desktop` / `pi-desktop-hos` 的既有结论，本工程未复现）·
> `⬜ 待验证`（本工程必须自测；写明验证方式）· `⚠️ 风险`（两份一手材料互斥或存在硬阻塞）。
> **纪律**：`🔶 沿用` 不得当作本工程实测事实引用；`⬜ 待验证` 在拿到证据前不得写成结论。

> **本规格集不含** `API.md` / `overall-api.md` / `overall-test-cases.md`：数据面在 `pi-web` 侧
> （约 90 条 HTTP 路由 + SSE，✅ 读 `pi-web/app/api/**`），本工程无自有 API 清单，只做装配。
> 口径对齐参考工程 `dsh-desktop`（其 `specs/README.md` §一 的同一取舍）。

---

## 二、项目级顶层文档

| # | 文档 | 说明 | 状态 |
|---|---|---|---|
| P-01 | [README.md](./README.md) | 本索引：模块清单 + 编号规则 + 文档规范 + 阅读顺序 | ✅ 已生成 |
| P-02 | [constitution.md](./constitution.md) | 项目宪法：架构 / 安全 / IPC / 代码质量 / 生命周期 / 构建与治理原则 | ✅ 已生成 |
| P-03 | [ARCHITECTURE.md](./ARCHITECTURE.md) | 整体架构：进程模型、分层、数据流、关键决策、与参考工程差异 | ✅ 已生成 |
| P-04 | [TECH.md](./TECH.md) | 技术选型：版本表、选型理由、上游依赖、已知兼容风险 | ✅ 已生成 |
| P-05 | [STRUCTURE.md](./STRUCTURE.md) | 目录结构逐项注释、进程入口表（Vite 三段）、关键配置文件表 | ✅ 已生成 |
| P-06 | [overall-spec.md](./overall-spec.md) | 整体规格：目的、用户故事、`FR-000-*` 功能需求、非功能需求、系统边界 | ✅ 已生成 |
| P-07 | [overall-plan.md](./overall-plan.md) | 整体技术方案：启动编排、宿主集成、窗口与安全、托盘与通知、横切、门禁 | ✅ 已生成 |
| P-08 | [overall-data-model.md](./overall-data-model.md) | 数据模型：壳层实体、启动状态机、数据边界 | ✅ 已生成 |
| P-09 | [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) | 规格与模块完成度检查表（`P-01…` / `M-01…`） | ✅ 已生成 |

> 本表的项目级文档是 [`../docs/工程规划.md`](../docs/工程规划.md) 的**收敛版**：只压缩结论并回引 § 号，
> 不复制论证过程；两份文档冲突时**以工程规划与源码为准**（宪法「源码即真理」，见
> [constitution.md](./constitution.md) §4.4）。

---

## 三、模块清单（001–011 + 201）

### 主进程装配模块（001–007）

> 这七个模块的规格意义大于文件意义：一个模块 = 一份需求 + 一份方案 + 一段可变的职责，
> 不强制一个模块一个文件（对应实现散落在 `src/main/*.ts`，见 [STRUCTURE.md](./STRUCTURE.md) §1）。
> **规格状态以 [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) §2 为唯一口径**（本表随其同步）。

| 编号 | 模块名 | 英文名 | 职责（一行） | 规格状态 |
|---|---|---|---|---|
| 001 | Host 宿主 | `host` | 环境装配（`PI_CODING_AGENT_DIR`/`PI_WEB_*`）、进程内启动 Next 服务器（含预览密钥轮换）、随机端口与随机密码、HTTP 轮询就绪判定、优雅关闭 | ✅ 成对（[001-host/](./001-host/)） |
| 002 | 窗口管理 | `window` | `BrowserWindow` + loading 页（阶段可见）、同源加载 `http://127.0.0.1:<port>/`、导航加固、权限白名单、`window.open` 拦截 | ✅ 成对（[002-window/](./002-window/)） |
| 003 | 系统托盘 | `tray` | 托盘单例与菜单（显示主窗口 / 会话目录 / 打开日志 / 检查更新 / 退出）、唤回、退出入口 | 见 [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) §2（003-tray/） |
| 004 | 原生通知 | `notification` | 会话 JSONL 尾随 → 原生通知策略（仅后台弹、同会话冷却去重、历史不补弹） | 见 [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) §2（004-notification/） |
| 005 | 生命周期与安全 | `lifecycle` | 单实例锁、`NO_PROXY` 并入、系统 CA 合并、代理绕过、崩溃兜底、优雅关闭链 | 见 [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) §2（005-lifecycle/） |
| 006 | 壳层桥 | `preload` | 默认空实现；按需启用**只承载壳层动作**的最小桥（数据面永不入 IPC） | 见 [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) §2（006-preload/） |
| 007 | 应用入口编排 | `app-entry` | 锁 → 安全准备 → `AppUserModelId` → 起宿主 → 建窗 → 托盘/通知 → `activate`/退出；Squirrel 事件 | ⬜ 待生成（见 [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) §2） |

### 构建与配置模块（008–011）

| 编号 | 模块名 | 英文名 | 职责（一行） | 规格状态 |
|---|---|---|---|---|
| 008 | 运行时配置 | `runtime-config` | 数据目录策略（`shared`/`app`，切换需重启）、预置 `settings/mcp/trust` 模板（不覆盖既有文件）、壳专用扩展/技能落点 | ⬜ 待生成（见 [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) §2） |
| 009 | 产物引导 | `artifact-bootstrap` | `pi-dist` 组装、`tar.gz`(ustar)、首启流式解压、SHA-256 marker 幂等（不是存在性判断） | ⬜ 待生成（见 [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) §2） |
| 010 | 构建流水线 | `build-pipeline` | `prepare-next` / `collect-pi` / `smoke-desktop` 门禁 / Forge 打包（`premake` 自动串联） | ⬜ 待生成（见 [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) §2） |
| 011 | 发布与更新 | `release-update` | 三 OS CI 矩阵、Release 资产、检查更新（半自动：查询 → 比较 → 引导下载） | ⬜ 待生成（见 [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) §2） |

### 版本需求模块（012+）

| 编号 | 模块名 | 英文名 | 职责（一行） | 规格状态 |
|---|---|---|---|---|
| 012 | 品牌化 | `branding` | 清掉上游品牌：`pi-dist` 副本的文案 / 页面 Logo / web 位图图标 / favicon，以及本工程 `resources/*` 应用图标；运行时关掉上游版本检测但**保留当前版本显示** | ✅ 已生成（[spec.md](./012-branding/spec.md) / [plan.md](./012-branding/plan.md) / [test-cases.md](./012-branding/test-cases.md)，含轮次 1 执行结果） |

> 说明：`001`–`011` 与 `201` 的「规格状态」列写于早期快照；**截至 2026-10-13，`001`–`012` 的 `spec.md`/`plan.md` 均已存在（成对）**，`201` 仍未生成（是否要做尚未决策）。以 [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) §2 与各目录实际文件为准。
### 扩展模块（201+）

| 编号 | 模块名 | 英文名 | 职责（一行） | 规格状态 |
|---|---|---|---|---|
| 201 | 扩展投放 | `plugin-runtime` | 壳专用扩展/技能的物化与 `settings.json` 接线（可选档）；上游 UI 已内置 Plugins/Skills/MCP 管理，**不建独立市场工程**（Q7） | ⬜ 待生成（见 [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) §2） |

**编号分配依据**：[`../docs/工程规划.md`](../docs/工程规划.md) §6.4。**编号只增不改、不复用。**
`dsh-desktop` 的 `008-desktop-profile`（dsh profile）与 `201-dsh-market`（插件市场）在本工程**无对应物**
（`pi` 无 profile 概念；上游 UI 已内置插件管理），见工程规划 §4.9、§6.3、Q7。

---

## 四、编号规则

1. **段位**：`0xx` = 桌面壳基础模块（主进程装配 + 构建与配置），`2xx` = 扩展模块（从 **201** 起）。
   编号**只增不改、不复用**；作废编号留空不回收（🔶 沿用 `dsh-desktop` / `oc-desktop` 口径，工程规划 §6.4）。
2. **目录名**：`<NNN>-<kebab-name>`（示例：`001-host`、`201-plugin-runtime`）。
3. **成对交付**：`spec.md` 与 `plan.md` **必须成对**，只交一半视为未完成。
4. **需求条目**：`FR-<module>-<三位数>`（模块级三位数；项目级统一用 `FR-000-<三位数>`，见
   [overall-spec.md](./overall-spec.md) §3）；动作用 **MUST / MUST NOT / SHOULD / MAY** 表述；
   条目**只追加不修订**，作废改标 `[SUPERSEDED by FR-xxx-nnn]`。
5. **模块编号 ⇄ 目录 ⇄ 规格** 三处必须一致；新增模块先改本文件与 `SPECS_CHECKLIST.md`，再建目录。

---

## 五、文档结构规范（硬规则）

1. **统一文档头**：
   ```markdown
   > **Module:** <name> ｜ **Status:** Proposed ｜ **Last Updated:** YYYY-MM-DD
   > **上游基线:** pi v1.1.0（Branch_v1.1.0）· pi-web v0.11.1（Branch_v0.11.1）
   ```
2. **状态流转**：`Proposed → Accepted → Implementing → Implemented → Superseded`。
3. **不留占位小节**：未定事项写 `⬜` + **验证方式** + **决策时限**，不写 TBD、不留空标题。
4. **`spec.md` 骨架（8 节）**：模块概述（目的/问题/范围）→ 用户故事 → 功能需求 → 关键实体 →
   验收场景（Given/When/Then）→ 非功能需求 → 假设与约束 → 依赖。
5. **`plan.md` 骨架（9 节）**：技术上下文 → 宪法合规检查 → 研究结论（关键决策 / 源码级核实）→
   数据模型 → 接口契约 → 实现策略 → 测试考量 → 文件清单 → 与规格交叉引用。
6. **`plan.md` 必须回引 FR**：每个技术决定指明它满足哪条 FR；每条 FR 都要有落点（反向闭合）。
7. **「源码即真理」**：每条声明可追溯到源文件 + 行号；代码与文档冲突时**以代码为准**并在文档标注变更提示。
8. **平台差异显式化**：Windows / macOS / Linux 的差异（路径、通知归组、托盘图标、可执行名、未签名安装）
   必须有台账（工程规划 §9.3、§4.5 ⚠️ 行）。
9. **本规格集不写的文件**：`API.md`、`overall-api.md`、`overall-test-cases.md`（理由见 §一 注）。

---

## 六、推荐阅读顺序

| 目标读者 | 推荐阅读顺序 |
|---|---|
| 先看全貌 | [`../docs/工程规划.md`](../docs/工程规划.md) → 本文件 → [ARCHITECTURE.md](./ARCHITECTURE.md) |
| 新加入开发者 | [constitution.md](./constitution.md) → [STRUCTURE.md](./STRUCTURE.md) → [overall-spec.md](./overall-spec.md) → 具体模块 `spec.md` |
| 架构师 / 评审 | [ARCHITECTURE.md](./ARCHITECTURE.md) → [TECH.md](./TECH.md) → [overall-plan.md](./overall-plan.md) → [overall-data-model.md](./overall-data-model.md) |
| 桌面壳开发 | [STRUCTURE.md](./STRUCTURE.md) → 001/002/003/005 的 `spec.md` + `plan.md` |
| 构建 / 发布 | [overall-plan.md](./overall-plan.md) §9–§10 → 010/009/011 的 `spec.md` + `plan.md` |
| 测试 / QA | [SPECS_CHECKLIST.md](./SPECS_CHECKLIST.md) → 各模块 `spec.md` 的验收场景 → [`../docs/工程规划.md`](../docs/工程规划.md) §11.4 安全自查 |
| 风险 / 开放问题 | [`../docs/工程规划.md`](../docs/工程规划.md) §11 → [TECH.md](./TECH.md) §4 已知兼容风险 |

---

**文档维护者：** pi-desktop 开发团队
