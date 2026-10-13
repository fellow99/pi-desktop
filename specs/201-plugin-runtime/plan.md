# 201 — 扩展投放（plugin-runtime）技术实现方案

> **Module:** 201-plugin-runtime（扩展投放）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应规格:** [`./spec.md`](./spec.md)
> **架构基线:** `docs/工程规划.md` §0.3（Q7）、§2.2、§6.2、§6.3、§9.3、§11.2（无对应 O 项）

## 1. 技术上下文

### 1.1 运行时环境

- **运行位置**：Electron 主进程；在 007 启动序中的「agent 目录树」之后、宿主启动之前的投放步骤。
- **投放目标**：`<agentDir>/extensions/<name>/`、`<agentDir>/skills/<name>/`（`agentDir` 由 008 的 `resolveAgentDir()` 给出；可能位于 `~/.pi/agent` 或 `<userData>/pi-agent`）。
- **投放来源**：仓库 `extensions/`、`skills/`（开发态）或 `process.resourcesPath/{extensions,skills}`（打包态，⬜ 需加入 `extraResource`）。
- **编译产物**：投放逻辑随 `src/main/*.ts` 进 `.vite/build/main.js`；壳资产是**数据**（不参与构建，只做复制）。

### 1.2 依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `electron.app` | 内置 | `getAppPath()` / `process.resourcesPath` 定位壳资产源 |
| `node:fs` | 内置 | `existsSync`、`cpSync`、`renameSync`、`rmSync`、`readFileSync`（版本标记） |
| `node:path` | 内置 | 路径拼接 |
| `src/main/settings.ts`（008） | 本工程（✅ 已存在） | `resolveAgentDir()`、`ensureAgentDirTree()`（保证目标父目录存在） |
| `src/main/logger.ts` | 本项目（✅ 已存在） | 投放清单与结论留痕 |
| `src/main/constants.ts` | 本项目（✅ 已存在） | 产品名等常量（壳命名空间前缀可在此登记） |

> 无第三方依赖；不使用符号链接（打包 `derefSymlinks: true`，✅ `forge.config.ts:23`）。

## 2. 宪法合规检查

| 原则（`docs/工程规划.md` §3 / §0.3 / §6.3 / §7） | 状态 | 说明 |
|---|---|---|
| 不另建市场工程（Q7、§6.3） | ✅ | 无市场/索引/安装链路/便携运行时（FR-201-001…003） |
| 零上游改动（§3 原则 1、§7） | ✅ | 不触碰上游插件机制与发现规则（FR-201-004） |
| 沿用上游 UI（§2.2） | ✅ | 扩展/技能的开关与配置全走上游设置页 |
| 只写装配代码（§3 原则 3） | ✅ | 只做「复制到落点 + 记录结论」 |
| 失败可见（§3 原则 5） | ✅ | 投放清单与跳过原因落日志（FR-201-017、FR-201-018） |
| 数据安全 / 用户意图优先（§4.6 精神） | ✅ | 不覆盖用户内容、不无条件恢复被用户删除/禁用的内容（FR-201-011、FR-201-012） |
| 平台差异显式化（§3 原则 6） | ✅ | 路径用 `node:path`；不依赖符号链接 |
| 代码质量：strict TS、无 `as any`、严禁空 catch | ⬜ | 代码已落地（2026-10-12 复核），待人工评审 |

> 合规结论：边界与数据安全项 ✅；⬜ 项为两个待定机制（命名空间形式、删除后重投策略）。

## 3. 研究结论

### 3.1 关键决策与理由

| 决策 | 理由 | 对应 FR |
|---|---|---|
| 不建市场、不内置运行时 | 上游 UI 已具备插件/技能/MCP 管理；桌面有原生 npm/git（✅ Q7、§6.3） | FR-201-001…003 |
| 投放到 `<agentDir>`（而不是应用目录） | 上游在 `PI_CODING_AGENT_DIR` 下发现扩展/技能；数据目录可切换（Q6） | FR-201-005、FR-201-006 |
| 真实文件复制（不用符号链接） | 打包已 `derefSymlinks`；复制在三平台行为一致，且共享目录下不引入链接语义 | FR-201-007 |
| 壳命名空间 + 版本标记 | 区分「壳管理」与「用户自建」，使「可更新」与「不可覆盖」两种策略可共存（⬜ 形式待定） | FR-201-008、FR-201-010 |
| 用户意图优先（不无条件重投） | 否则用户在上游 UI 的禁用/删除会被静默推翻（产品信任问题） | FR-201-012 |
| 只用上游既有 `settings.json` 字段 | 新增自定义字段会被上游忽略且造成「配置看起来生效其实没有」的错觉（✅ 字段已核实：`packages`/`extensions`） | FR-201-014…016 |
| 临时目录 + 改名 | 避免半成品目录被上游扫描到（一次坏投放会污染用户环境） | FR-201-013 |

### 3.2 上游/参考核实（✅ / 🔶 / ⬜ / ⚠️）

| # | 事实 | 依据 |
|---|---|---|
| U1 | 上游 UI 已内置 Plugins / Skills / MCP / Agents 管理：`pi-web` 有 `/api/plugins/**`、`/api/skills/**`、`/api/mcp/**`、`/api/subagents/**` 与对应设置页 | ✅ §2.2（约 90 条路由清单） |
| U2 | pi 的状态目录布局含 `extensions/`、`skills/`、`prompts/`、`themes/`，可用 `PI_CODING_AGENT_DIR` 重定向 | ✅ `pi/packages/coding-agent/src/config.ts`、§2.1 |
| U3 | `settings.json` 的 `Settings` 接口含 `packages?: PackageSource[]`、`extensions?: string[]`（本地扩展文件路径或目录）、`defaultProjectTrust?: DefaultProjectTrust`（默认 `"ask"`、全局设置） | ✅ `pi/packages/coding-agent/src/core/settings-manager.ts` |
| U4 | 桌面**恢复**了 HOS 上被剥夺的能力：原生 `bash` 工具、MCP stdio、OAuth 回环、`git`/worktree、`rg`/`fd`、在线安装扩展/技能 | ✅ §9.3（因此**不需要** HOS 的 102-harmony-js-tools 那类壳扩展顶替，也不需要 PL1「仅本地源」限制） |
| U5 | dsh 的市场工程（`201-dsh-market`）在本工程被**剔除**；其对应的 `runtime.ts`（便携 Node/pnpm）也剔除 | ✅ §6.3 |
| U6 | 扩展发现规则：是「扫描 `extensions/` 目录」，还是「必须登记进 `settings.json.extensions`」 | ⬜ **Phase 0/1 探针**：临时 `PI_CODING_AGENT_DIR` → 只放目录 vs 只写 `settings.json` → 观察上游加载结果 |
| U7 | 上游是否有「禁用」状态的持久化位置（用于 FR-201-012 的判定） | ⬜ 探针：在上游 UI 禁用一次扩展 → 观察 `settings.json`/`trust.json`/目录标记的写入 |
| U8 | 壳资产是否随 v1 出货（可选档） | ⬜ 产品决定（§6.4 标注「可选档」） |

## 4. 数据模型

### 4.1 实体

| 实体 | 字段 | 说明 |
|---|---|---|
| `ShellAsset` | `{ kind: 'extension' \| 'skill'; name: string; version: string; sourcePath: string }` | 包内壳资产（`version` 来自目录内标记文件或随包清单） |
| `ManagedMarker` | `{ managed: true; version: string; deployedAt: string }` | 目标目录内的壳管理标记（⬜ 文件名待定，例如 `.pi-desktop-managed.json`） |
| `DeployResult` | `{ name: string; kind: string; action: 'written' \| 'updated' \| 'skipped'; reason?: string }` | 单个资产的结论 |
| 投放清单 | `{ agentDir: string; results: DeployResult[] }` | 日志与「关于/诊断」的输入 |

### 4.2 状态机（单个资产）

```
source missing                  → skipped('source-missing')（WARN；不阻塞）
target absent                   → 复制到临时目录 → rename → written
target present + managed + 同版本 → skipped('up-to-date')
target present + managed + 旧版本 → 临时目录 → 替换 → updated
target present + not managed     → skipped('user-owned')（不改动）
用户已删除（记录为已投放而目标缺失） → ⬜ 按 FR-201-012 的策略处置（不无条件重投）
```

### 4.3 校验规则

- `agentDir` 必须存在且可写；不可写 → 全部资产 `skipped('target-unwritable')` + WARN（启动继续）。
- 命名空间判定：目录名前缀匹配 **或** 目标目录内存在 `ManagedMarker`（二者任一）；两者都不满足即视为「用户自建」。
- 临时目录必须位于同一父目录（保证 `renameSync` 原子且不跨卷）。
- 复制排除：不复制 `node_modules/`（若壳资产带了依赖，应改为在投放后由上游/用户自行安装，或直接不产出该形态的壳扩展 —— ⬜ 本版不设计依赖型壳资产）。

## 5. 接口契约

### 5.1 提供接口（本模块导出）

| 导出 | 签名 | 说明 |
|---|---|---|
| `listShellAssets()` | `() => ShellAsset[]` | 枚举包内壳资产（扫描 `extensions/`、`skills/`） |
| `deployShellAssets(agentDir)` | `(a: string) => DeployResult[]` | 幂等投放，返回逐项结论 |
| `describeDeployedAssets(agentDir)` | `(a: string) => { name: string; version: string }[]` | 供「关于/诊断」展示 |

### 5.2 消费接口（本模块依赖）

| 来源 | 符号 |
|---|---|
| `electron.app` | `getAppPath()`、`process.resourcesPath` |
| `node:fs` / `node:path` | 复制、改名、标记读写、路径拼接 |
| 008-runtime-config | `resolveAgentDir()`（目标根）、`ensureAgentDirTree()`（父目录） |
| `src/main/logger.ts` | `logInfo/logWarn/describeError` |

### 5.3 事件协议

- **无 IPC 通道**：投放全在主进程完成，不经渲染层；上游 UI 通过它自己的 API 读取 `agentDir` 下的内容（数据面在 SSE/HTTP，不在本模块）。
- 日志事件：`[pi-desktop] deploy <action> <kind>/<name> → <target>`（统一格式便于 grep）。

## 6. 实现策略

### 6.1 架构模式

**清单式投放（declarative deploy）**：先 `listShellAssets()` 得到清单，再对每项独立执行「判定 → 动作 → 记录」。每项独立意味着单项失败不影响其它项（部分成功优于全失败），且结论可逐项审计。

### 6.2 关键算法

- **资产枚举**：读取源根下的第一层目录；每个目录视为一个资产；`version` 从目录内标记文件（如 `package.json` 的 `version` 字段或专用标记）读取，缺失则用 `'0'` 并记录 WARN。
- **原子投放**：`cpSync(src, tmp, { recursive: true })` → `renameSync(tmp, target)`；目标已存在且需更新时，先把旧目录改名为 `*.bak` 再 `rename(tmp, target)`，成功后再删 `.bak`（失败则回滚改名）—— 避免「删了旧的、新的没放上」。
- **用户意图判定**（FR-201-012，⬜ 机制待定）：候选方案 ① 壳层在 `<userData>/pi-desktop-deployed.json` 记录「已投放且未观察到用户删除」；若目标缺失而记录存在，则视为用户删除 → 不重投，只 WARN。方案 ② 直接读上游 `settings.json` 的启用/禁用字段（依赖 U7 探针结论）。⬜ 定案前实现方案 ①（不依赖未验证的上游字段）。
- **接线**（FR-201-014）：若探针 U6 表明「必须登记进 `settings.json.extensions` 才会加载」，则只做「读-改-写」的**追加**（保留既有条目顺序与内容），并在写入前备份原文件。

### 6.3 错误处理

- 源缺失 → `skipped('source-missing')` + WARN（不阻塞）。
- 目标不可写 / 磁盘满 → `skipped('target-unwritable' | 'io-error')` + WARN（不阻塞）。
- 中途失败 → 清理临时目录（`rmSync(tmp, {force:true})`），**不留半成品**（FR-201-013）。
- **严禁空 catch**：每个 catch 都必须产出 `DeployResult.reason` 并留痕。

### 6.4 性能

- 壳资产应远小于 `pi-dist`（KB 级）；复制为毫秒级。
- 只在「目标缺失或版本不同」时才复制；幂等启动几乎零 IO（几次 `existsSync` + 一次标记读取）。
- 不做目录扫描之外的遍历（不递归扫描用户扩展目录内容）。

## 7. 测试考量

| 层次 | 方式 | 覆盖需求 |
|---|---|---|
| 静态 | `npm run typecheck` | 全部 |
| 单元 | `deployShellAssets()`：目标缺失（写入）/ 同版本（跳过）/ 旧版本（更新）/ 用户自建同名（不改动）四种输入（用临时目录） | FR-201-009…011、FR-201-013 |
| 单元 | 命名空间判定：有标记 / 无标记 / 前缀匹配 的组合真值表 | FR-201-008、FR-201-011 |
| 单元 | 用户删除后重启：模拟「记录存在 + 目标缺失」→ 断言不重投 | FR-201-012 |
| 探针（**Phase 0/1**） | U6：临时 `PI_CODING_AGENT_DIR` 下「只放目录」vs「只写 `settings.json.extensions`」，观察上游是否加载 | FR-201-005、FR-201-014 |
| 探针 | U7：在上游 UI 禁用/删除一次扩展，观察落盘的禁用状态位置 | FR-201-012 |
| 集成 | 数据目录切换（shared → app）后投放落点随动；上游 UI 中可见 | FR-201-006 |
| 安全/边界 | 目标不可写（只读目录）→ 断言 WARN + 启动继续 | FR-201-018 |
| 负向 | 包内壳资产目录缺失 → 断言不抛、日志有 WARN | FR-201-018 |

## 8. 文件清单

| 文件 | 用途 | 状态（2026-10-12 复核） |
|---|---|---|
| `src/main/plugin-runtime.ts`（⬜ 命名待定，或并入 `settings.ts` 的投放逻辑旁） | 壳资产枚举 + 幂等投放 + 用户意图判定 | ⬜ **未见**（本模块为可选档；工作区中无投放实现） |
| `extensions/` | 壳专用扩展源目录（可空） | ⬜ **未见**（按 §7 约束，v1 可只落框架不随附具体资产） |
| `skills/` | 壳专用技能源目录（可空） | ⬜ **未见** |
| `config/settings.json`（008） | 上游既有字段的预置模板（不覆盖用户文件） | ✅ 已存在（`config/mcp.json` 亦已存在） |
| `src/main/settings.ts`（008） | `resolveAgentDir()` / `ensureAgentDirTree()` | ✅ 已存在（110 行） |
| `src/main/index.ts`（007） | 启动序中调用投放 | ✅ 已存在（327 行；⬜ 尚未见投放调用） |
| `forge.config.ts` | 把 `extensions/`、`skills/` 纳入 `extraResource`（⬜ 需新增条目） | ✅ 已存在（73 行；`extraResource` 仍未含 `extensions/`、`skills/`） |
| `README.md` | 说明壳投放内容与共享目录下的影响 | ✅ 已存在（⬜ 需核对是否已写壳投放章节） |

> 结论：本模块在 2026-10-12 复核时**尚无实现落地**（符合「可选档」的定位）；其前置（`agentDir` 解析、目录树、上游 UI 与 `settings.json` 字段）均已就位。

## 9. 与规格交叉引用

| 规格需求 | 实现落点 |
|---|---|
| FR-201-001…004（不建市场 / 不内置运行时 / 零改动） | §2 合规表 + §3.1 决策表（Q7、§6.3） |
| FR-201-005…008（投放落点 / 跟随 agentDir / 真实复制 / 命名空间） | §1.1 投放目标 + §4.3 校验规则 + §6.2 |
| FR-201-009…013（幂等 / 更新 / 不覆盖用户 / 尊重删除 / 原子） | §4.2 状态机 + §6.2「原子投放」「用户意图判定」 |
| FR-201-014…016（只用上游字段 / 不覆盖 / 不静默改信任） | §3.1 决策表 + §6.2「接线」+ 008 FR-008-010 |
| FR-201-017…019（清单日志 / 失败不阻塞 / 诊断展示） | §5.1 `describeDeployedAssets()` + §6.3 |
| §5 验收场景 S1–S6 | §7 测试考量（S1/S2/S5 集成；S3/S4 单元与探针；S6 边界核对） |
