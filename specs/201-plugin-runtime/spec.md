# 201 — 扩展投放（plugin-runtime）功能规格

> **Module:** 201-plugin-runtime（扩展投放）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应方案:** [`./plan.md`](./plan.md)
> **实现落点:** `extensions/`、`skills/`（壳专用内容）＋ 008-runtime-config 的投放逻辑
> **规划依据:** `docs/工程规划.md` §0.3（Q7）、§2.2（上游扩展点）、§6.2（目录结构）、§6.3（剔除市场）、§9.3

## 1. 模块概述

### 1.1 目的

扩展投放模块的职责是：**在「不另建插件市场工程」的前提下，把壳专用（shell-owned）的 pi 扩展与技能投放到用户数据目录，并让它们的启用/禁用复用上游既有的 Plugins/Skills/MCP UI 与 `settings.json` 机制**。

边界来自决策 Q7（✅）：pi-web 已内置可视化插件管理（`/api/plugins/**`、`/api/skills/**`、`/api/mcp/**`、`/api/subagents/**`），因此自建市场属重复建设 —— 本工程**不另建市场工程**（对照 `dsh-desktop` 的 `201-dsh-market` 被剔除，✅ §6.3）。

### 1.2 解决的问题

- **重复建设**：上游已有插件/技能/MCP 的可视化管理与安装链路（且桌面有原生 `npm`/`git`），不需要便携 Node/pnpm 与自有索引服务。
- **壳特有的补充能力**：桌面壳偶尔需要提供「壳自己的」扩展或技能（例如桌面环境能力说明、壳专用动作），这些不属于上游，也不应打进上游仓库 —— 需要一个明确的投放落点与更新策略。
- **投放与用户意图冲突**：若壳层每次启动都强投壳内容，用户在上游 UI 里删除/禁用的决定会被无声推翻（数据被恢复 = 用户失去控制）。
- **落点不一致**：pi 的扩展/技能目录由 `PI_CODING_AGENT_DIR` 决定，而该目录在桌面版可能是共享的 `~/.pi/agent`（✅ Q6）。壳投放必须写进**当前生效的**数据目录，不能写死应用私有目录。

### 1.3 范围

**包含**

- 壳专用扩展（`extensions/<name>/`）与技能（`skills/<name>/`）的定义、随包分发与**投放（物化）**。
- 投放的幂等、命名空间隔离、更新与「用户已删除/禁用」的尊重策略。
- 与 `settings.json` 的接线（仅在必要时，且复用上游字段；见 FR-201-007）。
- 投放结果的可观测性（日志 + 诊断清单）。

**不包含**

- 插件市场 / 索引 / 安装 UI（**明确不做**，Q7；§6.3 剔除 `201-dsh-market`）。
- 便携 Node/pnpm 运行时（§6.3 剔除 `runtime.ts`；桌面本就有 `npm`/`git`）。
- 上游插件机制的修改（零补丁，§7）。
- 上游 Plugins/Skills/MCP 页面的任何改动或替换。
- 第三方扩展的安装/升级流程（完全沿用上游 UI；本模块不介入）。

## 2. 用户故事

- 作为用户，我希望在应用内用**上游自带的**设置页管理扩展/技能/MCP，而不是再学一套「桌面版专用」的插件管理。
- 作为用户，我希望壳自带的那点扩展/技能开箱可用，并且我能在上游 UI 里关掉它们。
- 作为用户，我希望我在 UI 里删掉或禁用的东西**不会**在下次启动时被应用偷偷恢复。
- 作为用户，我希望切换数据目录（共享 ↔ 私有）后，扩展/技能的可见范围随之变化，而不是散落在两个目录里。
- 作为维护者，我希望「壳投放了哪些文件、投到哪、为什么跳过」在日志里一目了然。

## 3. 功能需求

动作词：**MUST** 必须满足；**MUST NOT** 禁止；**MUST** 必须满足；**MUST NOT** 禁止；**SHOULD** 建议；**MAY** 可选。

### 3.1 边界（不做市场）

- FR-201-001：系统 MUST 以**上游既有的** Plugins / Skills / MCP / Agents 界面作为扩展与技能的唯一安装、配置与开关入口。
- FR-201-002：系统 MUST NOT 建立自有插件市场工程、自有插件索引服务或自有安装链路（✅ Q7；对照 §6.3 对 `201-dsh-market` 的剔除）。
- FR-201-003：系统 MUST NOT 为插件安装内置便携 Node/pnpm 运行时（桌面已有原生 `npm`/`git`；§6.3 剔除 `runtime.ts`）。
- FR-201-004：系统 MUST NOT 修改 `pi` / `pi-web` 的插件加载机制或其对扩展/技能的发现规则（补丁集 0 条，§7）。

### 3.2 投放落点与内容

- FR-201-005：壳专用扩展 MUST 投放到 `<agentDir>/extensions/<name>/`；壳专用技能 MUST 投放到 `<agentDir>/skills/<name>/`（`agentDir` 来自 008 的解析结果；✅ `pi/packages/coding-agent/src/config.ts` 的目录布局）。
- FR-201-006：系统 MUST 只投放到**当前生效的** `agentDir`；**MUST NOT** 写死 `<userData>/pi-agent` 或 `~/.pi/agent`（数据目录可能被切换，Q6）。
- FR-201-007：壳专用内容 MUST 随包分发（打包态从 `process.resourcesPath` 读取；开发态从仓库目录读取），且 MUST 以**真实文件复制**方式投放（不依赖符号链接；`derefSymlinks` 已为打包配置 ✅ `forge.config.ts:23`）。
- FR-201-008：壳专用内容的目录名 MUST 使用可辨识的壳命名空间前缀或等价手段（例如统一前缀 + 目录内版本标记文件），以便把「壳管理的内容」与「用户自建的内容」区分开。

### 3.3 投放语义（幂等与用户意图）

- FR-201-009：投放 MUST 幂等：同一次启动重复执行 MUST NOT 产生重复目录或损坏内容。
- FR-201-010：目标目录不存在时系统 MUST 写入；目标存在且属于壳管理（FR-201-008 的标记/前缀判定）且版本不同时，系统 SHOULD 更新为包内版本并记录。
- FR-201-011：目标存在且**不属于**壳管理（用户自建同名内容）时，系统 MUST NOT 覆盖、MUST NOT 删除，MUST 记录跳过原因。
- FR-201-012：用户在上游 UI 中删除或禁用壳投放物后，系统 MUST NOT 在下一次启动时**无条件**恢复它。⬜ 实现机制（一次性投放标记 vs 检查上游 `settings.json` 的启用/禁用字段）待 Phase 1 设计定案；无论采用哪种，**行为要求不变**：用户的显式意图优先。
- FR-201-013：投放 MUST 采用「先写临时目录再改名」的方式，**MUST NOT** 在目标位置留下半成品目录。

### 3.4 与 `settings.json` 的接线

- FR-201-014：当壳专用内容需要显式登记才能被上游加载时，系统 MUST 只使用 `settings.json` 中**上游既有字段**（✅ 已核实存在 `packages`、`extensions`、`defaultProjectTrust`；见 `pi/packages/coding-agent/src/core/settings-manager.ts`），并 MUST NOT 新增自定义字段。
- FR-201-015：系统 MUST NOT 覆盖用户在 `settings.json` 中已有的 `packages`/`extensions` 值；如确需追加，MUST 采用「不破坏既有条目的追加」策略并记录变更（⬜ 追加时机与冲突规则待 Phase 1 定案）。
- FR-201-016：系统 MUST NOT 通过 `settings.json` 静默改变项目信任（`defaultProjectTrust` MUST 保持保守，见 008 FR-008-010）。

### 3.5 可观测性

- FR-201-017：系统 MUST 在日志中记录：投放内容清单（名称/类型/版本）、每个目标的结果（写入 / 更新 / 跳过+原因）、以及**当前生效的** `agentDir`。
- FR-201-018：投放失败（目标不可写、磁盘满、包内内容缺失）MUST NOT 阻塞启动：记录 WARN 并继续（可选：在「关于/诊断」中可见）。
- FR-201-019：系统 SHOULD 在「关于/诊断」信息中列出壳投放物的名称与版本，便于用户与支持人员核对。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| 壳资产（ShellAsset） | 待投放的扩展或技能 | `kind: 'extension' \| 'skill'`、`name`、`sourcePath`、`targetPath`、`version` |
| 壳命名空间标记 | 区分壳管理与用户自建 | 前缀（如统一目录前缀）或目录内标记文件（⬜ 形式待定） |
| 投放结果 | 每个资产的结论 | `written` / `updated` / `skipped(reason)` |
| 投放清单 | 汇总（供诊断） | 资产列表 + 目标 `agentDir` + 结论 |
| 上游接线 | `settings.json` 的既有字段 | `packages`、`extensions`（✅ 已核实字段名） |

## 5. 验收场景

### 场景 S1：壳资产开箱可用

- Given 全新数据目录（`<agentDir>` 为空）
- When 应用首次启动
- Then 壳专用扩展/技能被投放到 `<agentDir>/extensions/` 与 `<agentDir>/skills/`；在上游 UI 的对应页面中可见

### 场景 S2：幂等

- Given 已投放完成
- When 应用再次启动
- Then 不产生重复目录、内容不变（版本一致 → 跳过并记录）

### 场景 S3：不覆盖用户自建内容

- Given 用户在 `<agentDir>/skills/<name>/` 放了同名自建技能
- When 应用启动
- Then 该目录内容逐字节不变；日志记录「跳过（用户自建）」

### 场景 S4：尊重用户删除/禁用

- Given 用户在上游 UI 中禁用（或删除）某壳投放物
- When 应用重启
- Then 该资产**不会**被无条件恢复（依据 FR-201-012 的机制）；若被恢复则视为缺陷

### 场景 S5：跟随数据目录

- Given 用户把 `agentDirMode` 切到 `app` 并重启
- When 检查投放结果
- Then 壳资产出现在 `<userData>/pi-agent/{extensions,skills}/`（新目录），而不是旧的共享目录

### 场景 S6：不建市场

- Given 应用完整运行
- When 检查应用内是否存在自有市场入口/索引请求/便携运行时
- Then 均不存在；扩展管理完全来自上游 UI

## 6. 非功能需求

- **零重复建设**：不新增市场、索引、安装链路、运行时（Q7）。
- **零上游改动**：不改上游插件机制与发现规则（§7）。
- **可靠性**：投放幂等、原子（临时目录 + 改名）、失败不阻塞启动。
- **可移植性**：路径用 `node:path`；复制不依赖符号链接能力。
- **透明性**：投放清单与结论必须落日志；用户可核对。
- **体积**：壳资产应保持小而可审（随包分发会增加安装体积，与 R12 同向）。

## 7. 假设与约束

- **假设（✅ Q7）**：上游 UI 已内置 Plugins/Skills/MCP 管理，因此本工程不另建市场工程；「壳层少量预置」是唯一增量。
- **假设（✅ 源码核实）**：扩展/技能/提示等状态都落在 `PI_CODING_AGENT_DIR` 指向的目录（含 `extensions/`、`skills/`，见 `pi/packages/coding-agent/src/config.ts`、§2.1）。
- **假设（⚠️ 风险 R10）**：`pi` 的扩展发现规则（是扫描 `extensions/` 目录，还是需要 `settings.json` 的 `extensions` 数组显式登记）**必须以源码为准**；⬜ 待探针（Phase 0/1）：清空临时数据目录 → 投放一个扩展 → 观察上游是否加载；据此确定是否需要 FR-201-014 的接线。
- **约束**：⬜ 壳命名空间的形式（前缀 vs 标记文件）与「用户已删除后是否重投」的机制尚未定案（FR-201-008、FR-201-012）；定案前**不得**实现为「每次启动无条件覆盖」，那是明确违反 FR-201-012 的行为。
- **约束**：⚠️ R7（共享目录下 CLI 与 pi-web 并发写同一会话不受支持）与本模块的投放无直接关系，但**共享模式下投放到 `~/.pi/agent` 会影响 CLI**：因此壳资产 MUST 保持小而明确，并在文档中说明投放到共享目录的事实（⬜ 文档落点：`README.md`）。
- **约束**：本模块为**可选档**（§6.4 备注「可选档」）：v1 可以只实现目录与投放框架，不必须随附任何具体扩展/技能（⬜ v1 是否随附壳资产待产品决定）。
- **约束**：`.exit`/`.close`、MCP stdio、`child_process` 等能力在桌面上都可用（§9.3 恢复），因此**不需要**像 HOS 那样用壳扩展顶替 `bash`/`grep`/`find`（对照 `pi-desktop-hos` 的 102-harmony-js-tools 与 PL1 策略）。

## 8. 依赖

**上游（被本模块消费）**

- `pi/packages/coding-agent/src/config.ts`：数据目录布局（`extensions/`、`skills/`、`prompts/`、`themes/`）。
- `pi/packages/coding-agent/src/core/settings-manager.ts`：`Settings` 字段（`packages`、`extensions`、`defaultProjectTrust`，✅ 已核实）。
- `pi-web` 的 `/api/plugins/**`、`/api/skills/**`、`/api/mcp/**`、`/api/subagents/**` 路由与设置页 UI：扩展/技能的**唯一**管理与开关入口（✅ §2.2）。

**下游（消费本模块）**

- 008-runtime-config：提供 `agentDir` 与目录树（本模块投放到其中）。
- 007-app-entry：启动序中调用投放（在目录树创建之后、宿主启动之前的合适位置）。
- 010-build-pipeline：把 `extensions/`、`skills/` 纳入随包分发的资源清单（⬜ 需与 `forge.config.ts` 的 `extraResource` 对齐）。
- `README.md`：说明壳投放内容与共享目录的影响。

**外部**

- `node:fs`（`cpSync`/`renameSync`/`existsSync`、临时目录）、`node:path`、Electron `app`（路径）。
