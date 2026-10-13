# 011 — 发布与更新（release-update）功能规格

> **Module:** 011-release-update（发布与更新）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应方案:** [`./plan.md`](./plan.md)
> **实现落点:** `.github/workflows/{ci.yml,release.yml}`、`src/main/update-check.ts`
> **规划依据:** `docs/工程规划.md` §8.5、§5.7（决策 Q5）、§9.2、§11.1 R4/R9、§11.3.2/§11.3.3

## 1. 模块概述

### 1.1 目的

发布与更新模块的职责分两层：

1. **发布层（CI）**：用三 OS 矩阵构建产物，打 tag 后把安装包作为 GitHub Release 资产发布（✅ §8.5）。
2. **更新层（应用内，半自动）**：提供「检查更新 → 引导下载」——查询更新源、比较语义化版本、有新版则弹窗并打开下载页。**不签名、不静默更新**（✅ 决策 Q5）。

### 1.2 解决的问题

- **用户无法知道有没有新版**：未签名、无自动更新的前提下，用户至少需要「一键知道」的入口与明确下载路径。
- **发布过程不可复现/不可解释**：三平台各自构建各自产物，必须有固定工作流与资产清单，否则「同 tag 出不同包」无法追溯。
- **未签名安装包的用户体验落差**：Windows SmartScreen 告警、macOS Gatekeeper 拦截必须先写清楚打开方式（⚠️ R4、§11.3.3）。
- **静默更新会引入签名依赖与供应链风险**：v1 明确不做（§9.2），但需要把「不做」写成可验收的边界，避免后续顺手引入。
- **更新源不可用**：网络不可达、GitHub API 未认证限流（⚠️ R9）都不能阻塞应用或误报「有新版本」。

### 1.3 范围

**包含**

- `ci.yml`：三 OS 矩阵、`concurrency` 取消在途、上游 sibling 克隆、同版 Node、质量门与打包、产物上传。
- `release.yml`：tag 触发、三 OS 构建、资产汇总、Release 上传与发布说明。
- 应用内「检查更新」：更新源查询、版本比较、弹窗与 `shell.openExternal` 下载页跳转、失败可见。
- 未签名产物的用户指引（README / 发布说明）。

**不包含**

- 代码签名与公证（§9.2，Phase 3；§11.3.3 待确认）。
- 自动下载与静默安装（任何形式的 `electron-updater`/Squirrel 自动更新通道）。
- 应用内更新日志/版本历史页面的完整实现（v1 只做「有无新版 + 下载页」）。
- 内网更新源代理配置产品化（企业场景属后续评估，⬜ 见 §7）。
- 独立官网（`pi-desktop-website`）的建设；本模块只把它作为**候选**数据源（§11.3.2）。

## 2. 用户故事

- 作为用户，我希望在应用里点一下「检查更新」就知道有没有新版本，并能在浏览器里打开下载页。
- 作为用户，我不希望应用偷偷下载或安装任何东西（我要自己决定何时升级）。
- 作为用户，网络不通时我希望得到「无法检查更新」的明确提示，而不是转圈或静默失败。
- 作为发布者，我希望打一个 `v*` tag 就能自动产出三平台安装包并作为 Release 资产发布，资产清单固定。
- 作为发布者，我希望发布说明里明确写出「未签名」以及三平台的打开方式，减少用户误报。
- 作为维护者，我希望 CI 与本地用同一套命令与同一版 Node，避免「本地能过 CI 不过」。

## 3. 功能需求

动作词：**MUST** 必须满足；**MUST NOT** 禁止；**SHOULD** 建议；**MAY** 可选。

### 3.1 CI 工作流（`ci.yml`）

- FR-011-001：`ci.yml` MUST 在 `push` 到 `main` 与 `pull_request` 时触发，并 MUST 配置 `concurrency`（取消同分支在途运行）。
- FR-011-002：`ci.yml` MUST 使用三 OS 矩阵 `[windows-latest, ubuntu-latest, macos-latest]`，且 MUST 设置 `fail-fast: false`。
- FR-011-003：`ci.yml` MUST 按序执行：checkout → **克隆** `../pi`（`Branch_v1.1.0`）与 `../pi-web`（`Branch_v0.11.1`）到与本工程平级的目录 → `setup-node`（Node **24.21.0**） → Linux 额外装 `fakeroot rpm` → `npm ci` → `node scripts/pin-upstream.mjs` → 质量门（`npm run typecheck` + `node scripts/smoke-desktop.mjs`） → `npm run make` → 上传 `out/make/` 产物。
- FR-011-004：克隆上游 MUST 使用 `git clone --branch <固定分支> --depth 1`（**MUST NOT** 用跨仓库 `checkout path`，见 §8.5 平台注意事项 1），且 MUST 记录解析到的 commit SHA（`upstream.lock.json`）。
- FR-011-005：CI 的质量门 MUST 与本地一致（typecheck + smoke 双门禁），**MUST NOT** 存在「CI 跳过门禁直出包」的路径。
- FR-011-006：`ci.yml` MUST 上传构建日志/失败上下文所需的最小信息（至少：失败阶段、退出码；SHOULD 上传 `out/make/` 产物以便本地复现）。

### 3.2 发布工作流（`release.yml`）

- FR-011-007：`release.yml` MUST 由 tag `v*` 触发，并 MAY 支持 `workflow_dispatch` 手动触发。
- FR-011-008：`release.yml` MUST 走三 OS 矩阵构建（与 CI 相同的准备与打包步骤），并 MUST 汇总各平台资产。
- FR-011-009：`release.yml` MUST 使用 `softprops/action-gh-release`（`generate_release_notes: true`）上传资产，且资产匹配 MUST 覆盖：`*.exe`、`*.nupkg`、`RELEASES`、`*.zip`、`*.dmg`、`*.deb`、`*.rpm`。
- FR-011-010：v1 MUST NOT 做代码签名与公证，MUST NOT 启用自动更新通道（不上传/不依赖自动更新元数据）；发布说明 MUST 明确写出「未签名」。
- FR-011-011：发布说明 MUST 包含三平台安装/打开指引：Windows 可能触发 SmartScreen 警告、macOS 需右键打开或 `xattr -dr com.apple.quarantine <app>`、Linux 直装（🔶 §8.5 注意事项 6、⚠️ R4）。
- FR-011-012：`release.yml` MUST 在发布前校验 `package.json` 的 `version` 与 tag 一致（不一致即失败），避免「tag 与产物版本不符」。

### 3.3 应用内检查更新（半自动）

- FR-011-013：系统 MUST 提供「检查更新」入口（托盘菜单与「关于」信息处），其行为由本模块统一实现。
- FR-011-014：系统 MUST 查询可配置的更新源（默认 GitHub Releases latest API；见常量 `DEFAULT_UPDATE_FEED`），且查询 MUST 有超时上限（默认 `UPDATE_CHECK_TIMEOUT_MS`）。
- FR-011-015：系统 MUST 用**语义化版本比较**判断是否需要提示新版（不得用字符串比较）。
- FR-011-016：检测到新版时系统 MUST 弹出可读提示（含远端版本号与发布说明链接），并在用户确认后用 `shell.openExternal` 打开下载页。
- FR-011-017：系统 MUST NOT 自动下载安装包、MUST NOT 静默安装、MUST NOT 在后台重启应用完成升级。
- FR-011-018：检查失败（网络不可达、HTTP 4xx/5xx、限流、JSON 解析失败、版本格式非法）时，系统 MUST 给出「无法检查更新」的可读提示并写入日志（含状态码/原因），**MUST NOT** 阻塞应用、MUST NOT 误报「有新版本」。
- FR-011-019：系统 MUST NOT 在检查更新请求中携带任何用户数据（不发设备标识、不发会话/凭据信息）。
- FR-011-020：系统 SHOULD 对自动检查做节流（例如启动后仅自动检查一次、或 24 h 内不重复自动检查）；用户手动触发 MUST NOT 被节流阻塞。

### 3.4 版本策略与文档

- FR-011-021：本工程 MUST 使用语义化版本，且 `package.json.version` 是唯一权威来源（tag、Release 名称、应用内显示一致）。
- FR-011-022：系统 MUST 在「关于」信息中展示当前版本与更新源类型（不展示任何凭据）。
- FR-011-023：`README.md`/`docs/发布与更新.md` MUST 记录：制包命令、签名现状（未签名）、更新源选择与升级指导（含跨大版本时 `pi-dist` 会重解压的说明）。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| CI 矩阵 | 三平台并行运行 | `os`、`fail-fast:false`、`concurrency` 组 |
| Release 资产集 | 上传到 Release 的文件 | `*.exe` / `*.nupkg` / `RELEASES` / `*.zip` / `*.dmg` / `*.deb` / `*.rpm` |
| 更新源（`UpdateSource`） | 查询目标 | `kind: 'github-release' \| 'static-feed'`、`url`、`timeoutMs` |
| 检查结果（`UpdateCheckResult`） | 一次检查的结论 | `status: 'none' \| 'available' \| 'error'`、`currentVersion`、`latestVersion?`、`releaseUrl?`、`reason?` |
| 版本比较 | 语义化比较 | `current` vs `latest`（仅当 `latest > current` 才提示） |

## 5. 验收场景

### 场景 S1：CI 三平台绿灯

- Given 向 `main` 推送一次提交
- When CI 运行
- Then 三个 OS job 各自完成：克隆上游 → 同版 Node → `npm ci` → `pin-upstream` → typecheck + smoke → `make`；产物上传；无「跳门禁」路径

### 场景 S2：CI 取消在途

- Given 同一分支已有一个 CI 运行
- When 又推送一次
- Then 旧运行被取消（`concurrency`），新运行继续

### 场景 S3：tag 发布

- Given `package.json.version` 与 tag `v*` 一致
- When 推送 tag
- Then `release.yml` 构建三平台并创建 Release，资产包含 `.exe`/`.nupkg`/`RELEASES`/`.zip`/`.dmg`/`.deb`/`.rpm`；发布说明含未签名指引

### 场景 S4：tag 与版本不一致

- Given `package.json.version` 与 tag 不一致
- When 触发 `release.yml`
- Then 工作流失败并给出可读原因（不产出 Release）

### 场景 S5：检测到新版

- Given 更新源返回更高版本
- When 用户点击「检查更新」
- Then 弹窗显示远端版本号与说明链接；确认后系统浏览器打开下载页；**应用内不下载任何文件**

### 场景 S6：网络失败

- Given 网络不可达或 GitHub API 限流（403/429）
- When 用户点击「检查更新」
- Then 提示「无法检查更新」、日志含状态码；应用继续可用；不出现「有新版本」的误报

### 场景 S7：版本比较正确

- Given 当前 `0.1.0`，远端 `0.1.0`（相同）或 `0.0.9`（更低）
- When 检查更新
- Then 提示「已是最新」；不提示「有新版本」

## 6. 非功能需求

- **可靠性**：更新检查是纯增量能力 —— 任何失败都不得影响启动、会话、终端等核心路径。
- **可观测性**：检查结果与失败原因（含 HTTP 状态码）必须落日志；托盘「检查更新」项有进行中状态（见 003）。
- **性能**：单次检查为一次 HTTP GET，超时上限约束（默认 8 s）；不轮询、不后台静默刷。
- **隐私**：请求无用户数据（FR-011-019）；日志不含凭据。
- **可维护性**：更新源与超时通过常量/配置集中管理（✅ `constants.ts` 已含 `DEFAULT_UPDATE_FEED`、`UPDATE_CHECK_TIMEOUT_MS`）。
- **CI 效率**：`concurrency` 取消在途、缓存 npm（SHOULD）、三平台各自构建（不做交叉打包）。

## 7. 假设与约束

- **假设（✅ 决策 Q5、§5.7）**：「检查更新 → 引导下载」半自动层是 v1 的范围；自动更新与签名是 Phase 3。
- **假设（✅ `forge.config.ts`）**：makers 已覆盖 Squirrel / ZIP / DMG / RPM / DEB，因此资产清单与 maker 集合对应（✅ `forge.config.ts:43-49`）。
- **约束（⚠️ R9 / §11.3.2）**：更新源**尚未最终确定** —— 候选 ① GitHub Releases API（未认证限流 60 req/h/ IP）；候选 ② `pi-desktop-website` 的静态 feed。⬜ 本版把两者都登记为可选，实现必须按 `UpdateSource` 抽象落地，切换数据源不需改业务代码。
- **约束（§11.3.3）**：签名与公证是否需要由人工确认；本模块按「未签名」实现与写文档，且 MUST NOT 预留自动更新通道。
- **约束**：`RELEASES` 与 `.nupkg` 必须一并上传（即使 v1 不做自动更新）—— 它们是 Squirrel 安装器的产物，缺失会影响将来启用自动更新的迁移路径（🔶 §8.5 注意事项 4）。
- **约束**：⬜ `pi-desktop-website`（官网）尚在规划中，静态 feed 的具体 URL/格式未定；在确定前不得把它写成默认源。
- **⬜ 待验证**：GitHub Releases API 的 tag 命名与 `version` 字段解析（`tag_name` 通常为 `v0.1.0`，需剥离前缀后做语义化比较）；探针：手动 GET 一次并记录字段。

## 8. 依赖

**上游（被本模块消费）**

- 010-build-pipeline：四阶段脚本与 Forge 打包（CI 直接调用 `npm run make`）。
- 008-runtime-config / 009-artifact-bootstrap：升级时 `pi-dist` 重解压的语义（用于写升级指导）。
- 003-tray / 006-preload：检查更新的入口（托盘菜单项、壳层动作 `checkForUpdates`）。

**下游（消费本模块）**

- 用户可见的发布资产与发布说明；`README.md`、`docs/发布与更新.md`。
- 未来的自动更新能力（Phase 3）将建立在本模块的版本比较与更新源抽象上。

**外部**

- GitHub Actions（`actions/checkout`、`actions/setup-node`、`softprops/action-gh-release`）。
- GitHub Releases API 或 `pi-desktop-website` 静态 feed（二选一，⬜ 未定）。
- Electron `shell`（`openExternal`）、`app.getVersion()`、`net`/`fetch`（主进程 HTTP）。
