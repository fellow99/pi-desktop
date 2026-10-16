# 101 — 版本更新：0.12.1（version）技术方案

> **Module:** version ｜ **Status:** Implementing ｜ **Last Updated:** 2026-10-15
> **上游基线:** pi v1.2.0（Branch_v1.2.0）· pi-web v0.12.1（Branch_v0.12.1）
> **需求编号:** 101-version-0.12.1
> **规格依据:** [`spec.md`](./spec.md)（FR-ver-001 … FR-ver-030）
> **任务拆解:** [`./tasks.md`](./tasks.md) ｜ **测试用例:** [`./test-cases.md`](./test-cases.md)
> **架构基线:** `docs/工程规划.md` §1.2、§7、§8.1、§8.5、§9.1、§11.1；`docs/发布与更新.md` §1–§3；`specs/011-release-update/plan.md`

## 1. 方案总览

本需求**不引入新架构**，是一次「上游升级 → 收敛 → 复现 → 验证」：核心是把两个上游 tag 换到新基线、
把版本号收敛到 `0.12.1`、从零重跑仓库自己的流水线并做打包态基本功能验证，最后提交 + 打 tag。

```
S0 锚定核对 (pi v1.2.0 / pi-web v0.12.1)
        │
        ▼
S1 清理中间产物 ───────────────┐
        │                      │（清理后立即 git status 复核交付物未误删）
        ▼                      │
S2 补丁评估 (pi-web v0.12.1) ──┤  结论：需要 → 生成+登记；不需要 → 登记理由+复现方式
        │                      │
        ▼                      │
S3 版本号 0.12.1 + 文档同步 + upstream.lock 再生
        │                      │
        ▼                      │
S4 流水线重建  npm ci → prepare-next → collect-pi → smoke → package
        │                      │
        ▼                      │
S5 打包态启动 + 基本功能 (Key / 工作区 / 一次对话)
        │                      │
        ▼                      │
S6 GitHub Actions 钉扎更新 (ci.yml / release.yml)
        │                      │
        ▼                      │
S7 提交 (Conventional Commits) → tag v0.12.1
```

依赖顺序：S1 必须在 S4 之前；S2 依赖 S0（需 pristine v0.12.1）；S3 与 S2 可并行；S5 依赖 S4；S6 独立于构建；
S7 收尾。

## 2. 与 011 / 0.11.1 的差异（本版只写变化）

| 项 | 0.11.1（现状） | 0.12.1（本版） | 依据 |
|---|---|---|---|
| 上游 `pi` | `v1.1.0` / `abe508e1…` | **`v1.2.0` / `06a4669355…`**（`Branch_v1.2.0`） | FR-ver-001 |
| 上游 `pi-web` | `v0.11.1` / `e78372193b…` | **`v0.12.1` / `f83b1a502f…`**（`Branch_v0.12.1`） | FR-ver-001 |
| `package.json.version` | `0.11.1` | **`0.12.1`** | FR-ver-012 |
| workflow 钉扎 env | `PI_REF: v1.1.0` / `PI_WEB_REF: v0.11.1` | **`v1.2.0` / `v0.12.1` + 新 SHA** | FR-ver-024/025 |
| 补丁 | 0 条（`patches/` 目录不存在） | 复议；**确需才加**，否则登记「不需要 + 依据」 | FR-ver-008/009/010 |
| 结束动作 | 提交 | 提交 + **tag `v0.12.1`** | FR-ver-030 |
| 打包命令口径 | 字面曾写 `pnpm i && npm run package` | 改为仓库自身 `npm ci …` 流水线并**显式登记偏差** | FR-ver-017 |

## 3. 关键决策

### D1 — 版本号单一来源（落实 FR-ver-012/013/014）

`package.json.version` 是**唯一权威版本来源**（`specs/011-release-update/spec.md` FR-011-021）：
tag、Release 名称、应用内「关于」显示都从它推导。本轮把它从 `0.11.1` 改为 **`0.12.1`**，
然后**据此同步所有对外可见处**（见 D5 表），不引入 `versionCode` 之类本工程没有的概念（那是鸿蒙版的）。

### D2 — 不改动任何 git 分支（落实 FR-ver-002）

- `pi` / `pi-web`：**只读**；为补丁评估允许 `git worktree add --detach <scratch> <tag>`（FR-ver-004）——
  它**新增** 一个 detached worktree，不切换、不新建分支、不改动 `../pi-web` 主工作树；收尾 `git worktree remove --force`。
- `pi-desktop`：在既有分支 **`main`** 上提交。**不新建 `Branch_v0.12.1`**，不切分支。
- 提交前 / 后各记一次 `git branch -a`，供 AC-02 比对。

### D3 — 补丁评估结论与口径（落实 FR-ver-008/009/010/011）

| 步 | 动作 |
|---|---|
| 1 | 在 scratch `git worktree add --detach <scratch>/pw-v0.12.1 v0.12.1`（pristine v0.12.1 树）。 |
| 2 | 逐条核对「是否存在必须改上游才成立的本工程行为」：进程内宿主内部入口（规划 R1）、认证/轮换契约（R10）、
`node-pty` 原生件完整性（012 品牌化的构建期守卫已覆盖）、`pi-dist` marker 语义（本工程自持，不改上游）。 |
| 3 | 结论写回 `specs/101-version-0.12.1/plan.md §3`（本表）+ 任何适用的登记处：
**预期为「不需要任何补丁」**（对齐 `docs/工程规划.md` §1.2「0 条必需」），此时必须给出**如何验证「不需要」**
的可复现方式（即在 pristine v0.12.1 上跑 `npm ci → prepare-next → collect-pi → smoke` 全绿）。 |
| 4 | 若第 3 步暴露出真实缺口（上游确需改动），才在 `<scratch>/pw-v0.12.1` 上生成补丁：
`git diff`（不含 lockfile / 二进制 / CRLF）→ 登记到 `patches/v0.12.1/` → 在 `prepare-next.mjs` 接入应用目录，
并保留「幂等应用 → 反向 → SHA-256 还原」断言（FR-ver-011）。 |

> **纪律**：本轮**默认 0 补丁**；引入补丁必须有可复现的失败证据，不得因「看起来更完整」而加（FR-ver-010）。

### D4 — 清理清单（落实 FR-ver-005/006/007）

**删（中间/临时产物）**

| 目标 | 说明 |
|---|---|
| `.vite/`、`dist/` | Vite 构建输出（`.gitignore` 已忽略） |
| `out/` | Forge 打包输出（本机当前已存在 `out/`） |
| `pi-dist/`、`pi-dist.tar.gz`、`pi-dist.version`、`pi-dist.sha256` | `collect-pi` 组装产物（本机当前已存在 `pi-dist/`） |
| `.collect-pi-tmp/`、`.collect-runtime-tmp/` | 脚本临时目录 |
| Forge 缓存 / `node_modules/.cache` | 构建缓存 |

**不删（交付物）**：`src/`、`resources/`、`assets/`、`config/`（如有）、`scripts/`、`specs/`、`docs/`、
`README*.md`、`.github/`、`package.json`、`package-lock.json`、`forge.config.ts`、`vite.*.ts`、`tsconfig*.json`、
`logs/`（含历史轮次，仅 `logs/20261015-1/` 为本轮新建并保留）。

**复核**：清理后立即 `git status --porcelain`，确认被删文件名**不出现在** tracked 列表（FR-ver-007 / C9）。

### D5 — 版本号 / 基线同步点（落实 FR-ver-013/014）

| # | 文件 | 动作 | 现址 |
|---|---|---|---|
| 1 | `package.json` | `version: 0.11.1` → `0.12.1` | `package.json:4` |
| 2 | `README.md` | 版本行 + 上游基线行（`pi v1.2.0` / `pi-web v0.12.1`） | `README.md:15-16` |
| 3 | `README_zh.md` | 版本行 + 上游基线行 | `README_zh.md:13-14` |
| 4 | `docs/发布与更新.md` | §1.1 唯一版本源（现写 `0.1.0`）、§1.2 上游基线与固定分支 | `:20,31`；文档头 `:8` |
| 5 | `docs/工程规划.md` | 文档头上游基线 `:8` + §1.2 关键结论表「上游基线」行 `:87` | `:8,87` |
| 6 | `specs/README.md` | 技术栈行 `:5` + 上游基线行 `:6` | `:5-6` |
| 7 | `upstream.lock.json` | `node scripts/pin-upstream.mjs` 再生（commit + `baseline` 块） | 生成物（`.gitignore` 忽略） |
| 8 | `scripts/pin-upstream.mjs` | `baseline:` 硬编码字符串 → `v1.2.0 (Branch_v1.2.0)` / `v0.12.1 (Branch_v0.12.1)` | `:77` |

> **保留历史值**（FR-ver-015）：`docs/构建验证记录.md` 历史轮次、`docs/桌面能力清单.md` 历史轮次、
> `specs/012-branding/test-cases.md` 的历史实测值（`0.11.1` 等）**不回改**。

### D6 — 工作流钉扎更新（落实 FR-ver-024/025/026/027）

两个工作流各 4 处 env 更新，`PI_REPO` / `PI_WEB_REPO` 不变：

| env | 旧 | 新 |
|---|---|---|
| `PI_REF` | `v1.1.0` | `v1.2.0` |
| `PI_SHA` | `abe508e1b89912adde45528136c3221eb69acdd7` | `06a466935536f8c9bcacb2d5efc0fc021be1bdff` |
| `PI_WEB_REF` | `v0.11.1` | `v0.12.1` |
| `PI_WEB_SHA` | `e78372193bcbf7a1986072704753550008554ead` | `f83b1a502f8e434555a7153fe08e1c135dd65ca9` |

落点：`ci.yml:23-27`、`release.yml:31-35`。**保留**「按 tag 克隆 + `test "$actual" = "$PI_SHA"` 断言」
（fail-visible，`ci.yml:47-58` / `release.yml:90-101`）。**不动** `npm ci` 与
`cache-dependency-path: package-lock.json`（FR-ver-027）。

### D7 — 打包命令：与字面要求的偏差（落实 FR-ver-016/017）

**字面要求**：`pnpm i && npm run package`。
**实际采用**（仓库自身可复现流水线）：

```
npm ci
node scripts/prepare-next.mjs          # ../pi-web：npm ci + next build + 平台裁剪
node scripts/collect-pi.mjs            # 组装 pi-dist + pi-dist.tar.gz + SHA-256 marker
node scripts/smoke-desktop.mjs         # 门禁（0 FAIL 才继续）
npx --no-install electron-forge package   # = npm run package；用 npx --no-install 直调以免 prepackage 重跑前两步
```

**理由**：

1. 仓库是 **npm** 工程（`package-lock.json`），`ci.yml` / `release.yml` 用 `npm ci` +
   `cache-dependency-path: package-lock.json`；改 pnpm 会引入分叉的 `pnpm-lock.yaml`，破坏 `npm ci` 的可复现锚点
   （FR-ver-027）。
2. `npm run package` 的 `prepackage` 钩子（`package.json:24`）会**重跑** `prepare-next + collect-pi`；
   为确保「清理 → prepare-next → collect-pi → smoke → package」顺序显式且 gate 在打包前生效，
   采用 `npx --no-install electron-forge package` 直调，与 `ci.yml` 对 `make` 的既有写法同型
   （`docs/发布与更新.md` §3.1「刻意绕过 premake 钩子」）。
3. 语义与字面要求**等价**（都产出 `npm run package` 的同一产物），且更贴合 CI。偏差**显式登记于本 D7 与 spec FR-ver-017**。

> 若坚持字面口令，等价可执行形式为：`npm ci && npm run package`（`prepackage` 会自动补 prepare-next + collect-pi）；
> 本 spec 的验收仍以「清理后流水线全绿 + 打包目录含 `pi-dist.*`」为准（AC-07 / AC-08），不绑定包管理器命令拼写。

### D8 — upstream.lock.json 再生（落实 FR-ver-013/AC-06）

`node scripts/pin-upstream.mjs` 读取 `../pi` / `../pi-web` 的 `git describe` / commit / branch，
写 `upstream.lock.json`。前提：`scripts/pin-upstream.mjs:77` 的 `baseline` 字符串先改到新基线，
使 lock 文件的 `baseline` 块与 commit 记录一致。该文件被 `.gitignore` 忽略（`:8`），仅作本地可复现证据。

## 4. 数据模型（本需求无运行时数据结构，仅版本/基线台账）

| 实体 | 字段 | 说明 |
|---|---|---|
| 版本 | `package.json.version` | 唯一权威来源，本版 `0.12.1` |
| 上游钉扎 | `{ pi: {ref, sha, branch}, piWeb: {ref, sha, branch} }` | tag + SHA + 分支三元组，映射到 workflow env 与 `upstream.lock.json` |
| baseline 块 | `{ pi, piWeb }`（字符串） | `"v1.2.0 (Branch_v1.2.0)"` / `"v0.12.1 (Branch_v0.12.1)"` |
| 清理项清单 | 见 D4 | 中间/临时产物集合 |

## 5. 接口契约

本需求不改代码接口；受影响的「契约」是构建期与 CI 期：

| 接口 | 载体 | 变更 |
|---|---|---|
| 上游钉扎 | `.github/workflows/{ci,release}.yml` env | 4 个 env 值（D6） |
| 版本 | `package.json.version` | `0.11.1` → `0.12.1`（D1） |
| 基线台账 | `scripts/pin-upstream.mjs` → `upstream.lock.json` | baseline 字符串 + 再生记录（D8） |
| 打包产物 | `out/`（含 `resources/pi-dist.tar.gz` + `pi-dist.version`） | 由流水线重建（D7） |

## 6. 实现策略（对 FR 的落点，逐条闭合）

| FR | 落点 |
|---|---|
| FR-ver-001…004 | §3 D2 + S0/S2 + `tasks.md` T01/T02/T03 |
| FR-ver-005…007 | §3 D4 + `tasks.md` T04/T05 |
| FR-ver-008…011 | §3 D3 + `tasks.md` T06/T07 |
| FR-ver-012…015 | §3 D1/D5 + `tasks.md` T08/T09/T10 |
| FR-ver-016…019 | §3 D7 + `tasks.md` T11/T12/T13 |
| FR-ver-020…023 | `tasks.md` T14/T15 + `test-cases.md` §C |
| FR-ver-024…027 | §3 D6 + `tasks.md` T16 |
| FR-ver-028…030 | `tasks.md` T17/T18 + `test-cases.md` §E |

## 7. 测试考量

| 层次 | 方式 | 覆盖需求 |
|---|---|---|
| 静态 | 版本/基线 grep、`npm run typecheck` | FR-ver-012/013/014 |
| 构建 | `npm ci` → prepare-next → collect-pi | FR-ver-016 |
| 门禁 | `node scripts/smoke-desktop.mjs`（0 FAIL） | FR-ver-016 |
| 打包 | `npx --no-install electron-forge package` + 包内 `pi-dist.*` 核对 | FR-ver-016/018 |
| 打包态运行 | 启动到就绪 + 二次启动幂等 | FR-ver-019 |
| 基本功能 | 打包态：设 Key → 建工作区 → 一轮对话（真实网络） | FR-ver-020/021/022/023 |
| 工作流 | grep env + YAML 结构核对（SHA 断言保留） | FR-ver-024/025/026/027 |
| 发布 | `git log` 前缀核对 + tag 指向核对 | FR-ver-028/029/030 |

> 全部用例与实测证据落点见 [`test-cases.md`](./test-cases.md)，证据目录 `logs/20261015-1/`。

## 8. 文件清单（本轮将被改动的文件）

| 文件 | 用途 | 现状 |
|---|---|---|
| `package.json` | `version` → `0.12.1` | 存在（`0.11.1`） |
| `README.md` / `README_zh.md` | 版本 + 上游基线行 | 存在（`0.11.1` / v1.1.0 / v0.11.1） |
| `docs/发布与更新.md` | §1.1 / §1.2 + 文档头基线 | 存在（`0.1.0` / v1.1.0 / v0.11.1） |
| `docs/工程规划.md` | 文档头 `:8` + §1.2 表 `:87` | 存在（v1.1.0 / v0.11.1） |
| `specs/README.md` | 技术栈行 + 上游基线行 | 存在（v1.1.0 / v0.11.1） |
| `scripts/pin-upstream.mjs` | `baseline` 字符串 `:77` | 存在（v1.1.0 / v0.11.1） |
| `.github/workflows/ci.yml` | env `:23-27` | 存在（v1.1.0 / v0.11.1） |
| `.github/workflows/release.yml` | env `:31-35` | 存在（v1.1.0 / v0.11.1） |
| `upstream.lock.json` | 再生（`.gitignore` 忽略） | 存在（v1.1.0 / v0.11.1） |
| `pi-desktop/specs/101-version-0.12.1/*` | 本规格 4 文件 | 本需求新增 |

> 若 D3 结论为「需要补丁」，则**额外**新增 `patches/v0.12.1/*.patch` 并改 `scripts/prepare-next.mjs` 的应用目录。

## 9. 与规格交叉引用

| 规格需求 | 实现落点 |
|---|---|
| FR-ver-001…004（锚定/分支/工作树/临时树） | §3 D2 + `tasks.md` T01–T03 |
| FR-ver-005…007（清理） | §3 D4 + `tasks.md` T04–T05 |
| FR-ver-008…011（补丁） | §3 D3 + `tasks.md` T06–T07 |
| FR-ver-012…015（版本号同步） | §3 D1/D5 + `tasks.md` T08–T10 |
| FR-ver-016…019（构建/打包/启动） | §3 D7 + `tasks.md` T11–T13 |
| FR-ver-020…023（基本功能） | `tasks.md` T14–T15 + `test-cases.md` §C |
| FR-ver-024…027（工作流） | §3 D6 + `tasks.md` T16 |
| FR-ver-028…030（提交/发布） | `tasks.md` T17–T18 + `test-cases.md` §E |
| `spec.md` §5 验收 AC-01…AC-15 | `test-cases.md` 各节（A/B/C/D/E） |
