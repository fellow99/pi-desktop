# 008 — 运行时配置（runtime-config）功能规格

> **Module:** 008-runtime-config（运行时配置）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应方案:** [`./plan.md`](./plan.md)
> **实现落点:** `src/main/settings.ts`（模板源目录 `config/`）
> **规划依据:** `docs/工程规划.md` §4.6（决策 Q6）、§6.3、§8.1 ③、§11.2 O6、§11.3.4

## 1. 模块概述

### 1.1 目的

运行时配置模块的职责是：**决定 pi 的数据目录（`PI_CODING_AGENT_DIR`）落在哪里、把壳层设置持久化、并在首启把目录树与保守的预置模板就位**。

数据目录策略是本工程的产品核心之一（✅ 决策 Q6）：**默认共享 `~/.pi/agent`** —— 桌面版的价值正是「直接用上你已有的 pi 环境」（凭据、会话、扩展、MCP 配置立即可见）；同时提供 `<userData>/pi-agent` 作为隔离/企业场景的退路。

### 1.2 解决的问题

- **两套环境分裂**：若默认使用应用私有目录，用户会发现「CLI 里配好的模型/凭据在桌面版里不存在」，需要重新登录；这是桌面版最容易被诟病的一点。
- **目录缺失导致功能静默失效**：pi 的扩展/技能/会话/prompt 目录缺失时相关功能会静默不工作（没有目录就没有扫描结果）。
- **模板覆盖用户文件**：壳层预置配置一旦覆盖用户已有的 `settings.json`/`mcp.json`，会直接抹掉用户的模型与 MCP 配置。
- **信任被代做决定**：`trust.json`（项目信任）代表安全决策，壳层**不得**替用户写成「始终信任」。
- **热切换的半状态**：数据目录在宿主启动早期就要交给 pi-web，进程内热切换会导致「配置来自 A、会话写到 B」的半残状态，因此必须显式要求重启。

### 1.3 范围

**包含**

- 壳层设置文件 `<userData>/pi-desktop-settings.json`（`version` + `agentDirMode`）的读写与容错。
- 数据目录解析：`shared` → `os.homedir()/.pi/agent`；`app` → `<userData>/pi-agent`。
- 必需子目录树的创建。
- 预置模板（`config/{settings.json,mcp.json,trust.json}`）的**仅缺失时**物化。
- 壳专用扩展/技能的落点约定（实现属 201-plugin-runtime）。
- 切换需重启的语义与提示。

**不包含**

- 宿主启动与环境变量注入（读取本模块结果的实现属 001-host）。
- 壳专用扩展/技能的具体投放与开关（→ 201-plugin-runtime）。
- 上游 `settings.json` 的完整 schema 校验与 UI 编辑（沿用上游 UI；本模块只给最小默认值）。
- 迁移/合并用户既有配置（不覆盖即不迁移；⬜ O6 的合并策略评估见 §7）。

## 2. 用户故事

- 作为已有 `pi` CLI 环境的用户，我希望桌面版开箱就用 `~/.pi/agent`，模型、凭据、会话、扩展立刻可见，不需要重新配置。
- 作为企业/多环境用户，我希望能把数据目录切到应用私有目录做隔离，并且切完重启即生效。
- 作为用户，我不希望壳层覆盖我已经改过的 `settings.json` / `mcp.json`——只在我没有这些文件时给一份最小默认值。
- 作为安全敏感用户，我不希望壳层替我决定项目信任（默认必须是「询问」）。
- 作为用户，我希望切换数据目录时被明确告知「应用内会话/凭据与 CLI 的可见性会变化」。

## 3. 功能需求

动作词：**MUST** 必须满足；**MUST NOT** 禁止；**SHOULD** 建议；**MAY** 可选。

### 3.1 数据目录策略

- FR-008-001：系统 MUST 以 `agentDirMode: 'shared'` 为默认值，解析出的数据目录为 `~/.pi/agent`（`os.homedir()`，不做路径改写）。
- FR-008-002：系统 MUST 支持 `agentDirMode: 'app'`，解析出的数据目录为 `<userData>/pi-agent`。
- FR-008-003：系统 MUST 把壳层设置持久化到 `<userData>/pi-desktop-settings.json`，内容含 `version` 与 `agentDirMode` 两个字段。
- FR-008-004：设置文件缺失、JSON 损坏或字段非法时，系统 MUST 回退默认值（`shared`）并记录 WARN，**MUST NOT** 阻塞启动。
- FR-008-005：切换数据目录 MUST 要求重启应用才生效；系统 MUST NOT 在同一进程内热切换，并 MUST 在界面/文档中提示「切换后应用内会话/凭据与 CLI 的可见性会变化」。
- FR-008-006：系统 MUST NOT 改写 `HOME`/`USERPROFILE`/`TMPDIR`（桌面无沙箱；与 HOS 版的关键差异）。

### 3.2 目录树与预置模板

- FR-008-007：系统 MUST 在启动宿主**之前**创建数据目录必需的子目录（至少 `extensions/`、`skills/`、`prompts/`、`themes/`、`agents/`、`sessions/`）；单个目录创建失败 MUST 记录 WARN 而不阻塞启动。
- FR-008-008：系统 MUST 仅当目标文件**不存在**时物化预置模板（`settings.json`、`mcp.json`）；**MUST NOT** 覆盖用户已有文件（也不做「补缺键」式的部分合并）。
- FR-008-009：系统 MUST 在 `config/` 提供三份预置模板的默认值（`config/settings.json`、`config/mcp.json`、`config/trust.json`），且模板 MUST 随包分发（构建期进 `pi-dist`，见 010 与 §8.1 ③）。
- FR-008-010：`trust.json` 模板 MUST 保持保守信任语义（等价 `defaultProjectTrust: 'ask'`），**MUST NOT** 预置「始终信任」；且 MUST NOT 覆盖已存在的 `trust.json`（信任决定不得由壳层代做）。
- FR-008-011：`settings.json` 模板 MUST 只包含最小可用默认值；**MUST NOT** 预设具体的扩展包清单（`packages`）或扩展路径（`extensions`），以免与用户既有配置冲突。⬜ 模板键名的最终集合待 P0-2 探针（观察上游首启写入的字段）后定稿。

### 3.3 壳专用扩展/技能落点

- FR-008-012：系统 MUST 约定壳专用扩展与技能的落点为 `<agentDir>/extensions/` 与 `<agentDir>/skills/`（具体投放与开关属 201-plugin-runtime）。
- FR-008-013：系统 MUST NOT 在 `settings.json` 中把壳专用扩展路径写死为用户不可编辑的形态；壳层扩展的存在性由投放物化保证（不依赖用户配置文件）。

### 3.4 可观测性

- FR-008-014：系统 MUST 在启动日志中记录「实际生效的 `agentDirMode` 与 `agentDir` 路径」，**MUST NOT** 记录凭据或配置内容。
- FR-008-015：系统 MUST 在切换模式的入口处给出「需重启」的显式提示（不得静默保存后无反馈）。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| `ShellSettings` | 壳层设置 | `{ version: 1; agentDirMode: 'shared' \| 'app' }` → `<userData>/pi-desktop-settings.json` |
| `AgentDirMode` | 数据目录模式 | `'shared'`（默认）/ `'app'` |
| 数据目录（`agentDir`） | `PI_CODING_AGENT_DIR` 的取值 | `shared` → `~/.pi/agent`；`app` → `<userData>/pi-agent` |
| 目录树 | 必需子目录集合 | `extensions`、`skills`、`prompts`、`themes`、`agents`、`sessions` |
| 预置模板集 | 模板源与目标 | 源：`config/{settings.json,mcp.json,trust.json}`；目标：`<agentDir>/同名文件`（仅缺失时写入） |

## 5. 验收场景

### 场景 S1：默认共享目录

- Given 用户机器上已有 `~/.pi/agent`（含凭据与会话）
- When 首次启动应用
- Then 应用使用 `~/.pi/agent`；Pi Web UI 能看到既有会话与已配置模型；不需要重新登录

### 场景 S2：切换到应用私有目录

- Given 用户把 `agentDirMode` 改为 `app`
- When 用户重启应用
- Then 生效后的 `agentDir` = `<userData>/pi-agent`，且目录树与模板已物化；日志记录新模式；界面在保存时已提示「需重启」

### 场景 S3：不覆盖用户文件

- Given `<agentDir>/settings.json` 已存在且被用户改过（自定义模型/MCP）
- When 应用启动
- Then 该文件内容逐字节不变（壳层只记录「保留已有文件」）

### 场景 S4：缺失时补齐

- Given `<agentDir>` 为空目录
- When 首次启动
- Then 生成 `settings.json` 与 `mcp.json` 的最小默认值（以及 `config/` 中定义的 `trust.json` 模板，若判定需要物化），且子目录树齐备

### 场景 S5：设置文件损坏容错

- Given `<userData>/pi-desktop-settings.json` 内容为非法 JSON
- When 应用启动
- Then 使用默认 `shared` 模式启动、记录 WARN、不阻塞；文件在下次保存时被重写为合法内容

### 场景 S6：不越权决定信任

- Given `config/trust.json` 提供模板
- When 首启物化
- Then 信任语义为保守（等价 `ask`）；若 `trust.json` 已存在则不被覆盖

### 场景 S7：不污染用户环境变量

- Given 应用启动完成
- When 检查 `HOME` / `USERPROFILE` / `TMPDIR`
- Then 三者与启动前一致（未被壳层改写）

## 6. 非功能需求

- **数据安全**：预置模板绝不覆盖用户文件；退出/启动流程不删除用户数据（与 005 FR-005-019 一致）。
- **可维护性**：目录解析与模板物化抽成纯函数/幂等函数，便于单测（输入 `userData`/`homedir`，输出路径）。
- **容错**：设置文件损坏、目录不可写、模板写入失败都只降级为 WARN，不阻塞启动。
- **性能**：设置读取与目录创建为毫秒级；模板物化只在文件缺失时发生。
- **可移植性**：路径拼接一律用 `node:path`；`~` 展开用 `os.homedir()`（不使用 shell 展开）。
- **透明性**：实际生效的数据目录必须在日志与「关于」信息中可见（用户能自己核对是否共享）。

## 7. 假设与约束

- **假设（✅ 决策 Q6、§11.3.4 复核项）**：默认共享 `~/.pi/agent` 是本产品想要的默认（此处登记为待最终复核事项，但实现按此默认落地）。
- **假设（✅ 源码核实）**：pi 的全部状态在一个目录内，可经 `PI_CODING_AGENT_DIR` 重定向；目录内含 `settings.json`、`models.json`、`auth.json`、`mcp.json`、`trust.json`、`extensions/`、`skills/`、`prompts/`、`themes/`、`bin/`、`sessions/`（`pi/packages/coding-agent/src/config.ts`、§2.1）。
- **约束**：⚠️ R7 —— `pi-web` 与 `pi` CLI **并发写同一会话 JSONL 不受支持**；共享模式下必须在界面与文档中明示「不要与 CLI 对同一会话并发写入」，并提供「切到应用私有目录」的一键退路（本模块提供该设置，提示由 UI/文档承担）。
- **约束**：⬜ `trust.json` 是否应由壳层物化尚需实测：`pi` 可能自行在首启创建它。探针 P0-2：清空一个临时 `PI_CODING_AGENT_DIR` 后启动一次，观察生成的文件清单与内容（只观察、不写入）。在结论出来前，**不得**把它写成「一定会写」或「一定不写」。
- **约束**：⬜ O6（预置模板与用户既有文件的合并策略）—— 本版明确选「不覆盖」；「补缺键」方案需先验证再改（§11.2 O6）。
- **约束**：模板键名以「源码即真理」为准（`pi/packages/coding-agent/src/core/settings-manager.ts` 的 `Settings` 接口）；每次上游升级须复核。✅ 已核实的字段：`packages`、`extensions`、`defaultProjectTrust`（注释标注默认 `"ask"`、全局设置）。

## 8. 依赖

**上游（被本模块消费）**

- `pi/packages/coding-agent/src/config.ts`：数据目录与文件布局（重定向变量 `PI_CODING_AGENT_DIR`）。
- `pi/packages/coding-agent/src/core/settings-manager.ts`：`settings.json` 的字段语义（`packages` / `extensions` / `defaultProjectTrust`）。

**下游（消费本模块）**

- 001-host：`agentDir` → `PI_CODING_AGENT_DIR`。
- 002-window / 003-tray / 006-preload：`openSessionDir` 与「关于」信息的目标路径。
- 004-notification：会话尾随目录（`<agentDir>/sessions/`）。
- 007-app-entry：启动早期调用解析与物化。
- 201-plugin-runtime：壳专用扩展/技能的落点。

**外部**

- Electron `app.getPath('userData')`、`node:os`（`homedir`）、`node:fs`。
