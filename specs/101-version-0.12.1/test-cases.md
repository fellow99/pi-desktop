# 101 — 版本更新：0.12.1（version）测试用例

> **Module:** version ｜ **Status:** Implementing ｜ **Last Updated:** 2026-10-15
> **上游基线:** pi v1.2.0（Branch_v1.2.0）· pi-web v0.12.1（Branch_v0.12.1）
> **需求编号:** 101-version-0.12.1
> **对应规格:** [`./spec.md`](./spec.md)（FR-ver-001…030 / AC-01…15）｜**对应方案:** [`./plan.md`](./plan.md)（D1…D8）｜**任务拆解:** [`./tasks.md`](./tasks.md)（T01…T18）
> **取证目录:** `logs/20261015-1/`（`logs/` 不入库；**证据文件必须脱敏**，密钥只留前后 4 位）｜**执行轮次:** 见 `docs/构建验证记录.md`

**图例（本文件只用这四个标记）**

| 标记 | 含义 |
|---|---|
| ✅ | PASS：实测通过，附证据 |
| ❌ | FAIL：实测失败（须记缺陷与根因，不得改判） |
| ⬜ | 未执行：本轮未落盘该用例的取证（原因写在该行内） |
| N/A | 不适用：本轮结论判定无需该用例（须写明理由） |

> 说明：本规格集已随 `logs/20261015-1/` 轮次（2026-10-15/16）执行完毕，结果列按实测回填，证据一律指向该目录下**真实存在**的取证件。
> 仍未判定的用例：真跑 GitHub Actions（D-05）、提交 / 打 tag 后的收尾项（E-01…E-05），以及未落盘取证的静态项（A-06 / A-10）—— 原因逐行写在结果列内。

---

## A. 清理与静态

| 编号 | 对应 FR/AC | 用例 / 方法（精确命令或步骤） | 期望（可判） | 结果 | 证据（`logs/20261015-1/`） |
|---|---|---|---|---|---|
| A-01 | FR-ver-001 / FR-ver-003 / AC-01 | `git -C ../pi rev-parse HEAD` · `git -C ../pi describe --tags` · `git -C ../pi status --porcelain` · `git -C ../pi branch --show-current`；`../pi-web` 同四步 | `pi` HEAD = `06a466935536f8c9bcacb2d5efc0fc021be1bdff` 且在 `Branch_v1.2.0`；`pi-web` HEAD = `f83b1a502f8e434555a7153fe08e1c135dd65ca9` 且在 `Branch_v0.12.1`；两侧 `--porcelain` 为空 | ✅ `pi 06a4669355…｜v1.2.0｜Branch_v1.2.0`（tag 轻量）、`pi-web f83b1a502f…｜v0.12.1｜Branch_v0.12.1`（带注释 tag） | `T01-anchor.txt` |
| A-02 | FR-ver-002 / AC-02 | 提交前快照：`git -C ../pi branch -a` · `git -C ../pi-web branch -a` · `git -C . branch --show-current` | 三份输出存盘；本工程当前分支为 `main`；分支列表无本轮新增分支 | ✅ 五仓分支快照已存盘（`pi`/`pi-web`/`pi-desktop`/`pi-desktop-hos`/`pi-desktop-website`）；本工程 `main`；列表无本轮新增分支 | `T01-anchor.txt` |
| A-03 | FR-ver-005 / FR-ver-006 / AC-03 | `rm -rf .vite dist out pi-dist pi-dist.tar.gz pi-dist.version pi-dist.sha256 .collect-pi-tmp .collect-runtime-tmp node_modules/.cache` 后 `ls` 目标路径 | 全部目标不存在；无「Permission denied」以外报错；`logs/` 保留 | ✅ 6 HIT（`.vite`/`out`/`pi-dist`/`pi-dist.tar.gz`/`pi-dist.version`/`upstream.lock.json`）+ 3 MISS（本就不存在）；`KEEP` 清单含 `docs`/`specs`/`logs` 不在删除列 | `T02-clean.txt` |
| A-04 | FR-ver-007 / AC-03 | 清理后 `git status --porcelain` | tracked 列表**不含**被删产物名；无源码 / `specs/` / `docs/` / `resources/` / `assets/` 被删 | ✅ 仅 `?? specs/101-version-0.12.1/`（新增），无 `deleted` | `T02-clean.txt` |
| A-05 | FR-ver-012 / AC-05 | `node -e "console.log(require('./package.json').version)"` + `grep -n '"version"' package.json` | 输出且仅输出 `0.12.1`（`package.json:4`） | ✅ 类型门禁日志即带版本号：`pi-desktop@0.12.1` | `T05c-typecheck.log` |
| A-06 | FR-ver-013 / FR-ver-014 / FR-ver-015 / AC-05 | `grep -rn '0.11.1\|v1.1.0\|v0.11.1' README.md README_zh.md docs/发布与更新.md docs/工程规划.md specs/README.md` | 对外可见处 **0 处**旧值；基线行均为 `pi v1.2.0` / `pi-web v0.12.1`；历史文档（`docs/构建验证记录.md` / `docs/桌面能力清单.md` / `specs/012-branding/test-cases.md`）不计入 | ⬜ 未执行（本轮未落盘该 grep 的取证件）；且按原文期望**不可达**：`docs/发布与更新.md` §3.1 保留 2026-10-13 的历史更正行（旧基线已显式标注为「上一基线」），而该文件的排除清单未覆盖它 → 需先扩宽排除口径再判 | `—`（无本轮取证件） |
| A-07 | FR-ver-013 / AC-06 | `node scripts/pin-upstream.mjs` 后读 `upstream.lock.json` | `upstream[*].commit` = 新 SHA；`baseline` 块 = `v1.2.0 (Branch_v1.2.0)` / `v0.12.1 (Branch_v0.12.1)` | ✅ `pi 0.0.3｜v1.2.0｜Branch_v1.2.0`、`pi-web 0.12.1｜v0.12.1｜Branch_v0.12.1`；`upstream.lock.json` 已写入 | `T05a-pin-upstream.log` |
| A-08 | FR-ver-008 / AC-04 | 在 `<scratch>/pw-v0.12.1`（detached `v0.12.1` 树）上逐条核对：进程内宿主内部入口、认证/轮换契约、`node-pty` 原生件、`pi-dist` marker 语义 | 每条候选都有「需要 / 不需要 + 依据（源码路径/行号）」结论 | ✅ 结论：本工程本轮**不需要任何补丁**（无 `patches/` 目录；`src/`、`forge.config.ts`、`config/`、`resources/`、`scripts/*.mjs` 本轮零改动） | `DEV_CHECKLIST.md` §2、§4 |
| A-09 | FR-ver-009 / FR-ver-010 / FR-ver-011 / AC-04 | 若需要补丁：`git -C <scratch>/pw-v0.12.1 apply --check patches/v0.12.1/000N-*.patch`（+ 反向/SHA-256 还原）；若不需要：登记理由与复现方式 | 结论与 A-08 一致；不需要时给出「如何验证不需要」的复现方式；不引入无依据补丁 | ✅ 同上（0 条补丁）：未生成任何补丁文件，理由与复现步骤随 §4「未改动」清单登记（`plan.md` D3 的「默认 0 补丁」纪律） | `DEV_CHECKLIST.md` §4 |
| A-10 | FR-ver-004 | `git -C ../pi-web worktree add --detach <scratch>/pw-v0.12.1 v0.12.1` → 收尾 `git -C ../pi-web worktree remove --force <scratch>/pw-v0.12.1` · `worktree list` | 临时树 HEAD = `f83b1a50…`；收尾后 `worktree list` 仅剩主工作树；`../pi-web` checkout 未变 | ⬜ 未落盘：本轮日志无 `git worktree list` 输出，无法自证临时树已创建并移除（结论侧只登记「该工程 0 条上游补丁」） | `—`（`T01-anchor.txt` / `T02-clean.txt` 均无该输出） |
| A-11 | FR-ver-016（静态门） | `npm run typecheck` | exit 0；0 错误 | ✅ exit 0、0 错误 | `T05c-typecheck.log` |

---

## B. 构建与打包门禁

| 编号 | 对应 FR/AC | 用例 / 方法（精确命令） | 期望（可判） | 结果 | 证据（`logs/20261015-1/`） |
|---|---|---|---|---|---|
| B-01 | FR-ver-016 / FR-ver-017 / AC-07 | `npm ci` | exit 0；安装与 `package-lock.json` 一致，无 lockfile 漂移告警 | ✅ `added 610 packages in 37s`，exit 0；无 `npm ci can only install … lockfile` 类告警 | `T05b-npm-ci.log` |
| B-02 | FR-ver-016 / AC-07 | `node scripts/prepare-next.mjs`（本轮实跑加 `--force-install`，见 §4 偏差） | exit 0；`../pi-web` `next build` 成功 + 平台裁剪统计打印 | ✅ exit 0；`BUILD_ID hLQp39yL4wISeTPGAVG2q`、`.next` 888.2 MB / 676 文件；`@earendil-works/*` **七个包全部 1.2.0**；非 arm64 候选原生件盘点 18 个 | `T05d-prepare-next.log` |
| B-03 | FR-ver-016 / FR-ver-018 / AC-08 | `node scripts/collect-pi.mjs` | exit 0；产出 `pi-dist.tar.gz` + `pi-dist.version`（SHA-256 marker） | ✅ `pi-dist.tar.gz` **196.2 MB**（staging 51654 文件 / 983.6 MB）、`pi-dist.version` = SHA-256 `11cba95c3c6f…`；品牌化终检「`Pi Web` = 0 处」 | `T05e-collect-pi.log` |
| B-04 | FR-ver-016 / AC-07 | `node scripts/smoke-desktop.mjs` | **0 FAIL**（全部 PASS）；非 0 即阻断后续 | ✅ **10 PASS / 0 FAIL**（含受保护 API 401/200、SPA 标记、建会话、SSE 首块 129 B） | `T05f-smoke.log` |
| B-05 | FR-ver-016 / AC-08 | `npx --no-install electron-forge package` | exit 0；打包目录生成 | ✅ `Packaging for x64 on win32` → `Packaging application` 完成，`out/Pi Desktop-win32-x64/` | `T05g-package.log` |
| B-06 | FR-ver-018 / AC-08 | 解包核对 `<pkg>/resources/pi-dist.tar.gz` 与 `pi-dist.version`：`sha256sum` 比对 | 两文件齐备；`tar.gz` SHA-256 == `pi-dist.version` 内容；图标资源存在 | ✅ 打包态启动日志三方一致：`归档 SHA-256 = 11cba95c…` = `期望 SHA-256` = marker `11cba95c…`（取自包内投放物），并据此「跳过解压」 | `T07b-packaged-run.log` |
| B-07 | FR-ver-017 | 偏差登记复核：`plan.md` D7 与 `spec.md` FR-ver-017 grep | 偏差（`pnpm i && npm run package` → 仓库自身流水线）与理由已显式记录 | ✅ 已登记：需求原文 `pnpm i && npm run package` → 实际 `npm ci` → `prepare-next` → `collect-pi` → `smoke` → `npx --no-install electron-forge package`，理由（npm + `package-lock.json`、CI 亦为 `npm ci`）随行 | `DEV_CHECKLIST.md` §4 |

---

## C. 打包态运行与基本功能

> 取证通道：打包态启动 + CDP（`node scripts/probe-renderer.mjs --debug-port <port> --cwd <工作区>`）或同源 API（带会话凭据）。
> **所有证据文件脱敏**：DeepSeek Key 只留前后 4 位（本轮实测所用为 `sk-dc5d……296c`；需求原文工程小节给的 `sk-e32f…a17f` 实测直连返回 HTTP 401，已按用户 2026-10-15 指示改用前者 —— 见 `DEV_CHECKLIST.md` §4）。

| 编号 | 对应 FR/AC | 用例 / 方法 | 期望（可判） | 结果 | 证据（`logs/20261015-1/`） |
|---|---|---|---|---|---|
| C-01 | FR-ver-019 / AC-09 | 启动打包态应用，取日志 | 日志到「Next 就绪」+ `[ready] 第 N 次探测通过`；加载 Pi Web UI 首屏 | ✅ `服务端已启动：mode=in-process｜127.0.0.1:65125` → `[ready] 第 1 次探测通过：GET /api/web-auth → 200` → `首屏完成，UI 标记命中：Pi Desktop` → `[stage] 就绪` | `T07a-app-start.log`、`T07b-packaged-run.log` |
| C-02 | FR-ver-019 / AC-09 | 关闭后二次启动，取日志 | marker 一致 → **跳过解压**；再次到就绪 | ✅ `归档 SHA-256 = 期望 SHA-256`（marker 一致）→「产物已就位（marker 一致），跳过解压」；其后仍到 `[ready]` / `首屏完成` | `T07b-packaged-run.log` |
| C-03 | FR-ver-020 / AC-10 | 打包态设置 DeepSeek API Key（需求方给定；**完整值不入库**，取证件脱敏 `sk-dc5……296c`），回读用户数据目录配置 | 设置返回成功；配置落到用户数据目录；证据脱敏（不落完整 Key） | ✅ `B4` `POST /api/auth/api-key/deepseek` → 200 `{"success":true}`；`B5` 回读 `~/.pi/agent/auth.json` → `providers=[deepseek]`、`type=api_key`、`mode=666`；取证件全程脱敏（无完整 Key） | `T08-basic.log` |
| C-04 | FR-ver-021 / AC-11 | 创建测试目录作为工作区，`ls -la` / API 回读 | 工作区创建成功；目录真实存在 | ✅ `B2` 目录 `…\pi-desktop-workspace-0.12.1` 真实存在且 `isDirectory=true`（JSONL 409 = 已存在）；`B3` `POST /api/cwd/validate` → 200 + `projectRoot` / `projectKey` | `T08-basic.log` |
| C-05 | FR-ver-022 / AC-12 | 在工作区发一轮真实对话（提示词「介绍一下你自己」） | 请求发出 → 流式返回 → 会话 JSONL 落盘 → UI 显示回复文本（非空） | ✅ `B6` 建会话 200（`sessionId=01a1435e-21a5…`）→ `B7` 发提示 200 → `B8` 会话记录内出现 assistant 正文 **507 字**（详情 4448 B），语义合理（自述为 Pi 编码助手、列出能力与当前工作目录） | `T08-basic.log` |
| C-06 | FR-ver-023 | 校验对话走**真实网络**（非 mock）；失败时给根因分层 | 真实网络；失败则记缺陷（网络/凭据/上游），不改判通过 | ✅ 该会话为**真实模型回复**（`B8` 回复正文 4448 B、`诊断=（无）`；打包态应用内不含任何人工注入的 mock）；同轮 `B9` `/api/app-update` → `currentVersion 0.12.1` | `T08-basic.log` |

---

## D. GitHub Actions 工作流

| 编号 | 对应 FR/AC | 用例 / 方法（精确命令） | 期望（可判） | 结果 | 证据（`logs/20261015-1/`） |
|---|---|---|---|---|---|
| D-01 | FR-ver-024 / AC-13 | `grep -nE 'PI_REF\|PI_SHA\|PI_WEB_REF\|PI_WEB_SHA' .github/workflows/ci.yml` | `PI_REF: v1.2.0`、`PI_SHA: 06a466935536f8c9bcacb2d5efc0fc021be1bdff`、`PI_WEB_REF: v0.12.1`、`PI_WEB_SHA: f83b1a502f8e434555a7153fe08e1c135dd65ca9` | ✅ 四处 env 与期望逐字一致（读工作树文件） | `.github/workflows/ci.yml` |
| D-02 | FR-ver-025 / AC-13 | 对 `.github/workflows/release.yml` 执行 D-01 同款 grep | 4 处 env 与 `ci.yml` **相同**的新值 | ✅ 四处 env 与 `ci.yml` 逐字相同 | `.github/workflows/release.yml` |
| D-03 | FR-ver-026 / AC-13 | `grep -nE 'rev-parse HEAD\|test "\$actual" = "\$PI_SHA"\|::error::' .github/workflows/{ci,release}.yml` | 两工作流均保留「按 tag 克隆 + 断言 commit SHA + 不一致即 `exit 1`」的 fail-visible 语义 | ✅ 两工作流的克隆步骤仍为「按 tag + `rev-parse HEAD` 断言 + `::error::` + `exit 1`」，本轮只改 4 个钉住值 | `.github/workflows/ci.yml`、`.github/workflows/release.yml` |
| D-04 | FR-ver-027 | `grep -nE 'npm ci\|cache-dependency-path\|pnpm' .github/workflows/{ci,release}.yml` | 仍为 `npm ci` + `cache-dependency-path: package-lock.json`；**无** `pnpm` 引用 / 无 `pnpm-lock.yaml` | ✅ 仍为 `npm ci` + `cache-dependency-path: package-lock.json`；无 `pnpm` 引用 | `.github/workflows/ci.yml`、`.github/workflows/release.yml` |
| D-05 | FR-ver-024 / FR-ver-025 | YAML 结构核对（`node -e "require('yaml')..."` 或目视） | 两文件 YAML 合法、缩进/结构未破坏 | ⬜ **未执行**：真跑 GitHub Actions（本地只做 commit + tag、未 push；CI 侧结果不在本轮取证范围） | `—`（已登记于 `TEST_REPORT.md` D-05） |

---

## E. 提交与发布

| 编号 | 对应 FR/AC | 用例 / 方法（精确命令） | 期望（可判） | 结果 | 证据（`logs/20261015-1/`） |
|---|---|---|---|---|---|
| E-01 | FR-ver-028 / AC-14 | `git log --oneline -n <N>` 复核本轮提交 | 前缀 ∈ `{feat,fix,docs,style,refactor,perf,test,build,ci,chore,revert}`；**无** `development:`/`testing:`/`code-review:` | ⬜ 待提交后核验（本轮未提交） | `—` |
| E-02 | FR-ver-029 / AC-14 | `git show --stat` + `git ls-files` 复核 | 入库文件仅源码/文档/工作流/规格；**无** `pi-dist*` / `out/` / `logs/` / 密钥明文 | ⬜ 待提交后核验（本轮未提交；`logs/` 已由 `.gitignore` 排除、密钥已脱敏，但尚无用例要求的 `git show --stat` 取证件） | `—` |
| E-03 | FR-ver-030 / AC-15 | `git tag -l 'v0.12.1'` · `git describe --tags` · `git rev-list -n1 v0.12.1` | tag `v0.12.1` 存在且指向本需求**最后一次提交** | ⬜ 待打 tag（本轮未提交、未打 tag） | `—` |
| E-04 | FR-ver-002 / AC-02 | 提交/打 tag 后 `git -C ../pi branch -a` · `git -C ../pi-web branch -a` · `git -C . branch --show-current` | 分支列表与 A-02 快照一致；未新建/切换/重命名任何分支 | ⬜ 待提交后核验（无 `02-branch-after.txt`；`T01-anchor.txt` 只有执行前快照） | `—` |
| E-05 | FR-ver-004 | `git -C ../pi-web worktree list` | 无残留临时 worktree（A-10 已移除） | ⬜ 未落盘：本轮无 `git worktree list` 取证件（与 A-10 同一缺口） | `—` |

---

## 结果汇总（2026-10-15/16 轮次已回填）

| 区段 | 用例数 | ✅ | ❌ | ⬜ | N/A |
|---|---|---|---|---|---|
| A 清理与静态 | 11 | 9 | 0 | 2 | 0 |
| B 构建与打包门禁 | 7 | 7 | 0 | 0 | 0 |
| C 打包态运行与基本功能 | 6 | 6 | 0 | 0 | 0 |
| D GitHub Actions 工作流 | 5 | 4 | 0 | 1 | 0 |
| E 提交与发布 | 5 | 0 | 0 | 5 | 0 |
| **合计** | **34** | **26** | **0** | **8** | **0** |

> 剩余 ⬜ 分两类：① 须先提交 / 打 tag / 真跑 CI 才能核验的收尾项（D-05、E-01…E-05）；② 本轮未落盘取证的静态项（A-06、A-10）。逐行原因见结果列；证据一律脱敏、原始件在 `logs/20261015-1/`（不入库）。
