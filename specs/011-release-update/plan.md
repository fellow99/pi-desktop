# 011 — 发布与更新（release-update）技术实现方案

> **Module:** 011-release-update（发布与更新）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应规格:** [`./spec.md`](./spec.md)
> **架构基线:** `docs/工程规划.md` §8.5（CI/发布）、§5.7（决策 Q5）、§9.2、§11.1 R4/R9、§11.3.2、§11.3.3

## 1. 技术上下文

### 1.1 运行环境

- **CI 侧**：GitHub Actions，三 OS runner（`windows-latest` / `ubuntu-latest` / `macos-latest`）；Node **24.21.0**（✅ §8.5，与运行时同版）。
- **应用侧**：Electron 主进程（Node 24.21.0）；`src/main/update-check.ts` 只做「查询 + 比较 + 提示 + 打开外链」。
- **编译产物**：`.github/workflows/{ci.yml,release.yml}`（新增）；`src/main/update-check.ts` → `.vite/build/main.js`。
- **既有常量**（✅ 已存在）：`DEFAULT_UPDATE_FEED = 'https://api.github.com/repos/fellow99/pi-desktop/releases/latest'`、`UPDATE_CHECK_TIMEOUT_MS = 8_000`（`src/main/constants.ts:55-56`）。

### 1.2 依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| GitHub Actions | 外部 | 矩阵、克隆上游、缓存、上传/发布资产 |
| `softprops/action-gh-release` | Action | 创建 Release 并上传资产（`generate_release_notes`） |
| Electron `shell` / `app` | 内置 | `openExternal` 打开下载页；`app.getVersion()` 取当前版本 |
| 全局 `fetch`（Node 24 / Electron 主进程） | 内置 | 查询更新源（带 `AbortSignal.timeout`） |
| `src/main/logger.ts` | 本项目（✅） | 检查结果与失败原因留痕 |
| `src/main/constants.ts` | 本项目（✅） | 更新源与超时常量 |
| 010-build-pipeline | 本工程 | CI 调用的四阶段脚本与 `npm run make` |
| 003-tray / 006-preload | 本工程 | 「检查更新」入口与壳层动作 `checkForUpdates` |

> 不引入 `electron-updater`（v1 明确不做自动更新，§9.2）。

## 2. 宪法合规检查

| 原则（`docs/工程规划.md` §3 / §5.7 / §8.5 / §9.2 / §11.4） | 状态 | 说明 |
|---|---|---|
| 明确不做项不偷做（§9.2） | ✅ | 不签名、不公证、不自动下载、不静默安装（FR-011-010、FR-011-017） |
| 失败可见（§3 原则 5） | ✅ | 网络/限流/解析失败 → 可读提示 + 日志（含状态码）（FR-011-018） |
| 零上游改动（§7） | ✅ | 只做发布与应用内检查；不涉及上游仓库 |
| 可复现（§6.1、§8.5） | ✅ | 克隆固定分支 + 记录 SHA + 同版 Node + tag/版本一致性校验（FR-011-004、FR-011-012） |
| 平台差异显式化（§3 原则 6、§8.5） | ✅ | 未签名产物的三平台打开指引写入发布说明（FR-011-011） |
| 安全 S2（不打印凭据） | ✅ | 检查更新不携带/不打印凭据；日志只记状态码（FR-011-019） |
| 隐私（最小外呼） | ✅ | 一次 GET，无用户数据（FR-011-019） |
| CI 纪律（§8.5 注意事项 1–8） | ✅ | `git clone` 而非跨仓库 checkout；各自构建各自产物；`fakeroot rpm` |
| 代码质量：strict TS、无 `as any`、严禁空 catch | ⬜ | 代码已落地（2026-10-12 复核），待人工评审（`update-check.ts` 的 catch 必须带日志与可读返回） |

> 合规结论：边界与纪律项 ✅；⬜ 项在 `src/main/update-check.ts` 落地后复核。

## 3. 研究结论

### 3.1 关键决策与理由

| 决策 | 理由 | 对应 FR |
|---|---|---|
| 半自动更新（检查 → 引导下载） | 无签名即无可靠自动更新；静默更新会引入供应链风险（✅ Q5） | FR-011-013…017 |
| 更新源抽象为 `UpdateSource` | §11.3.2 未定（GitHub API vs 官网 feed）；抽象后切换不改业务代码 | FR-011-014 |
| 语义化比较（不在字符串上比） | `0.10.0` vs `0.9.0` 的字符串比较会误判 | FR-011-015 |
| `RELEASES`/`.nupkg` 一并上传 | 即使不做自动更新，也不能丢掉 Squirrel 元数据（将来启用的迁移路径） | FR-011-009 |
| CI 用 `git clone` 拉 sibling 上游 | `actions/checkout` 的 `path` 不能越出 `$GITHUB_WORKSPACE`（🔶 dsh 的 501 方案形态、§8.5 注意事项 1） | FR-011-004 |
| tag 与 `package.json.version` 一致性校验 | 避免「tag 与产物版本不符」这类无法追溯的发布事故 | FR-011-012 |
| 检查更新节流 | 避免每次启动都打 GitHub API（未认证限流 60/h，⚠️ R9） | FR-011-020 |

### 3.2 参考实现与上游核实（✅ / 🔶 / ⬜）

| # | 事实 | 依据 |
|---|---|---|
| U1 | dsh 的流水线形态：`ci.yml`（三 OS 矩阵 + `concurrency` 取消在途）与 `release.yml`（tag `v*` → `softprops/action-gh-release` 上传 `*.exe/*.nupkg/*.deb/*.rpm/*.dmg/*.zip`，不签名不公证） | 🔶 §2.3（dsh 结论，本工程沿用形态） |
| U2 | 本工程 CI 的额外要求：克隆 `../pi`（`Branch_v1.1.0`）与 `../pi-web`（`Branch_v0.11.1`）、`setup-node` 用 24.21.0、Linux 装 `fakeroot rpm`、跑 `pin-upstream.mjs`、跑质量门与 smoke 门禁 | ✅ §8.5 工作流表 |
| U3 | 应用内检查更新的行为定义（查询 → 比较 → 弹窗 → `shell.openExternal`；不自动下载） | ✅ §5.7 |
| U4 | 更新源未定：① GitHub Releases API（未认证限流）；② `pi-desktop-website` 静态 feed | ⬜ §11.3.2（人工确认） |
| U5 | 签名/公证是否需要待人工确认 | ⬜ §11.3.3 |
| U6 | `forge.config.ts` 的 makers 与资产清单对应（Squirrel/ZIP/DMG/RPM/DEB） | ✅ `forge.config.ts:43-49` |
| U7 | 常量已就绪：`DEFAULT_UPDATE_FEED`、`UPDATE_CHECK_TIMEOUT_MS` | ✅ `src/main/constants.ts:55-56` |
| U8 | GitHub latest API 返回 `tag_name`（形如 `v0.1.0`）与 `html_url` | ⬜ 实现时手动 GET 一次记录字段；比较前须剥离 `v` 前缀 |

### 3.3 工作流骨架（形态，非最终 YAML）

`ci.yml`：

```
on: { push: { branches: [main] }, pull_request: {} }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
jobs.build:
  strategy: { fail-fast: false, matrix: { os: [windows-latest, ubuntu-latest, macos-latest] } }
  steps:
    - actions/checkout@v4
    - git clone --branch Branch_v1.1.0 --depth 1 <pi-url> ../pi
    - git clone --branch Branch_v0.11.1 --depth 1 <pi-web-url> ../pi-web
    - actions/setup-node@v4 (node-version: 24.21.0, cache: npm)
    - if linux: sudo apt-get update && sudo apt-get install -y fakeroot rpm
    - npm ci
    - node scripts/pin-upstream.mjs
    - npm run typecheck
    - node scripts/smoke-desktop.mjs          # 门禁（用同版 Node 起服务 + 四项断言）
    - npm run make
    - actions/upload-artifact (out/make/**)
```

`release.yml`：

```
on: { push: { tags: ['v*'] }, workflow_dispatch: {} }
jobs.build: 同 ci 的矩阵与步骤（含门禁）
  - 校验 package.json.version == tag（去 v 前缀）
  - actions/upload-artifact → 汇总 job（download-artifact, merge-multiple）
  - softprops/action-gh-release@v2
      files: |
        **/*.exe
        **/*.nupkg
        **/RELEASES
        **/*.zip
        **/*.dmg
        **/*.deb
        **/*.rpm
      generate_release_notes: true
```

要点：

- **不在 release 里复用 CI 的缓存假设**：release 每次全量构建（避免把 CI 的临时产物当作发布产物）。
- **不在 release 里签名**（FR-011-010）；发布说明模板中固定包含未签名指引（FR-011-011）。
- **上游仓库地址**：CI 中通过 `git clone <url>` 拉取；⬜ URL/组织名需按本仓库实际配置确认（`https://github.com/fellow99/pi-desktop` 已定，上游 `pi`/`pi-web` 的 fork/组织归属待确认）。

## 4. 数据模型

### 4.1 实体

| 实体 | 字段 | 说明 |
|---|---|---|
| `UpdateSource` | `{ kind: 'github-release' \| 'static-feed'; url: string; timeoutMs: number }` | 来源抽象（FR-011-014） |
| `UpdateCheckResult` | `{ status: 'none' \| 'available' \| 'error'; currentVersion: string; latestVersion?: string; releaseUrl?: string; reason?: string }` | 一次检查结论（供 003/006 展示） |
| 版本 | `{ major, minor, patch, prerelease? }` | 语义化比较的输入 |
| 节流状态 | `{ lastAutoCheckAt: number \| null }` | 内存态（进程内，不落盘） |

### 4.2 状态机（应用内检查）

```
idle
  → checking    （发起 GET；按钮进入进行中态）
  ├─ 200 + 版本解析成功 + latest > current → available（弹窗 + 打开下载页）
  ├─ 200 + 版本解析成功 + latest <= current → none（提示已是最新）
  └─ 超时 / 非 200 / 解析失败 → error（可读提示 + 日志含状态码）
  → idle（节流窗口按需更新）
```

### 4.3 校验规则

- 版本解析：`tag_name` 剥离可选 `v`/`V` 前缀；`MAJOR.MINOR.PATCH[-prerelease]` 形式；解析失败 → `error`（不猜）。
- 比较：逐段数值比较；`prerelease` 视为低于同版本正式版；结果只用于「是否提示」，不用于其它判断。
- 超时：`AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS)`；超时视为 `error`（`reason: 'timeout'`）。
- 更新源为空/非 http(s) → 直接 `error`（不发起请求）。
- 节流：自动检查在 `lastAutoCheckAt` 距今 < 24 h 时跳过；手动检查不受限。

## 5. 接口契约

### 5.1 提供接口（本模块导出）

| 导出 | 签名 | 说明 |
|---|---|---|
| `checkForUpdates(opts?)` | `(o?: { manual?: boolean; source?: UpdateSource }) => Promise<UpdateCheckResult>` | 统一入口（003 托盘项、006 壳层动作都调它） |
| `compareVersions(a, b)` | `(a: string, b: string) => number \| null` | 纯函数：语义化比较（便于单测） |
| `resolveUpdateSource()` | `() => UpdateSource` | 解析默认/覆盖的更新源 |

### 5.2 消费接口（本模块依赖）

| 来源 | 符号 |
|---|---|
| `electron` | `app.getVersion()`、`shell.openExternal`、（提示用）`dialog` 或经 002 的界面能力 |
| 全局 `fetch` | 查询更新源（Node 24 内置） |
| `src/main/constants.ts` | `DEFAULT_UPDATE_FEED`、`UPDATE_CHECK_TIMEOUT_MS` |
| `src/main/logger.ts` | `logInfo/logWarn/describeError` |
| 003-tray / 006-preload | 入口与状态回调（`updateState`） |

### 5.3 事件与通道

| 通道 | 方向 | 载荷 | 说明 |
|---|---|---|---|
| 托盘菜单项 `check-for-updates` | 用户 → 主进程 | — | 003 的菜单动作 → `checkForUpdates({ manual: true })` |
| `pi-desktop:check-for-updates` | 壳层页面 → 主进程（invoke） | — | 006 的壳层动作（仅 `file://` 文档） |
| 更新源 GET | 主进程 → 外网 | HTTP GET（无用户数据） | 唯一外呼行为（FR-011-019） |

> **无数据面 IPC**；应用内检查的结论通过返回值/弹窗呈现，不经 IPC 传会话数据。

## 6. 实现策略

### 6.1 架构模式

**工作流 + 一个纯逻辑模块**：发布层是两个 YAML 工作流（形态固定、无运行时代码）；应用层是 `update-check.ts`——版本比较为纯函数、检查流程用一个 `async` 函数串起来（`resolve source → fetch(timeout) → parse → compare → decide`）。

### 6.2 关键算法

- **语义化比较**：拆分为数值段 + 可选 prerelease；逐段比较；`null` 表示不可比较（调用方按 `error` 处理）。
- **来源解析**：`resolveUpdateSource()` 先看运行时覆盖（⬜ 是否加环境变量/Settings；本版可仅用常量），再看 `DEFAULT_UPDATE_FEED`。
- **响应处理**：仅接受 `res.ok`；对 GitHub API 额外读取 `tag_name`/`html_url`；对静态 feed 读取约定的 `version`/`url` 字段（⬜ 字段名待官网实现后定）。
- **提示与打开**：`dialog.showMessageBox`（或经 002 的能力）→ 用户确认 → `shell.openExternal(releaseUrl)`。

### 6.3 错误处理

- 所有失败路径都返回 `UpdateCheckResult{status:'error', reason}` 并 `logWarn`（含状态码/超时标记），**不抛到调用方**（避免托盘菜单点击导致未捕获异常）。
- `shell.openExternal` 失败 → `logWarn` + 提示「请手动访问 <url>」。
- **严禁空 catch**：`update-check.ts` 内每个 catch 都必须产出 `reason` 并留痕。

### 6.4 性能

- 单次检查：一次 GET + 一次 JSON 解析；上限由超时约束（8 s）。
- 无轮询、无后台定时检查（节流仅记录时间戳）。

## 7. 测试考量

| 层次 | 方式 | 覆盖需求 |
|---|---|---|
| 静态 | `npm run typecheck` | 全部 |
| 单元 | `compareVersions()`：`0.9.0` vs `0.10.0`、相等、更旧、带 prerelease、非法输入 | FR-011-015 |
| 单元 | `checkForUpdates()`：mock fetch → 200 更高版本 / 200 相同版本 / 404 / 429 / 超时 / 非法 JSON 六种输入，断言 `status` 与 `reason` | FR-011-016、FR-011-018 |
| 单元 | 节流：两次自动检查在 24 h 窗口内只发出一次请求；手动检查不受限 | FR-011-020 |
| 集成 | 真实网络（可选）：对 `DEFAULT_UPDATE_FEED` 发一次请求，记录字段与限流表现（写入 `docs/构建验证记录.md`） | FR-011-014、§7 约束 |
| 工作流 | 本地 `act` 或真实 push/tag：CI 绿灯；tag 与版本不一致时 `release.yml` 失败 | FR-011-001…012 |
| 负向 | 断网执行检查 → 断言提示「无法检查更新」且应用可用；日志含原因 | FR-011-018 |
| 发布 | 打一个 `v0.1.0-rc.*` 预发布 tag 演练一次，核对资产清单与发布说明 | FR-011-009、FR-011-011 |

## 8. 文件清单

| 文件 | 用途 | 状态（2026-10-12 复核） |
|---|---|---|
| `.github/workflows/ci.yml` | 三 OS 矩阵 + 门禁 + 打包 + 产物上传 | ✅ 已存在（96 行；含 `concurrency`、`pin-upstream`、`smoke-desktop`、`electron-forge make`、`upload-artifact`。⚠️ 实际用 `npx --no-install electron-forge make` 而非 `npm run make`，以避免 `premake` 钩子重复执行前置步骤 —— 与 §3.3 骨架的写法不同但语义等价） |
| `.github/workflows/release.yml` | tag 触发 → 三 OS 构建 → Release 资产 | ✅ 已存在（144 行；`softprops/action-gh-release@v2`、`generate_release_notes: true`）。⚠️ 设了 `fail_on_unmatched_files: false`，与 FR-011-009「资产清单必须齐全」不一致 → 需对齐实现或按「FR 只追加不修订」追加一条记录该决定的 FR；⬜ tag 与 `package.json.version` 一致性校验未见 |
| `src/main/update-check.ts` | 检查更新（来源解析/版本比较/提示/打开外链） | ✅ 已存在（97 行；`checkForUpdates` / `openDownloadPage`） |
| `src/main/constants.ts` | `DEFAULT_UPDATE_FEED`、`UPDATE_CHECK_TIMEOUT_MS` | ✅ 已存在（56 行） |
| `src/main/logger.ts` | 检查结果与失败原因留痕 | ✅ 已存在（86 行） |
| `src/main/tray.ts`（003） | 「检查更新」菜单项与进行中状态 | ✅ 已存在（87 行） |
| `src/preload/index.ts`（006） | 壳层动作 `checkForUpdates`（通道 `pi-desktop:check-updates`） | ✅ 已存在（34 行） |
| `README.md` / `docs/发布与更新.md` | 制包、未签名说明、更新源与升级指导 | ✅ 均已存在（⬜ 需核对未签名指引与更新源章节是否完稿） |
| `package.json` | `version`（唯一权威版本来源） | ✅ 已存在（0.1.0） |

## 9. 与规格交叉引用

| 规格需求 | 实现落点 |
|---|---|
| FR-011-001…006（CI 触发/矩阵/步骤/克隆/门禁/产物） | §3.3 `ci.yml` 骨架 + §7 工作流用例 |
| FR-011-007…012（Release 触发/资产/不签名/指引/版本校验） | §3.3 `release.yml` 骨架 + §3.1 决策表 |
| FR-011-013…020（应用内检查：入口/来源/比较/提示/不自动/失败可见/无用户数据/节流） | §4.2 状态机 + §5.1 接口 + §6.2/§6.3 |
| FR-011-021…023（版本权威 / 关于信息 / 文档） | §8 文件清单 + 006 `getInfo()` |
| §5 验收场景 S1–S7 | §7 测试考量（S1/S2/S3/S4 工作流；S5/S6/S7 单元+集成+负向） |
