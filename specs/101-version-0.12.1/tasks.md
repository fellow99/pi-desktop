# 101 — 版本更新：0.12.1（version）任务拆解

> **Module:** version ｜ **Status:** Implementing ｜ **Last Updated:** 2026-10-15
> **上游基线:** pi v1.2.0（Branch_v1.2.0）· pi-web v0.12.1（Branch_v0.12.1）
> **需求编号:** 101-version-0.12.1
> **规格依据:** [`spec.md`](./spec.md)（FR-ver-001 … FR-ver-030 / AC-01 … AC-15）
> **方案依据:** [`plan.md`](./plan.md)（D1 … D8）
> **证据目录:** `logs/20261015-1/`（`logs/` 不入库；证据文件必须脱敏，密钥只留前后 4 位）

## 1. 任务清单（依赖顺序）

> 每项含：**回引**（规格/方案）、**动作**（可执行步骤）、**完成判据**（可证伪）、**产出**（文件/证据）。
> 一切命令均在 `D:/pi-workspace/pi-desktop`（Bash `/d/pi-workspace/pi-desktop`）执行；`<scratch>` = 会话 scratch 目录。

### 阶段 1：上游锚定与分支纪律（T01–T03）

#### T01 — 上游双基线锚定核对
- **回引**：FR-ver-001、FR-ver-003；plan D2；AC-01
- **动作**：
  ```
  git -C ../pi      rev-parse HEAD
  git -C ../pi      describe --tags
  git -C ../pi      status --porcelain
  git -C ../pi      branch --show-current
  git -C ../pi-web  rev-parse HEAD
  git -C ../pi-web  describe --tags
  git -C ../pi-web  status --porcelain
  git -C ../pi-web  branch --show-current
  ```
- **完成判据**：`pi` HEAD = `06a466935536f8c9bcacb2d5efc0fc021be1bdff` 且在 `Branch_v1.2.0`；
  `pi-web` HEAD = `f83b1a502f8e434555a7153fe08e1c135dd65ca9` 且在 `Branch_v0.12.1`；两侧 `status --porcelain` 为空。
- **产出**：`logs/20261015-1/01-upstream-anchor.txt`

#### T02 — 记录分支快照（供 AC-02 比对）
- **回引**：FR-ver-002；plan D2；AC-02
- **动作**：`git -C ../pi branch -a`、`git -C ../pi-web branch -a`、`git -C . branch --show-current`
- **完成判据**：三份输出存盘；`pi-desktop` 当前分支为 `main`。
- **产出**：`logs/20261015-1/02-branch-before.txt`

#### T03 — 创建 detached 临时树（补丁评估用），收尾移除
- **回引**：FR-ver-004；plan D2/D3
- **动作**：
  ```
  git -C ../pi-web worktree add --detach <scratch>/pw-v0.12.1 v0.12.1
  ```
  收尾：`git -C ../pi-web worktree remove --force <scratch>/pw-v0.12.1` + `git -C ../pi-web worktree list`
- **完成判据**：临时树存在且 `rev-parse HEAD` = `f83b1a50…`；收尾后 `worktree list` 只剩主工作树，
  `../pi-web` checkout 状态未变（`branch --show-current` 仍为 `Branch_v0.12.1`）。
- **产出**：`logs/20261015-1/03-patch-worktree.txt`

### 阶段 2：清理（T04–T05）

#### T04 — 清理中间/临时产物
- **回引**：FR-ver-005、FR-ver-006；plan D4；AC-03
- **动作**（plan D4「删」清单）：
  ```
  rm -rf .vite dist out pi-dist pi-dist.tar.gz pi-dist.version pi-dist.sha256 \
         .collect-pi-tmp .collect-runtime-tmp node_modules/.cache
  ```
  保留 `logs/`（尤其本轮 `logs/20261015-1/`）、源码、`specs/`、`docs/`、`resources/`、`assets/`。
- **完成判据**：上述路径不存在；清理命令无「Permission denied」以外的报错。
- **产出**：`logs/20261015-1/04-cleanup.txt`

#### T05 — 清理复核（不误删交付物）
- **回引**：FR-ver-007；plan D4；AC-03
- **动作**：`git status --porcelain` + `git ls-files | head` 目视核对；确认删除的目标均为 `.gitignore` 覆盖的产物。
- **完成判据**：`git status --porcelain` 的相对 tracked 列表**不含**被删产物名；无源码/文档/资源被删。
- **产出**：`logs/20261015-1/05-git-status-after-clean.txt`

### 阶段 3：补丁评估（T06–T07）

#### T06 — 补丁候选逐条评估
- **回引**：FR-ver-008；plan D3；AC-04
- **动作**：在 T03 的 `<scratch>/pw-v0.12.1` 上逐条核对 plan D3 步 2 的行为（进程内宿主内部入口、
  认证/轮换契约、`node-pty` 原生件完整性、`pi-dist` marker 语义），每条给「需要 / 不需要 + 依据」。
- **完成判据**：每条候选都有明确结论与依据（含源码路径/行号或 `git apply --check` 输出）。
- **产出**：`logs/20261015-1/06-patch-eval.md`

#### T07 — 补丁生成/登记 或「不需要」登记
- **回引**：FR-ver-009、FR-ver-010、FR-ver-011；plan D3；AC-04
- **动作**：
  - 若需要：在 `<scratch>/pw-v0.12.1` 生成 `patches/v0.12.1/000N-*.patch`（UTF-8/LF、不含 lockfile/二进制），
    改 `scripts/prepare-next.mjs` 应用目录，并跑「应用 → 反向 → SHA-256 还原」断言。
  - 若不需要（预期）：在 `plan.md §3 D3` 记录「不需要」结论与**复现方式**（pristine v0.12.1 上流水线全绿）。
- **完成判据**：结论与产出与 T06 一致；不引入无依据补丁（FR-ver-010）。
- **产出**：`logs/20261015-1/07-patch-decision.txt`（+ 如适用 `patches/v0.12.1/*.patch`）

### 阶段 4：版本号与基线同步（T08–T10）

#### T08 — `package.json` 版本号
- **回引**：FR-ver-012；plan D1/D5；AC-05
- **动作**：`package.json:4` `"version": "0.11.1"` → `"0.12.1"`。
- **完成判据**：`node -e "console.log(require('./package.json').version)"` 输出 `0.12.1`。
- **产出**：`logs/20261015-1/08-version-grep.txt`

#### T09 — 对外可见处文档同步
- **回引**：FR-ver-013、FR-ver-014、FR-ver-015；plan D5；AC-05
- **动作**：按 plan D5 表逐项更新：`README.md:15-16`、`README_zh.md:13-14`、`docs/发布与更新.md`
  §1.1（`:20`）/§1.2（`:31`）/文档头（`:8`）、`docs/工程规划.md:8,87`、`specs/README.md:5-6`。
  历史文档（`docs/构建验证记录.md`、`docs/桌面能力清单.md`、`specs/012-branding/test-cases.md`）**不回改**。
- **完成判据**：对外可见处 grep `0.11.1` / `v1.1.0` / `v0.11.1` = 0 处（历史文档除外）；
  基线行均为 `pi v1.2.0` / `pi-web v0.12.1`。
- **产出**：`logs/20261015-1/09-doc-sync-grep.txt`

#### T10 — 更新 `pin-upstream.mjs` baseline 并再生 lock
- **回引**：FR-ver-013；plan D5/D8；AC-06
- **动作**：`scripts/pin-upstream.mjs:77` 的 `baseline` 字符串改为 `v1.2.0 (Branch_v1.2.0)` /
  `v0.12.1 (Branch_v0.12.1)`；随后 `node scripts/pin-upstream.mjs`。
- **完成判据**：`upstream.lock.json` 的 `upstream[*].commit` = 新 SHA，`baseline` 块 = 新字符串。
- **产出**：`logs/20261015-1/10-upstream-lock.txt` + `upstream.lock.json`（`.gitignore` 忽略）

### 阶段 5：构建与打包（T11–T13）

#### T11 — 依赖安装与 pi-web 生产构建
- **回引**：FR-ver-016、FR-ver-017；plan D7；AC-07
- **动作**：
  ```
  npm ci
  node scripts/prepare-next.mjs
  ```
- **完成判据**：两条命令 exit 0；`prepare-next` 打印构建成功与平台裁剪统计。
- **产出**：`logs/20261015-1/11-prepare-next.log`

#### T12 — 组装产物 + 门禁
- **回引**：FR-ver-016、FR-ver-018；plan D7；AC-07
- **动作**：
  ```
  node scripts/collect-pi.mjs
  node scripts/smoke-desktop.mjs
  ```
- **完成判据**：产出 `pi-dist.tar.gz` + `pi-dist.version`（SHA-256）；`smoke-desktop` **0 FAIL**（门禁，未过即停）。
- **产出**：`logs/20261015-1/12-collect-smoke.log`

#### T13 — Forge 打包 + 包内核对
- **回引**：FR-ver-016、FR-ver-018；plan D7；AC-08
- **动作**：
  ```
  npx --no-install electron-forge package
  ```
  核对包内 `resources/pi-dist.tar.gz` + `resources/pi-dist.version` + 图标资源；SHA-256 一致。
- **完成判据**：打包目录存在且包内 `pi-dist.*` 齐备、SHA-256 与源一致。
- **产出**：`logs/20261015-1/13-package.log` + `logs/20261015-1/13-packaged-resources.txt`

### 阶段 6：打包态运行与基本功能（T14–T15）

#### T14 — 打包态启动到就绪 + 二次启动幂等
- **回引**：FR-ver-019；plan D7；AC-09
- **动作**：以 `--debug-port` 启动打包态应用，取证 Next 就绪、`[ready]` 探测通过、加载 Pi Web UI；
  关闭后重新启动，取证 marker 一致跳过解压。
- **完成判据**：首启日志含就绪与 `[ready]`；次启日志显示 marker 一致、跳过解压。
- **产出**：`logs/20261015-1/14-packaged-run.log`

#### T15 — 基本功能：Key / 工作区 / 一次对话
- **回引**：FR-ver-020、FR-ver-021、FR-ver-022、FR-ver-023；AC-10/AC-11/AC-12
- **动作**：打包态设置需求方给定的 DeepSeek API Key（**完整值不入库**；取证件只用脱敏 `sk-e32……a17f`）→ 创建测试目录作为工作区 →
  发一轮真实对话（提示词「介绍一下你自己」）；取证请求 → 流式返回 → 会话 JSONL → UI 文本。
  **取证文件脱敏**（密钥只留前后 4 位）。
- **完成判据**：三项均成功且回复非空；JSONL 含 assistant 正文；目录真实存在。
- **产出**：`logs/20261015-1/15-basic-e2e.log`（脱敏）+ 截图 `logs/20261015-1/15-screenshot.png`

### 阶段 7：GitHub Actions 工作流（T16）

#### T16 — 更新两个工作流的上游钉扎
- **回引**：FR-ver-024、FR-ver-025、FR-ver-026、FR-ver-027；plan D6；AC-13
- **动作**：`ci.yml:23-27`、`release.yml:31-35` 的 `PI_REF` / `PI_SHA` / `PI_WEB_REF` / `PI_WEB_SHA`
  改为 `v1.2.0` / `06a46693…` / `v0.12.1` / `f83b1a50…`；保留 SHA 断言；不动 `npm ci` 与缓存配置。
- **完成判据**：两文件 grep 无旧值；断言步骤（`test "$actual" = "$PI_SHA"`）仍在。
- **产出**：`logs/20261015-1/16-workflows-grep.txt`

### 阶段 8：提交与发布（T17–T18）

#### T17 — 提交（Conventional Commits）
- **回引**：FR-ver-028、FR-ver-029；AC-14
- **动作**：分文件 `git add`（源码/文档/工作流/规格），**禁止** `git add -A`；提交信息用
  `feat/fix/docs/style/refactor/perf/test/build/ci/chore/revert` 前缀（本需求通常用 `chore(version):` 或 `build:`）。
- **完成判据**：`git log --oneline -1` 前缀合法；`git show --stat` 不含产物 / 密钥。
- **产出**：`logs/20261015-1/17-commit.txt`（`git log` / `git show --stat` 原样输出）

#### T18 — 打 tag `v0.12.1` 并收尾
- **回引**：FR-ver-030、FR-ver-002；AC-15、AC-02
- **动作**：`git tag v0.12.1`（指向本需求最后一次提交）；再次 `git -C ../pi branch -a` /
  `git -C ../pi-web branch -a` / 本工程 `git branch --show-current` 存盘（分支未改动）；
  移除 T03 的临时 worktree。
- **完成判据**：`git tag -l` 含 `v0.12.1` 且 `git describe --tags` 指向该 commit；分支快照与 T02 一致。
- **产出**：`logs/20261015-1/18-tag.txt` + `logs/20261015-1/02-branch-after.txt`

## 2. 依赖关系

```
T01 ──► T03 ──► T06 ──► T07
 │                       ▲
 ├──► T02 ───────────────┼───────────────┐
 │                       │               │
 T04 ──► T05             │               │
                         │               │
 T08 ──► T09 ──► T10 ────┘               │
                         │               │
                         ▼               │
 T11 ──► T12 ──► T13 ──► T14 ──► T15     │
                                 │       │
 T16 ────────────────────────────┼───────┤
                                 ▼       ▼
                         T17 ──► T18 ◄── (T02 复比 / T03 收尾)
```

- **硬序**：T04/T05（清理）必须早于 T11（构建）；T08（版本）应早于 T11（使产物版本正确）；
  T11→T12→T13→T14→T15 严格串行（门禁与产物态依赖前一环）；T17→T18 收尾。
- **可并行**：T02 与 T01 同批；T06/T07（补丁）与 T08/T09/T10（版本）可并行；T16（工作流）独立于构建。
- **回边**：T15 失败 → 回 T11（重建）或按 FR-ver-023 记缺陷；T12 门禁 FAIL → 回 T11/T07。

## 3. 里程碑

| 里程碑 | 覆盖任务 | 出口判据 | 对应 AC |
|---|---|---|---|
| M1 上游锚定完成 | T01–T03 | 双基线 SHA/分支一致、工作树干净、临时树可回收 | AC-01、AC-02 |
| M2 清理 + 补丁结论 | T04–T07 | 清理清单命中且未误删；补丁候选逐条有结论 | AC-03、AC-04 |
| M3 版本收敛 | T08–T10 | `version == 0.12.1`；对外可见处无旧值；lock 已更新 | AC-05、AC-06 |
| M4 打包物产出 | T11–T13 | 流水线全绿；`smoke` 0 FAIL；包内 `pi-dist.*` 齐备 | AC-07、AC-08 |
| M5 基本功能通过 | T14–T15 | 启动到就绪 + 二次幂等；Key/工作区/对话三项通过 | AC-09、AC-10、AC-11、AC-12 |
| M6 工作流就绪 | T16 | 两工作流 env 为新基线且断言保留 | AC-13 |
| M7 已提交 + 已打 tag | T17–T18 | 提交前缀合法、无密钥/产物入库；tag `v0.12.1` 指向末次提交 | AC-14、AC-15 |

> 全部任务的实测结果按 [`test-cases.md`](./test-cases.md) 回填；未执行前用例一律记 `⬜`。
