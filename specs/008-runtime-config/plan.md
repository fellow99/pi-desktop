# 008 — 运行时配置（runtime-config）技术实现方案

> **Module:** 008-runtime-config（运行时配置）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应规格:** [`./spec.md`](./spec.md)
> **架构基线:** `docs/工程规划.md` §4.6（Q6）、§6.3、§8.1 ③、§11.2 O6、§11.3.4

## 1. 技术上下文

### 1.1 运行时环境

- **运行位置**：Electron 主进程；在 007 的启动序中位于「设置解析 → 目录树/模板」段（宿主启动之前）。
- **编译产物**：`src/main/settings.ts` → `.vite/build/main.js`（✅ 已实现，110 行）。
- **数据落点**：
  - 壳层设置：`<userData>/pi-desktop-settings.json`（`SETTINGS_FILE_NAME`）。
  - 数据目录：`shared` → `os.homedir()/.pi/agent`；`app` → `<userData>/pi-agent`。
- **模板源**：`config/{settings.json,mcp.json,trust.json}`（构建期进 `pi-dist`，运行期作为对照/投放源）。

### 1.2 依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `electron`（`app`） | 内置 | `app.getPath('userData')`、`app.getAppPath()`（模板源定位） |
| `node:os` | 内置 | `homedir()`（共享模式的 `~` 展开） |
| `node:fs` | 内置 | 设置读写、目录创建、模板存在性判定 |
| `node:path` | 内置 | 路径拼接（跨平台） |
| `src/main/constants.ts` | 本项目（✅ 已存在） | `SETTINGS_FILE_NAME`、`LOG_DIR_NAME` |
| `src/main/logger.ts` | 本项目（✅ 已存在） | `logInfo/logWarn/describeError` |
| 上游 `pi` | 源码参考 | `src/config.ts`（目录布局）、`core/settings-manager.ts`（字段语义） |

> 无第三方依赖。

## 2. 宪法合规检查

| 原则（`docs/工程规划.md` §3 / §4.6 / §8.1） | 状态 | 说明 |
|---|---|---|
| 零上游改动（§3 原则 1、§7） | ✅ | 只读上游字段语义，不修改 `../pi` 任何文件 |
| 只写装配代码（§3 原则 3） | ✅ | 只做「解析路径 + 建目录 + 缺失时写模板」 |
| 决策 Q6（默认共享、可切私有）（§4.6） | ✅ | FR-008-001、FR-008-002 与既定决策一致 |
| 失败可见（§3 原则 5） | ✅ | 设置损坏/目录创建失败/模板写入失败都留痕（WARN），不静默 |
| 退出不删数据（§8.3、005 FR-005-019） | ✅ | 本模块同样不做删除；只做「仅缺失时写入」 |
| 安全：不替用户做信任决定 | ✅ | FR-008-010（保守信任、不覆盖既有 `trust.json`） |
| 平台差异显式化（§3 原则 6、§9.3） | ✅ | 路径走 `node:path` + `homedir()`；未改写 `HOME`/`TMPDIR`（与 HOS 的关键差异，§4.6） |
| 代码质量：strict TS、无 `as any`、严禁空 catch | ⬜ | 待复核 `src/main/settings.ts` 的实现（当前 `catch` 均有 WARN，符合） |

> 合规结论：策略与安全项 ✅；⬜ 项集中在「`trust.json` 物化」与「模板字段集合」。

## 3. 研究结论

### 3.1 关键决策与理由

| 决策 | 理由 | 对应 FR |
|---|---|---|
| 默认 `shared`（`~/.pi/agent`） | 桌面版价值 = 直接用上已有 pi 环境（✅ Q6） | FR-008-001 |
| 私有模式 `<userData>/pi-agent` | 隔离/企业/多环境退路（✅ Q6） | FR-008-002 |
| 切换需重启、**不**热切换 | 宿主启动早期就要 `PI_CODING_AGENT_DIR`；热切换会产生「配置来自 A、会话写到 B」的半状态 | FR-008-005 |
| 壳层设置独立文件（`pi-desktop-settings.json`） | 不污染上游 `settings.json`；壳层设置有独立 version 便于迁移 | FR-008-003 |
| 预置模板「仅缺失时写入」 | 一旦存在即属于用户；不覆盖是唯一安全策略 | FR-008-008 |
| `trust.json` 保守默认、绝不写「始终信任」 | 信任是安全决策；壳层不得代做（也避免首启静默信任全部项目） | FR-008-010 |
| 模板源放 `config/` 并随包分发 | 与 §8.1 ③/附录 B 一致；模板可审阅、可 diff | FR-008-009 |
| 不改写 `HOME`/`USERPROFILE`/`TMPDIR` | 桌面无沙箱；改写会破坏用户环境与 CLI 一致性（❌ 不复用 HOS 的沙箱做法） | FR-008-006 |

### 3.2 上游源码核实与实现现状（✅ / 🔶 / ⬜ / ⚠️）

| # | 事实 | 依据 |
|---|---|---|
| U1 | pi 的状态目录可用 `PI_CODING_AGENT_DIR` 重定向；目录内含 `settings.json`/`mcp.json`/`trust.json`/`extensions/`/`skills/`/`prompts/`/`themes/`/`sessions/` 等 | ✅ `pi/packages/coding-agent/src/config.ts`、§2.1、§4.6 |
| U2 | `settings.json` 的字段语义（`packages`、`extensions`、`defaultProjectTrust`；后者注释标注默认 `"ask"`、且为全局设置） | ✅ `pi/packages/coding-agent/src/core/settings-manager.ts` |
| U3 | **已实现现状**：`loadSettings()`（缺省/损坏回退 `shared` + WARN）、`saveSettings()`、`resolveAgentDir()`（§4.3 两分支）、`ensureAgentDirTree()`（6 个子目录 + `agentDir` 自身，失败 WARN 不阻塞）、`materializePresetTemplates()`（`settings.json` = `{ packages: [], defaultProjectTrust: 'ask' }`；`mcp.json` = `{ mcpServers: {} }`；**仅缺失时写入**） | ✅ `src/main/settings.ts:34,47,59,69,93` |
| U4 | ⚠️ **与规划 §8.1 ③ 的差异**：规划写「`config` 预置模板（→ `pi-agent/{settings.json,mcp.json,trust.json}` 默认值）」，而当前实现为**内联字符串**，只物化 `settings.json` / `mcp.json`，**不物化 `trust.json`**，且未读取 `config/` 源目录（仅把 `presetDir` 写进日志）。处置：本规格按规划要求 `config/` 提供三份模板（FR-008-009/010），实现侧需在 Phase 1 补齐「读 `config/` 模板 + `trust.json` 决策」，或按 P0-2 结论登记「`trust.json` 不物化」的依据。 | ✅ `src/main/settings.ts:69-90` vs `docs/工程规划.md` §8.1 ③、附录 B |
| U5 | `pi` 是否会在首启自行创建 `trust.json`（以及 `models.json`/`auth.json`） | ⬜ P0-2 探针：临时 `PI_CODING_AGENT_DIR` + 一次启动 → 观察生成文件清单 |
| U6 | 预置模板与用户既有文件的合并策略（不覆盖 vs 补缺键） | ⬜ §11.2 O6（本版选「不覆盖」） |
| U7 | ⚠️ R7：CLI 与 pi-web 并发写同一会话不受支持 → 共享模式下需 UI/文档提示 | ✅ §11.1 R7、§4.6 |

## 4. 数据模型

### 4.1 实体

| 实体 | 字段 | 存储 |
|---|---|---|
| `ShellSettings` | `{ version: 1; agentDirMode: 'shared' \| 'app' }` | `<userData>/pi-desktop-settings.json` |
| 数据目录解析结果 | `agentDir: string` | 由 `resolveAgentDir(settings)` 计算（不落盘） |
| 模板条目 | `{ name: 'settings.json' \| 'mcp.json' \| 'trust.json'; writePolicy: 'if-missing-only' }` | 源 `config/`；目标 `<agentDir>/` |
| 目录树 | `['extensions','skills','prompts','themes','agents','sessions']` | `<agentDir>/` 下 |

### 4.2 状态机（模式与文件）

```
settings absent            → defaults(shared)（不写盘，直到用户显式保存）
settings corrupt/invalid   → defaults(shared) + WARN（下次保存时重写）
settings {mode:'app'}      → agentDir = <userData>/pi-agent（重启后生效）
settings {mode:'shared'}   → agentDir = ~/.pi/agent

模板物化：target missing → 写入；target exists → 跳过（logInfo「保留已有文件」）
trust.json：⬜ 是否物化由 P0-2 结论决定；无论结论如何，已存在时绝不覆盖
```

### 4.3 校验规则

- `agentDirMode` 合法值仅 `'shared'` / `'app'`；其它任何值（含 `undefined`、非字符串）→ `'shared'`（当前实现即此语义）。
- `version` 不匹配当前已知版本 → 仍按已知字段解析并回退未知字段（不抛错）。
- 路径校验：`agentDir` 必须为绝对路径；相对路径或空串 → 视为解析失败（⬜ 当前实现未校验，建议在 Phase 1 补断言）。
- 写入策略：任何目标文件已存在 → 跳过（不比较内容、不做合并）。

## 5. 接口契约

### 5.1 提供接口（本模块导出，✅ 已实现）

| 导出 | 签名 | 说明 |
|---|---|---|
| `loadSettings()` | `() => ShellSettings` | 读设置；缺失/损坏回退默认 |
| `saveSettings(next)` | `(s: ShellSettings) => void` | 写设置（失败只 WARN） |
| `resolveAgentDir(settings)` | `(s: ShellSettings) => string` | 解析数据目录（FR-008-001/002） |
| `materializePresetTemplates(agentDir, presetDir)` | `(a: string, p: string) => void` | 仅缺失时写入模板（FR-008-008～010） |
| `ensureAgentDirTree(agentDir)` | `(a: string) => void` | 创建必需子目录（FR-008-007） |

### 5.2 消费接口

| 来源 | 符号 |
|---|---|
| `electron.app` | `getPath('userData')`、`getAppPath()`、`isPackaged` |
| `node:os` / `node:fs` / `node:path` | `homedir` / 文件读写与 `mkdirSync` / `join` |
| `src/main/logger.ts` | `logInfo/logWarn/describeError` |
| `config/`（构建期产物） | `settings.json`、`mcp.json`、`trust.json` 模板 |

### 5.3 事件协议

- **无 IPC 通道**：本模块不向渲染层暴露任何接口；模式切换入口（设置 UI）属 Phase 2（当前含在文档/关于信息与手动编辑配置文件层面）。⬜ 若在 v1 提供 UI 入口，其通道必须走 006 的白名单流程（规格追加）。

## 6. 实现策略

### 6.1 架构模式

**纯函数 + 幂等副作用函数**：`resolveAgentDir()` 为纯函数（输入设置、输出路径）；`loadSettings()`/`saveSettings()`/`materializePresetTemplates()`/`ensureAgentDirTree()` 为幂等副作用函数，失败只降级为 WARN（启动不可被设置问题阻断）。当前 `src/main/settings.ts` 已按此形态落地（✅ 110 行）。

### 6.2 关键算法

- **模式解析**：`raw.agentDirMode === 'app' ? 'app' : 'shared'`（白名单式，任何异常值都落回默认）。
- **路径解析**：`app` → `join(app.getPath('userData'), 'pi-agent')`；`shared` → `join(homedir(), '.pi', 'agent')`。
- **模板物化**：对每个条目判 `existsSync(target)` → 存在即 `logInfo('保留已有文件：' + target)` 并跳过；不存在则写入模板内容（Phase 1 改为从 `config/` 读取，见 §3.2 U4）。
- **目录创建**：`for (dir of dirs) mkdirSync(dir, { recursive: true })`，逐个 `try/catch` + WARN（单点失败不阻塞其余目录）。

### 6.3 错误处理

- 设置读取失败（IO/JSON）：`logWarn` + 返回默认（不抛）。
- 设置写入失败：`logWarn`（不抛）——用户在 UI 上的保存失败必须另行提示（⬜ 若 v1 无 UI 入口则仅日志）。
- 目录创建失败：`logWarn`（继续），并在启动日志的阶段时间线中可见。
- 模板写入失败：`logWarn`（不阻塞启动）。
- **严禁空 catch**：当前实现的所有 catch 都有 `logWarn`/`return` 语义（✅ 已核对 `src/main/settings.ts`）。

### 6.4 性能

- 全部为启动期一次性 IO：1 次设置读、≤6 次 `mkdir`、≤3 次 `existsSync`（命中多数情况下 0 次写入）。
- 共享模式下 `~/.pi/agent` 可能已含数千会话文件，但本模块**只建目录，不遍历**（尾随由 004 负责，且按目录增量 处理）。

## 7. 测试考量

| 层次 | 方式 | 覆盖需求 |
|---|---|---|
| 静态 | `npm run typecheck` | 全部 |
| 单元 | `resolveAgentDir()`：`shared`/`app` 两分支 + `homedir` 桩 | FR-008-001、FR-008-002 |
| 单元 | `loadSettings()`：文件缺失 / 合法 / 非法 JSON / 非法字段（`agentDirMode: 'x'`） | FR-008-004 |
| 单元 | `materializePresetTemplates()`：目标缺失 → 写入；目标存在 → 字节不变（哈希比较） | FR-008-008、FR-008-010 |
| 单元 | `ensureAgentDirTree()`：全新目录 → 全建；只读父目录 → WARN 且不抛 | FR-008-007 |
| 探针（P0-2） | 临时 `PI_CODING_AGENT_DIR` 启动一次，观察 pi 自行生成了哪些文件（决定 `trust.json` 是否物化） | FR-008-010、§3.2 U5 |
| 集成 | 共享模式启动后：既有会话/模型可见（与 CLI 一致）；私有模式启动后：目录为 `<userData>/pi-agent` | FR-008-001、FR-008-002 |
| 负向 | 把 `<userData>/pi-desktop-settings.json` 设为只读后保存 → 断言不抛、有 WARN | FR-008-003、FR-008-004 |
| 安全 | 断言启动日志中出现 `agentDir` 路径但不出现凭据 | FR-008-014 |

## 8. 文件清单

| 文件 | 用途 | 状态（2026-10-12 复核） |
|---|---|---|
| `src/main/settings.ts` | 设置读写 + 路径解析 + 目录树 + 模板物化 | ✅ 已存在（110 行；`materializePresetTemplates()` 仍为**内联字符串**实现） |
| `config/settings.json` | 预置模板（最小默认值，保留 `defaultProjectTrust: 'ask'`） | ✅ 已存在 |
| `config/mcp.json` | 预置模板（空 `mcpServers`） | ✅ 已存在 |
| `config/trust.json` | 预置模板（保守信任；是否物化待 P0-2） | ⬜ **未见**（需按 FR-008-009 补齐或按探针结论登记「不物化」） |
| `src/main/constants.ts` | `SETTINGS_FILE_NAME`、`LOG_DIR_NAME` | ✅ 已存在（56 行） |
| `src/main/logger.ts` | WARN/INFO 落盘 | ✅ 已存在（86 行） |
| `scripts/collect-pi.mjs`（010） | 把 `config/` 模板纳入 `pi-dist` 组装（§8.1 ③） | ✅ 已存在（287 行；⬜ 需核对其是否真的收 `config/`） |
| `src/main/index.ts`（007） | 启动早期调用本模块 | ✅ 已存在（327 行） |

> ⚠️ §3.2 U4 登记的差异在 2026-10-12 复核中依然成立：模板仍是内联字符串（未读 `config/` 源目录）、`trust.json` 未物化。

> ⚠️ 与规划的差异（§3.2 U4）：实现目前为内联字符串且不含 `trust.json`；Phase 1 需补齐 `config/` 读取路径或登记不物化 `trust.json` 的依据。

## 9. 与规格交叉引用

| 规格需求 | 实现落点 |
|---|---|
| FR-008-001…006（模式与默认值 / 落盘 / 容错 / 需重启 / 不改写 HOME） | `src/main/settings.ts` 的 `loadSettings`/`saveSettings`/`resolveAgentDir`（✅）+ §3.1 决策表 |
| FR-008-007（目录树） | `ensureAgentDirTree()`（✅ `settings.ts:93`） |
| FR-008-008…011（仅缺失时物化 / `config/` 三模板 / 保守信任 / 不预设扩展清单） | `materializePresetTemplates()`（✅ `settings.ts:69`）+ §3.2 U4 的补齐项 |
| FR-008-012…013（壳专用扩展/技能落点） | 目录树包含 `extensions/`、`skills/`（✅）+ 201-plugin-runtime |
| FR-008-014…015（日志 / 重启提示） | §6.2 + §7（安全用例） |
| §5 验收场景 S1–S7 | §7 测试考量（S1/S2 集成；S3/S4/S5/S6 单元；S7 由 002/001 的未改写 HOME 断言覆盖） |
