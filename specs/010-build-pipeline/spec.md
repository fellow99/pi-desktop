# 010 — 构建流水线（build-pipeline）功能规格

> **Module:** 010-build-pipeline（构建流水线）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应方案:** [`./plan.md`](./plan.md)
> **实现落点:** `scripts/prepare-next.mjs`、`scripts/collect-pi.mjs`、`scripts/smoke-desktop.mjs`、`scripts/pin-upstream.mjs`、`forge.config.ts`
> **规划依据:** `docs/工程规划.md` §8.1（四阶段 + 门禁）、§8.2（原生件）、§8.3、§8.4、§8.5、附录 A、§11.1 R2/R11/R12

## 1. 模块概述

### 1.1 目的

构建流水线模块的职责是：**用一条可复现的命令链，从「两个 sibling 上游源码」产出可安装的三平台产物**。

四阶段（✅ §8.1）：

```
① prepare-next.mjs   ：../pi-web：npm ci → next build → 平台裁剪（在副本上）→ 轮换预览密钥
② smoke-desktop.mjs  ：门禁（同版 Node 24.21.0 起服务，四项断言全绿才允许打包）
③ collect-pi.mjs     ：组装 pi-dist → tar.gz(ustar) → SHA-256
④ forge make         ：asar + extraResource(pi-dist.tar.gz) + makers（三平台）
```

### 1.2 解决的问题

- **两端版本必须同源**：`pi-web` 依赖 `pi` 的**精确版本 1.1.0**；用 sibling 源码引用可保证同源同版本（✅ §2.5）。因此构建脚本必须能同时消费 `../pi` 与 `../pi-web`。
- **`.next` 必须在目标平台本机重建**：`pi-web` 的产物需要在构建机上重新 `next build`，才能控制 `serverExternalPackages`、做平台裁剪、并在打包前完成预览密钥轮换（🔶 §2.5 的三条理由）。
- **原生件必须按目标平台裁剪**：`node-pty` 的 `prebuilds/` 内含多平台目录；跨平台打包或不做裁剪会导致 Linux maker strip 时误伤其它架构的 `.node`（✅ §8.5 平台注意事项 3）。
- **不能删除源目录**：裁剪若作用在 `../pi-web` 上，会破坏用户的工作区与后续构建（🔶 HOS v1.1 的修正结论：裁剪必须在**副本**上做）。
- **门禁前置**：产物组装与打包耗时很长，必须先用一个便宜的「起服务 + 四项断言」门禁挡住坏产物（✅ §8.1 阶段 ②）。
- **可复现**：上游是分支/sibling，必须把解析到的 commit SHA 钉住并记录（`upstream.lock.json`），否则「同一个 tag 构建出不同产物」无法解释。

### 1.3 范围

**包含**

- 四个构建脚本（准备 / 门禁 / 组装 / 钉版本）与 Forge 打包配置。
- 同版 Node 约束、平台裁剪、预览密钥轮换、tar.gz(ustar) 与 SHA-256 产出。
- 本地质量门（`npm run typecheck` + smoke）与 premake/prepackage 自动串联。
- 构建期失败语义（非零退出、不产出半成品）。

**不包含**

- CI 工作流与发布资产上传 → 011-release-update。
- 运行时的解压/marker/断言 → 009-artifact-bootstrap。
- 运行时配置策略与模板内容 → 008-runtime-config。
- 应用内「检查更新」→ 011-release-update。
- 代码签名与公证（§9.2、Phase 3）。

## 2. 用户故事

- 作为开发者，我希望一条命令（`npm run make`）就能从干净工作区产出安装包，不需要手工记步骤。
- 作为开发者，我希望构建脚本明确告诉我「哪一步失败、为什么失败」（npm ci 网络、build 报错、门禁断言、tar 产出）。
- 作为发布者，我希望每次构建都能记录上游 commit SHA，出问题时能精确复现。
- 作为维护者，我希望构建脚本**不修改** `../pi` 与 `../pi-web` 的源码（裁剪在副本上做），避免污染 sibling 工作区。
- 作为用户，我希望安装包里带的是**目标平台**的原生件（不会出现「在 Windows 上装了 arm64 的 .node」）。
- 作为安全评审者，我希望打包产物的门禁里包含「带凭据的 API 可用」与「SSE 可建连」这两条，而不是只看能不能启动。

## 3. 功能需求

动作词：**MUST** 必须满足；**MUST NOT** 禁止；**SHOULD** 建议；**MAY** 可选。

### 3.1 阶段 ①：准备 pi-web 产物

- FR-010-001：系统 MUST 提供 `scripts/prepare-next.mjs`，按序执行：`../pi-web` 下 `npm ci` → 生产构建（`next build`）→ 平台裁剪 → 预览密钥轮换（复用上游 `bin/rotate-preview-secrets.js`）。
- FR-010-002：裁剪 MUST 在**副本**（`pi-dist` 工作目录）上进行；**MUST NOT** 删除或改写 `../pi-web` 源目录中的任何文件。
- FR-010-003：系统 MUST 在准备阶段复核 `node-pty` 的原生件可用性（预构建是否 N-API；⬜ P0-3），并在不可用时按登记策略处置（`@electron/rebuild` 重编或裁剪 + 终端降级），**MUST NOT** 静默忽略。

### 3.2 阶段 ②：冒烟门禁

- FR-010-004：系统 MUST 提供 `scripts/smoke-desktop.mjs`，使用**与 Electron 同版本**的 Node（24.21.0）启动 Next 服务器并断言四项：
  1. `GET /` 返回 SPA（含 Pi Web UI 标记）；
  2. `GET /api/web-auth` 与**一条带凭据的 `/api/*`** 返回 200；
  3. SSE `GET /api/agent/[id]/events` 可建连（响应 `Content-Type: text/event-stream`）；
  4. pi SDK 可创建 `AgentSession`（不调用模型）。
- FR-010-005：门禁 MUST 是**阻断式**的：任一项失败即非零退出，MUST NOT 继续打包。
- FR-010-006：门禁 MUST 在打包之前执行（`premake`/`prepackage` 链或 CI 步骤顺序保证）。
- FR-010-007：门禁 MUST 输出可读结论（每个断言一行结果 + 失败时的响应码/片段），便于 CI 定位。

### 3.3 阶段 ③：组装产物

- FR-010-008：系统 MUST 提供 `scripts/collect-pi.mjs`，组装 `pi-dist`：`pi-web` 的生产产物（`.next/**`、`public/**`、`next.config.ts`、`package.json`、`bin/`）+ `node_modules/`（`@earendil-works/{pi-coding-agent,pi-agent-core,pi-ai,pi-tui}` 与其余运行依赖）+ `config/` 预置模板（§8.1 ③）。
- FR-010-009：组装 MUST 产出 `pi-dist.tar.gz`，打包格式 MUST 为 **ustar**（`--format=ustar`）。
- FR-010-010：组装 MUST 产出归档的 SHA-256（供 009 的 marker 与期望值使用），且 MUST NOT 用「存在性」替代哈希语义。
- FR-010-011：组装 MUST 排除无用内容：`.next/cache`、devDependencies、非目标平台的 prebuilds。
- FR-010-012：产物写入 MUST 先写临时文件再原子重命名（或等价手段），**MUST NOT** 在失败时留下「看似完整」的 tar 包或哈希文件。

### 3.4 阶段 ④：Forge 打包

- FR-010-013：系统 MUST 通过 `forge.config.ts` 配置打包：`asar: true`、`prune: false`、`derefSymlinks: true`、`executableName: 'pi-desktop'`、`icon: 'resources/icon'`、`appBundleId: 'com.fellow99.pi.desktop'`。
- FR-010-014：系统 MUST 把 `pi-dist.tar.gz` 与 `resources/` 图标作为 `extraResource` 随包分发（✅ 已有配置）。
- FR-010-015：系统 MUST 配置 makers：Squirrel（Windows）、ZIP（darwin/linux/win32）、DMG（macOS）、RPM 与 DEB（Linux）。
- FR-010-016：系统 MUST 配置 Fuses 六项：`RunAsNode:false`、`EnableCookieEncryption:true`、`EnableNodeOptionsEnvironmentVariable:false`、`EnableNodeCliInspectArguments:false`、`EnableEmbeddedAsarIntegrityValidation:true`、`OnlyLoadAppFromAsar:true`。
- FR-010-017：系统 MUST 让 `npm run make` 一条命令可复现：`prepackage`/`premake` 钩子自动执行 `prepare-next.mjs` 与 `collect-pi.mjs`（✅ `package.json` 已有该钩子形态）。
- FR-010-018：系统 MUST NOT 交叉打包：每个平台在目标平台 runner 上构建自己的产物（原生件与目标平台一致）。

### 3.5 版本钉住与质量门

- FR-010-019：系统 MUST 提供 `scripts/pin-upstream.mjs`，把 `../pi` 与 `../pi-web` 解析到的 commit SHA 写入 `upstream.lock.json`。
- FR-010-020：`upstream.lock.json` MUST 进版本控制（可复现的证据），且其变化 MUST 在评审时可见。
- FR-010-021：系统 MUST 把 `npm run typecheck`（strict TS）作为本地与 CI 的质量门，且 MUST 与 smoke 门禁同为本工程的出包前置。
- FR-010-022：构建脚本 MUST 使用 Node ESLint 之外的**零依赖**方式实现（`.mjs` + Node 内置模块），不引入构建框架；可被三平台 shell 直接调用。
- FR-010-023：系统 SHOULD 支持 `ELECTRON_MIRROR` 等镜像环境变量以缓解 Electron 二进制下载慢（CI/本地，🔶 dsh 经验）。
- FR-010-024：所有构建脚本 MUST 使用统一日志前缀 `[pi-desktop]` 或等价的一致格式，并在失败时打印「阶段 + 命令 + 退出码 + 关键输出尾部」。

### 3.6 目录与配置纪律

- FR-010-025：系统 MUST 保持 `docs/工程规划.md` §6.2 的目录结构（`scripts/`、`config/`、`resources/`、`src/**`、`forge.config.ts`、`vite.{main,preload,renderer}.config.ts`）。
- FR-010-026：系统 MUST NOT 依赖 `../pi-desktop-hos` 参与构建（它只是只读参考；`tar-extract` 是**移植**而非引用）。

- FR-010-027：`prepare-next` MUST 在 `npm ci` 之后、`next build` 之前校验**原生依赖完整性**：对 `node-pty`，`build/Release/*.node` 与 `prebuilds/<platform>-<arch>/*.node` **至少一处存在真实二进制**；都缺失 ⇒ **构建失败**并给出可照做的修法。（动机：上游 `scripts/prebuild.js` 只判断 `prebuilds/<triple>/` **目录是否存在**，空目录会被误判为「已预构建」而跳过 `node-gyp`，症状要到运行期终端 500 才暴露 —— 本工程 2026-10-13 实测踩到。）

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| 流水线阶段 | 四个阶段 + 门禁 | `prepare` / `smoke` / `collect` / `make`；顺序固定 |
| 门禁断言 | 四项断言 | SPA 标记、API 200（含凭据）、SSE `text/event-stream`、`AgentSession` 可创建 |
| 上游锁 | `upstream.lock.json` | `pi.commit`、`pi-web.commit`、解析时间、（可选）tag/branch |
| 产物清单 | `pi-dist` 内容 | `.next/**`、`public/**`、`next.config.ts`、`package.json`、`bin/`、`node_modules/`、`config/` |
| 平台裁剪矩阵 | 目标平台 × 保留内容 | 目标平台 `-<arch>` 的 prebuilds；剔除其它平台与 `.next/cache` |
| 打包配置 | `forge.config.ts` | `asar` / `prune` / `executableName` / `extraResource` / makers / Fuses |

## 5. 验收场景

### 场景 S1：一条命令可复现

- Given 干净工作区，`../pi`（Branch_v1.1.0）与 `../pi-web`（Branch_v0.11.1）已就位
- When 执行 `npm ci && npm run make`
- Then 依次跑 ①→②→③→④；产出安装包于 `out/make/`；`upstream.lock.json` 已记录两个 commit SHA

### 场景 S2：门禁阻断

- Given 服务器能启动但 `GET /` 不返回 SPA 标记（例如构建产物损坏）
- When 执行 `npm run make`
- Then smoke 门禁失败、非零退出、**不产出** tar 包与安装包

### 场景 S3：源目录不被污染

- Given 执行过一次完整流水线
- When 检查 `../pi-web` 的 `git status`
- Then 无任何被修改/删除的文件（裁剪只作用于副本）

### 场景 S4：目标平台原生件正确

- Given 在 Windows x64 上构建
- When 检查 `pi-dist` 内的 `node-pty` prebuilds
- Then 只包含目标平台/架构的 `.node`（其它平台目录已被裁剪）

### 场景 S5：ustar 与哈希

- Given 已产出 `pi-dist.tar.gz`
- When 用 `tar -tvf` 查看并校验哈希
- Then 格式为 ustar；`pi-dist.version` 内容等于归档的 SHA-256

### 场景 S6：无半成品

- Given 组装阶段在写 tar 过程中失败（磁盘满）
- When 检查工作目录
- Then 不留下可被 009 误判为完整的 `pi-dist.tar.gz` 与哈希文件

### 场景 S7：类型与冒烟双门禁

- Given 代码存在类型错误
- When 执行 `npm run typecheck`
- Then 非零退出；CI 同样以两者为准

### 场景 S8：镜像下载可加速

- Given 设置 `ELECTRON_MIRROR`
- When 执行 `npm ci`
- Then Electron 二进制从镜像下载成功（构建不因此失败）

## 6. 非功能需求

- **可复现性**：上游 commit SHA 钉住（`upstream.lock.json`）；构建命令链固定；不依赖本地缓存的存在性假设。
- **可诊断性**：每阶段有开始/结束日志；失败打印阶段名、命令、退出码与关键输出尾部。
- **时长**：⬜ CI 三 OS 矩阵时长待实测；`concurrency` 取消在途属 011。
- **体积**：目标为安装包 ≈ 250 MB（Electron，🔶 通用量级）+ ≈116 MB（归档，🔶 HOS 同源）+ 壳层数 MB；⬜ 实测（R12）。
- **跨平台**：脚本在 Windows/macOS/Linux 均可运行（路径分隔符、`rm -rf` 等价物、`tar` 参数差异需在实现中处理）。
- **零上游改动**：流水线不改 `../pi` / `../pi-web`（补丁集 0 条，§7）。
- **不引入构建框架**：脚本零第三方依赖，便于 CI 与本地一致。

## 7. 假设与约束

- **假设（✅ §8.1、附录 A）**：四阶段与门禁的形态、命令名（`prepare-next` / `smoke-desktop` / `collect-pi` / `pin-upstream`）与 `package.json` 脚本名均已定稿，且 `package.json` 已声明 `prepare:next` / `smoke` / `collect:pi` / `pin:upstream` / `prepackage` / `premake`（✅ 已存在）。
- **假设（✅ §2.5）**：`pi-web` 的 `.next` 必须本机可再生构建；上游 npm tarball 的预构建 `.next` 无法做目标平台裁剪。
- **约束**：`npm ci` 需要网络；离线环境需预置 `node_modules` 或镜像（⬜ 本版不实现离线构建）。
- **约束（⚠️ R2）**：`node-pty` 在 Electron ABI 148 下能否加载未定；本模块只负责「判定 + 按策略处置 / 登记降级」，**不修改上游源码**（属构建配置问题，✅ §7 补丁表）。
- **约束（§8.5 平台注意事项）**：Linux rpm 打包会 strip 二进制 → 原生件必须先裁剪；`executableName: 'pi-desktop'` 是为了避免 productName 带空格导致 maker 名称不匹配。
- **约束**：三平台各自构建各自产物，**不做交叉打包**（否则原生件与目标平台不一致）。
- **⬜ 待验证凭据**：`smoke-desktop.mjs` 的「一条带凭据的 `/api/*`」具体选哪条路由（需挑一条无副作用且免业务状态的只读端点，例如会话列表或配置读取一类；⬜ 实现前需从 `pi-web/app/api/**` 中选定并在脚本注释登记理由）。
- **⬜ 待验证**：`config/` 预置模板是「进 `pi-dist` 归档」还是「独立 extraResource」——规划 §8.1 ③ 写的是进 `pi-dist`；`forge.config.ts` 当前 `extraResource` 未含 `config/`，需与 008 的 FR-008-009 对齐后定案。

## 8. 依赖

**上游（被本模块消费）**

- `../pi`（submodule，`Branch_v1.1.0`）：`npm install` 产出 `@earendil-works/*` 依赖树供 pi-web 消费。
- `../pi-web`（submodule，`Branch_v0.11.1`）：`npm ci` → `next build` → 平台裁剪 → 预览密钥轮换；其 `bin/rotate-preview-secrets.js` 被复用。
- Electron 43.7.9（`package.json` 精确钉版）与同版 Node 24.21.0（门禁与构建）。

**下游（消费本模块）**

- 009-artifact-bootstrap：消费 `pi-dist.tar.gz` 与 SHA-256。
- 011-release-update：CI 调用四阶段脚本并上传产物。
- `README.md`：操作说明（构建/运行/调试命令）。
- `docs/构建验证记录.md`：P0-2/P0-4/P0-6 的证据来源。

**外部**

- `node:child_process`（`spawnSync` 调 npm/next/tar/git）、`node:fs`、`node:path`、`node:crypto`。
- Forge CLI（`@electron-forge/cli` + maker 包 + `plugin-vite` + `plugin-fuses`，✅ `package.json` devDependencies）。
- 平台工具：`tar`（ustar）、`git`（解析上游 SHA）、Linux 侧 `fakeroot`/`rpm`（DEB/RPM maker 依赖）。
