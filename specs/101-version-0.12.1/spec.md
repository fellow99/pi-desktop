# 101 — 版本更新：0.12.1（version）功能规格

> **Module:** version ｜ **Status:** Implementing ｜ **Last Updated:** 2026-10-15
> **上游基线:** pi v1.2.0（Branch_v1.2.0）· pi-web v0.12.1（Branch_v0.12.1）
> **需求编号:** 101-version-0.12.1 ｜ **需求名称:** 版本更新：0.12.1
> **Git 分支:** 不改动（在 `pi-desktop` 当前分支 `main` 上直接产出并提交，见 §4.1 / plan D2）
> **规划依据:** `docs/工程规划.md` §1.2、§7（零上游改动）、§8.1（流水线）、§8.5（CI/发布）、§9.1（验收）、§11.1（风险）；`specs/011-release-update/`
> **关联文档:** [`../011-release-update/spec.md`](../011-release-update/spec.md)（发布与更新模块）、`docs/发布与更新.md`（操作手册）、`docs/构建验证记录.md`（轮次台账）
> **同型参考:** `pi-desktop-hos/specs/101-version-0.12.1/`（同一需求在鸿蒙版，本规格仅取其结构，不沿用其设备侧结论）

## 1. 目的

把 `pi-desktop` 从已交付的 `0.11.1` **收敛为 `0.12.1`**：

1. 上游双基线升级并固化：`pi` `v1.1.0` → **`v1.2.0`**、`pi-web` `v0.11.1` → **`v0.12.1`**（两者均已在
   上游侧打 tag + 建分支，本工程只引用，不新建、不切换分支）；
2. 本工程**清干净中间产物**，从零重跑流水线，证明「只有源码 + 上游 tag」即可复现产物（§4.2）；
3. 对**补丁集**在 `pi-web v0.12.1` 上重新评估：**确需**才生成并登记，否则给出「不需要 + 依据」（§4.3）；
4. 版本号 `package.json.version` 从 `0.11.1` 升到 **`0.12.1`**，并在所有对外可见处同步（§4.4）；
5. 走仓库自身的可复现流水线**重新打包**（`npm ci → prepare-next → collect-pi → smoke → package`，§4.5）；
6. 在**打包态**跑通**基本功能**：设置 DeepSeek API Key → 创建工作区 → 一次真实对话（§4.6）；
7. **更新 GitHub Actions 工作流**的上游钉扎（tag + SHA）并与版本对齐（§4.7）；
8. 以 Conventional Commits 提交、打 tag **`v0.12.1`**（§4.8）。

## 2. 范围

**In scope**

- 上游基线锚定核对（`pi` / `pi-web` 的 tag、分支、`HEAD` 一致性）。
- 本工程中间文件 / 临时文件清理与清理清单。
- 补丁集在 `pi-web v0.12.1` 上的**重新评估**（需要则生成 + 登记，不需要则登记理由）。
- 版本号同步（`package.json`、`README.md` / `README_zh.md`、`docs/发布与更新.md` §1.1/§1.2、
  `docs/工程规划.md` 文档头 + §1.2 表、`specs/README.md`）+ `upstream.lock.json` 再生。
- 全流水线重跑（`npm ci → prepare-next → collect-pi → smoke → package`）与打包态启动取证。
- 打包态基本功能：设置 DeepSeek API Key → 创建工作区（测试目录）→ 一次真实对话。
- `ci.yml` / `release.yml` 的上游 tag + SHA 更新。
- 提交（Conventional Commits 前缀）+ 打 tag `v0.12.1`。

**Out of scope**

- 代码签名与公证（`docs/发布与更新.md` §7，Phase 3）。
- 自动更新 / 静默安装通道（`specs/011-release-update/` FR-011-010、FR-011-017）。
- 任何功能新增、UI 改动；本轮**只做版本收敛 + 验证**，不新增功能需求。
- 上游 `pi` / `pi-web` 源码的任何改动（两者只做 tag 引用）。
- 父工程 `pi-workspace`（子模块指针与父 README）——**明确不动**。

## 3. 上游事实（本规格前提，已核实）

| # | 事实 | 出处 / 核实方式 |
|---|---|---|
| U1 | `pi` tag **`v1.2.0`** 指向 commit `06a466935536f8c9bcacb2d5efc0fc021be1bdff`，对应分支 `Branch_v1.2.0`。 | 需求给定事实（tag/SHA/分支） |
| U2 | `pi-web` tag **`v0.12.1`** 指向 commit `f83b1a502f8e434555a7153fe08e1c135dd65ca9`，对应分支 `Branch_v0.12.1`。 | 需求给定事实 |
| U3 | 上一轮基线为 `pi` **v1.1.0**（`abe508e1b89912adde45528136c3221eb69acdd7`）+ `pi-web` **v0.11.1**（`e78372193bcbf7a1986072704753550008554ead`）。 | `upstream.lock.json`、`specs/README.md:6` |
| U4 | 本工程当前（升级前）`package.json` `version` = **`0.11.1`**。 | 读 `package.json:4` |
| U5 | 两个工作流均定义上游钉扎 env：`PI_REPO` / `PI_REF` / `PI_SHA` / `PI_WEB_REPO` / `PI_WEB_REF` / `PI_WEB_SHA`，且克隆按 tag 后断言 commit SHA（fail-visible）。 | `ci.yml:22-27`、`release.yml:30-35`（`PI_REF: v1.1.0` / `PI_SHA: abe508e1…` / `PI_WEB_REF: v0.11.1` / `PI_WEB_SHA: e7837219…`） |
| U6 | `upstream.lock.json` 记录两侧 commit 与 `baseline` 块 `{ pi: 'v1.1.0 (Branch_v1.1.0)', piWeb: 'v0.11.1 (Branch_v0.11.1)' }`；`scripts/pin-upstream.mjs:77` 硬编码同名字符串。 | 读 `upstream.lock.json`、`scripts/pin-upstream.mjs:77` |
| U7 | 打包流水线：`npm ci` → `node scripts/prepare-next.mjs` → `node scripts/collect-pi.mjs` → `node scripts/smoke-desktop.mjs`（门禁）→ `npx --no-install electron-forge package`（= 仓库 `npm run package`，其 `prepackage` 钩子会重跑 prepare-next + collect-pi）。 | `package.json:14,24`、`docs/发布与更新.md` §2 |
| U8 | 工作流用 `npm ci` + `cache-dependency-path: package-lock.json`（仓库使用 npm，lockfile 为 `package-lock.json`）。 | `ci.yml`、`docs/发布与更新.md` §3.1 |
| U9 | 本工程当前**没有 `patches/` 目录**；`docs/工程规划.md` §1.2 与 `docs/发布与更新.md` 记载「本版必需补丁 **0 条**」。 | `ls patches` 无此目录、`docs/工程规划.md:94` |
| U10 | 构建机系统 Node 为 **24.7.0**；运行时为 Electron **43.7.9**（Node **24.21.0** / Chromium **150.0.7871.250** / ABI **148**）；上游声明 `engines.node >= 22.19.0`。 | 需求给定事实、`README_zh.md:168` |
| U11 | 既有日志轮次为 `logs/20261012-0/`、`logs/20261013-0/`；本轮日志目录为 **`logs/20261015-1/`**（`logs/` 不入库，见 `.gitignore`）。 | `ls logs/`、`.gitignore` |
| U12 | 需同步版本/基线的文档：`README.md:15-16`、`README_zh.md:13-14`、`docs/发布与更新.md:8,20,31`、`docs/工程规划.md:8,87`、`specs/README.md:5-6`。 | 读各文件对应行 |

## 4. 需求条目

> 只追加不修订；MUST / MUST NOT / SHOULD / MAY。Plan 逐条回引（见 `plan.md` §3、§6）。
> 条目编号沿用同型需求口径 `FR-ver-<三位数>`。

### 4.1 上游固化与分支纪律

- **FR-ver-001**（MUST）：`pi` 必须处于 tag `v1.2.0` 对应 commit `06a46693…` 且在 `Branch_v1.2.0` 上；
  `pi-web` 必须处于 tag `v0.12.1` 对应 commit `f83b1a50…` 且在 `Branch_v0.12.1` 上。本条为**核对项**。
- **FR-ver-002**（MUST NOT）：本需求**不得改动任何 git 分支**（不新建、不切换、不重命名），
  不执行 `git init`；仅允许在 `pi-desktop` **当前分支**上提交本工程文件。
- **FR-ver-003**（MUST NOT）：`pi` / `pi-web` 工作树不得出现**未提交改动**（否则「基于 tag」不成立）。
- **FR-ver-004**（MUST）：允许在 scratch 生成 **detached 临时工作树**（`git worktree add --detach`）
  用于补丁评估 / 再生；该工作树必须在收尾前移除，且不得改变 `../pi-web` 的 checkout 状态。

### 4.2 清理

- **FR-ver-005**（MUST）：构建前必须清理本工程全部**中间文件与临时文件**：构建输出
  （`.vite/`、`dist/`、`out/`、Forge 缓存）、组装产物（`pi-dist/`、`pi-dist.tar.gz`、`pi-dist.version`、
  `pi-dist.sha256`）、脚本临时目录（`.collect-pi-tmp/`、`.collect-runtime-tmp/`）以及本轮之外的**旧阶段日志**
  （`logs/20261015-1/` 本轮日志保留）。
- **FR-ver-006**（MUST）：清理必须是**可复现的**——即清理后仅靠「源码 + 上游 tag」重跑流水线即可产出
  等价产物；不得依赖任何被删掉的中间态。
- **FR-ver-007**（MUST NOT）：不得删除源码、配置、文档、`resources/`、`assets/`、`specs/`、`docs/`、
  `scripts/`（这些是交付物，不是中间文件）。

### 4.3 补丁集

- **FR-ver-008**（MUST）：必须在 `pi-web v0.12.1` 的 pristine 树上**逐条评估**补丁必要性，对**每一个**
  候选（含既有「0 条」结论的复议 + 本轮因上游升级新产生的缺口）给出「需要 / 不需要 + 依据」。
- **FR-ver-009**（MUST）：对**确需保留**的补丁，必须按 `v0.12.1` **重新生成并登记**
  （独立 detached worktree 导出、不含 lockfile、不含二进制、UTF-8/LF），并写明接入点。
- **FR-ver-010**（MUST）：若本轮结论为**不需要任何补丁**，必须把该结论与**复现方式**
  （如何验证「不需要」）写回登记处；**MUST NOT** 为了「看起来做了工作」引入无依据补丁。
- **FR-ver-011**（MUST）：补丁若引入，应用必须**语义可校验**，且 `prepare-next.mjs` 的
  「幂等应用 → 反向 → SHA-256 还原断言」流程不变。

### 4.4 版本号

- **FR-ver-012**（MUST）：`package.json` 的 `version` 必须为 **`0.12.1`**，且是**唯一权威版本来源**
  （tag、Release 名称、应用内显示都由它推导，见 FR-011-021）。
- **FR-ver-013**（MUST）：版本号必须在**所有对外可见处**同步，不得残留旧值：
  `package.json`、`README.md`、`README_zh.md`、`docs/工程规划.md` 文档头与 §1.2 上游基线行、
  `specs/README.md` 技术栈行与上游基线行。
- **FR-ver-014**（MUST）：`docs/发布与更新.md` §1.1（单一版本源）与 §1.2（与上游版本的关系）必须更新为
  `0.12.1` 与 `pi v1.2.0` / `pi-web v0.12.1`。
- **FR-ver-015**（MUST）：历史记录类文档（`docs/构建验证记录.md` 的历史轮次、`docs/桌面能力清单.md` 的历史轮次、
  `specs/012-branding/test-cases.md` 的历史实测值）**保留**当时的版本号，不得回改。

### 4.5 构建与打包

- **FR-ver-016**（MUST）：必须从**清理后的工作树**跑完流水线，且
  ① `npm ci` 成功（`package-lock.json` 一致）、② `node scripts/prepare-next.mjs` 成功、
  ②′ `node scripts/collect-pi.mjs` 产出 `pi-dist.tar.gz` + SHA-256 marker、③ `node scripts/smoke-desktop.mjs`
  **0 FAIL**（门禁）、④ `npx --no-install electron-forge package` 产出打包目录。
- **FR-ver-017**（MUST）：必须**显式记录**「字面要求 `pnpm i && npm run package` 改为仓库自身可复现流水线」
  这一偏差及其理由（与 `ci.yml` / `release.yml` 的 `npm ci` + `cache-dependency-path: package-lock.json` 一致；
  pnpm 会产生分叉的 `pnpm-lock.yaml`）。见 plan D7。
- **FR-ver-018**（MUST）：打包产物内必须含 `resources/pi-dist.tar.gz` + `resources/pi-dist.version` +
  图标资源（`extraResource`），且包内 `pi-dist.tar.gz` 的 SHA-256 与 `pi-dist.version` 一致。
- **FR-ver-019**（MUST）：产物必须能启动到「就绪」——打包态启动取证到 Next 就绪、`[ready]` 探测通过、
  加载 Pi Web UI；二次启动 marker 一致时跳过解压（幂等）。

### 4.6 基本功能

- **FR-ver-020**（MUST）：必须在打包态通过 UI（或同源 API）设置 DeepSeek 的 API KEY
  为**需求方指定的 DeepSeek API KEY（完整值不得入库；取证件里只出现脱敏形态 `sk-dc5……296c`）** —— 需求方于 2026-10-15 明确指定改用该 key（工程小节原给的 `sk-e32……a17f` 经直连 `api.deepseek.com` 实测为 **HTTP 401 invalid**），并证明该配置**落到用户数据目录**；**取证文件必须脱敏**，
  不得落盘完整密钥。
- **FR-ver-021**（MUST）：必须创建**一个工作区**，其目录为**测试目录**，并证明该目录真实存在。
- **FR-ver-022**（MUST）：必须在该工作区**完成一次真实对话**，取证到：请求发出 → 模型流式返回 →
  会话落盘（JSONL）→ UI 显示回复文本。
- **FR-ver-023**（MUST）：对话必须使用**真实网络**（非 mock）。若因网络 / 凭据不可用而失败，
  必须记录为**缺陷**并给出根因分层（网络 / 凭据 / 上游），**不得改判为「通过」**。

### 4.7 GitHub Actions 工作流

- **FR-ver-024**（MUST）：`ci.yml` 的 env 必须更新为 `PI_REF: v1.2.0` /
  `PI_SHA: 06a466935536f8c9bcacb2d5efc0fc021be1bdff` 与 `PI_WEB_REF: v0.12.1` /
  `PI_WEB_SHA: f83b1a502f8e434555a7153fe08e1c135dd65ca9`。
- **FR-ver-025**（MUST）：`release.yml` 的 env 必须做与 `ci.yml` **相同**的 4 处更新。
- **FR-ver-026**（MUST）：两个工作流「按 tag 克隆上游 + 断言 commit SHA（不一致即 `exit 1`）」的
  **fail-visible** 语义必须保留，且 tag / SHA 必须与 FR-ver-001 的基线一致。
- **FR-ver-027**（MUST NOT）：不得为「切到 pnpm」而改动工作流的包管理器与缓存配置（继续 `npm ci` +
  `cache-dependency-path: package-lock.json`），不得引入 `pnpm-lock.yaml`。

### 4.8 提交与发布

- **FR-ver-028**（MUST）：提交信息必须符合 **Conventional Commits** 前缀
  （`feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert`），**不得使用其它前缀**
  （例如 `development:`、`testing:`、`code-review:` 一律不用）。
- **FR-ver-029**（MUST NOT）：不得提交构建产物 / 中间文件（`pi-dist*`、`out/`、`logs/`、`upstream.lock.json`
  按 `.gitignore` 处理），不得提交任何密钥（DeepSeek Key 明文、`PI_WEB_PASSWORD`）。
- **FR-ver-030**（MUST）：验证通过后必须打 tag **`v0.12.1`**，且指向本需求最后一次提交；**不改动任何分支**。

## 5. 验收标准

| 编号 | 验收条件（必须全部满足） | 判定方式 |
|---|---|---|
| AC-01 | `pi` / `pi-web` 均在指定 tag 对应 commit 上，工作树干净 | `git rev-parse` / `git status` |
| AC-02 | 未改动任何 git 分支（执行前后分支列表一致） | 前后 `git branch` 对比 |
| AC-03 | 清理清单全部命中，且 `git status` 不出现被误删的交付物 | 清理输出 + `git status` |
| AC-04 | 补丁候选逐条有结论；需要则已按 v0.12.1 生成并登记，不需要则已登记理由 | 文档审阅 +（如适用）`git apply --check` |
| AC-05 | `package.json.version == "0.12.1"`，且所有对外可见处无 `0.11.1` 残留（历史文档除外） | grep + 读文件 |
| AC-06 | `upstream.lock.json` 的 commit 与 baseline 块已更新为 v1.2.0 / v0.12.1 | 读文件（`node scripts/pin-upstream.mjs` 再生） |
| AC-07 | 流水线全绿：`npm ci` / prepare-next / collect-pi 成功；`smoke-desktop` **0 FAIL** | 脚本退出码 |
| AC-08 | `electron-forge package` 产出打包目录，包内含 `pi-dist.tar.gz` + `pi-dist.version`（SHA-256 一致） | 产物核对 |
| AC-09 | 打包态启动到「就绪」，加载 Pi Web UI；二次启动幂等跳过解压 | 打包态日志 |
| AC-10 | DeepSeek API Key 设置成功且落用户数据目录（取证脱敏） | 同源 API 读回 |
| AC-11 | 工作区创建成功且目录真实存在 | `ls -la` / API |
| AC-12 | 一次对话成功且回复文本可取回（会话 JSONL + UI） | SSE / 会话 JSONL |
| AC-13 | `ci.yml` / `release.yml` 的 `PI_REF` / `PI_SHA` / `PI_WEB_REF` / `PI_WEB_SHA` 均为新基线值，且 SHA 断言保留 | grep + 读文件 |
| AC-14 | 提交前缀全部符合 Conventional Commits；无密钥 / 产物入库 | `git log` + `git show --stat` |
| AC-15 | tag `v0.12.1` 已创建，且指向本需求最后一次提交 | `git tag -l` / `git describe` |

## 6. 约束与风险

| # | 约束 / 风险 | 处置 |
|---|---|---|
| C1 | **不改动 git 分支** | 全程只读上游；`pi-desktop` 在既有 `main` 上提交。**不新建 `Branch_v0.12.1`**（FR-ver-002）。 |
| C2 | 构建机系统 Node 为 24.7.0，而门禁/运行时是 Node 24.21.0 | 门禁脚本与流水线应尽量对齐运行时 Node；若用系统 Node 跑 `smoke-desktop` 必须在记录中标注版本差异。 |
| C3 | 上游 `pi-web` v0.11.1 → v0.12.1 改动面可能较大 | 补丁评估 + 「应用 → 反向 → SHA-256 还原」断言（FR-ver-008/011）。 |
| C4 | `pi` / `pi-web` 工作树可能脏 | 每步先 `git status --porcelain` 预检；脏即停止并登记（FR-ver-003）。 |
| C5 | 首启解压数万文件耗时长（参考 `docs/构建验证记录.md` 轮次 2） | 打包态取证超时按 ≥60 s 计；二次启动走 marker 快路径。 |
| C6 | 真实网络 / DeepSeek 凭据不可用 | 按 FR-ver-023 记缺陷并分层，**不得改判通过**。 |
| C7 | 密钥泄漏进日志 / 提交 | 取证文件脱敏（只留前后 4 位）；**分文件 `git add`**，永不 `git add -A`（FR-ver-029）。 |
| C8 | pnpm 与 npm 双 lockfile 漂移 | 采用仓库自身 `npm ci` 流水线并显式登记偏差（FR-ver-017 / FR-ver-027）。 |
| C9 | 误删交付物（清理过度） | 清理后立即 `git status` 复核（FR-ver-007）。 |

## 7. 不做（明确排除）

- 不新增功能、不改 UI、不改上游代码。
- 不签名、不公证、不做自动 / 静默更新。
- 不申请发布证书、不提交应用市场。
- 不把 `pnpm-lock.yaml` 引入仓库（保持 npm 单一包管理器）。
- 不动父工程 `pi-workspace` 的子模块指针与父 README。
- 不回溯修改历史轮次的版本号与实测记录（FR-ver-015）。
