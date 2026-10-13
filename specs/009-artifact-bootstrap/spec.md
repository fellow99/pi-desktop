# 009 — 产物引导（artifact-bootstrap）功能规格

> **Module:** 009-artifact-bootstrap（产物引导）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应方案:** [`./plan.md`](./plan.md)
> **实现落点:** `src/main/artifact.ts`、`src/main/tar-extract.ts`
> **规划依据:** `docs/工程规划.md` §8.1 ③、§8.3、§4.10（HOS 可移植结论）、§11.1 R5/R12、§10（P0-4）

## 1. 模块概述

### 1.1 目的

产物引导模块的职责是：**把随包分发的 `pi-dist.tar.gz` 在首启流式解压到 `<userData>/pi-dist`，并用 SHA-256 marker 保证幂等、用完整性断言保证「解压出的东西真的能跑」**。

它是「安装包体积」与「可写性」两条约束的解（✅ 决策 Q3）：安装包只增约 116 MB（🔶 HOS 同源实测：682 MB → 115.9 MB），而解压目标在用户可写目录，使 pi-web 的**预览密钥轮换**成为可能（只读目录会保留构建期固化的密钥，留下 `x-prerender-revalidate` 绕过 `proxy.ts` 的口子）。

### 1.2 解决的问题

- **不能直接用 `extraResources` 目录**：dsh 的做法是把 ≈1 GB / 5.6 万文件的原始目录塞进包（§2.6 对照），体积大且只读 → 密钥不可轮换。改用单个 tar.gz 显著减小安装包并解决可写性。
- **首启耗时与失败**：数万文件的解压会失败（磁盘满、进程被杀、断电），必须有幂等标记与可重入语义，否则用户要面对「每次都重解压」或「半残目录」。
- **升级不残留**：新版本归档解压到旧目录之上会残留已删除的旧文件（幽灵文件），必须按 marker 变化做「清理后重解压」。
- **静默的半残产物**：解压到一半被杀会留下「目录看起来存在」的树；只靠「目录存在」判断会永久卡在坏状态，因此必须有完整性断言。
- **进度可见**：解压是启动期最长的阶段（数十秒量级），必须向 loading 页暴露阶段与文件数、耗时（fail-visible）。

### 1.3 范围

**包含**

- 归档定位（打包态 `process.resourcesPath` / 开发态仓库根）与 `pi-dist.version`（期望 SHA-256）的读取。
- `pi-dist.tar.gz` → `<userData>/pi-dist` 的**流式** ustar+gzip 解压。
- marker 幂等：`<userData>/pi-dist.sha256` 与期望值比较；命中仍做完整性断言；不一致则清理后重解压。
- 完整性断言：Next 服务入口 + `@earendil-works/pi-coding-agent` 存在；返回 `nextEntry` 给 001。
- 失败可重入与诊断（日志 + 诊断槽）。
- 开发出口：`PI_DESKTOP_PI_DIST` 直接指定已解压目录（跳过解压，但仍断言）。

**不包含**

- 归档的**生产**（`collect-pi.mjs` 组装 + `tar --format=ustar` + 写 marker）→ 010-build-pipeline。
- 预览密钥轮换（在解压之后、起服务之前执行）→ 001-host。
- `pi-dist` 的内容裁剪策略（哪些 prebuilds/依赖保留）→ 010。
- 壳预置 `config/` 模板的物化 → 008-runtime-config（模板随 `pi-dist` 分发，物化在 agent 目录）。
- 壳专用 extension/skill 的投放 → 201-plugin-runtime。

## 2. 用户故事

- 作为新用户，我第一次启动时能看着 loading 页的进度（阶段 + 文件数）等完解压，而不是面对白屏猜「是不是卡死了」。
- 作为用户，我希望第二次启动**不再** 解压（秒级进入界面）。
- 作为用户，我希望升级到新版本后应用直接用上新产物，而不是残留旧文件导致行为诡异。
- 作为用户，如果解压中途失败（磁盘满/被杀），我希望重启后能自动重来，而不是永久坏在一个「目录存在但内容不全」的状态。
- 作为排障者，我希望日志里有归档 SHA-256、marker 命中/退化状态、文件数与耗时。

## 3. 功能需求

动作词：**MUST** 必须满足；**MUST NOT** 禁止；**SHOULD** 建议；**MAY** 可选。

### 3.1 归档定位与期望哈希

- FR-009-001：系统 MUST 从额外资源定位归档：打包态取 `process.resourcesPath/pi-dist.tar.gz`，开发态取应用根目录同名文件。
- FR-009-002：系统 MUST 读取同目录的 `pi-dist.version`（内容为归档 SHA-256）作为期望值，并在缺失或格式非法时**退化为「当前归档实际哈希」** 模式并记录 WARN。
- FR-009-003：系统 MUST 在归档缺失或哈希不可计算时以可读错误失败（提示如何生成产物或设置 `PI_DESKTOP_PI_DIST`），**MUST NOT** 静默继续。
- FR-009-004：系统 MUST 支持开发出口 `PI_DESKTOP_PI_DIST`（指向已解压目录）：跳过解压与 marker 校验，但 MUST 仍执行完整性断言。

### 3.2 解压

- FR-009-005：系统 MUST 把归档解压到 `<userData>/pi-dist`。
- FR-009-006：解压 MUST 为**流式**：`createReadStream` + `createGunzip` + ustar 状态机，内存占用与归档大小无关（固定上界由单个 header/padding/小块缓冲决定），**MUST NOT** 把归档或成员内容整体读入内存。
- FR-009-007：解压器 MUST 支持 ustar 的目录条目（typeflag `5`）与常规文件条目（`0`/NUL），并 MUST 跳过其它类型（硬链接/符号链接/pax 扩展等），跳过时 MUST 计数并记录 WARN。
- FR-009-008：解压器 MUST 拒绝路径逃逸：成员名中的绝对路径与 `..` 段 MUST 被识别并拒绝（抛错或跳过 + WARN），MUST NOT 写入 `<userData>/pi-dist` 之外的路径。⚠️ 现状见 §7。
- FR-009-009：归档格式 MUST 由构建侧固定为 `ustar`（`collect-pi.mjs` 产出，010）；解压器 MUST NOT 依赖 pax 扩展头。

### 3.3 marker 幂等

- FR-009-010：系统 MUST 以 `<userData>/pi-dist.sha256`（内容 = 归档 SHA-256）作为幂等标记。
- FR-009-011：幂等判据 MUST 为「marker 内容 === 期望 SHA-256（且目标目录存在）」。**MUST NOT** 退化为「目录存在即跳过」（那会让就地升级不生效）。
- FR-009-012：marker 命中时系统 MUST 仍执行完整性断言（FR-009-014）；断言失败 MUST 强制重新解压（覆盖坏树）。
- FR-009-013：marker 与期望值不一致（升级/换包）时，系统 MUST 先清理 `<userData>/pi-dist` 再解压，保证**不残留旧版本的幽灵文件**。
- FR-009-014：marker 命中但目标目录不存在时，系统 MUST 重新解压（并记录 WARN）。

### 3.4 完整性断言

- FR-009-015：系统 MUST 断言 Next 服务入口存在：按候选路径清单逐个探测（`node_modules/next/dist/server/lib/start-server.js`、`node_modules/next/dist/server/next.js`、`node_modules/next/dist/bin/next`），命中即返回该路径。
- FR-009-016：系统 MUST 断言 `node_modules/@earendil-works/pi-coding-agent` 的入口存在。
- FR-009-017：断言失败时系统 MUST 抛出含「已探测路径清单」的可读错误。
- FR-009-018：系统 MUST 把命中的 Next 入口路径作为 `nextEntry` 交给 001-host 用于启动服务器。
- FR-009-019：断言 MUST 在「marker 命中」、「`PI_DESKTOP_PI_DIST` 指定目录」、「解压完成后」三条路径上都执行。

### 3.5 可观测性与可重入

- FR-009-020：日志 MUST 统一前缀 `[pi-desktop]`，并 MUST 记录：归档路径、归档 SHA-256、期望 SHA-256、marker 状态（命中/缺失/不一致）、解压文件数、耗时。
- FR-009-021：任一失败 MUST 挂到诊断槽 `globalThis.__extractError`（供探针取证）并保留在应用日志中。
- FR-009-022：解压 MUST 可重入：中途失败（进程被杀/磁盘错误）后再次启动 MUST 能清理残留并重新解压，**MUST NOT** 要求用户手工删目录。
- FR-009-023：解压期间 SHOULD 输出阶段性进度（起始/完成；⬜ 是否输出「已解压 N 个文件」的周期性进度待 P0-4 决定，注意避免日志刷屏）。
- FR-009-024：内存行为 MUST 满足 P0-4 的出口判据：解压期间内存不随条目数增长（固定内存）。

### 3.6 安全

- FR-009-025：系统 MUST 只在 `<userData>` 内写入（`pi-dist/` 与 marker 文件）；**MUST NOT** 写其它位置。
- FR-009-026：系统 MUST NOT 执行归档中的任何内容（不解压后运行脚本、不设可执行位依赖），只做文件写入。
- FR-009-027：解压 MUST NOT 覆盖/删除 `pi-dist` 之外的用户数据；清理动作只允许针对 `<userData>/pi-dist`。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| `ArtifactState` | 产物就位后的状态（交给 001/007） | `archivePath`、`piDistRoot`、`markerPath`、`nextEntry: string \| null` |
| 归档 | `pi-dist.tar.gz` | 路径（打包/开发）、SHA-256、大小 |
| 期望哈希 | `pi-dist.version` 或退化模式 | 值来源（`declared` / `actual`） |
| marker | `<userData>/pi-dist.sha256` | 内容（64 位十六进制）、命中判定 |
| 解压器 | 流式 ustar 解析器 | 状态（header/data/padding）、`count`、跳过计数 |
| 入口探测清单 | Next 与 pi SDK 的候选路径 | 3 个 Next 候选 + 1 个 SDK 入口 |

## 5. 验收场景

### 场景 S1：首启解压

- Given `<userData>/pi-dist` 不存在、`pi-dist.tar.gz` 存在
- When 应用启动
- Then 流式解压完成、文件数与源目录一致、日志含 SHA-256 与耗时；loading 页可见解压阶段

### 场景 S2：二次启动不重解压

- Given 上次解压成功且 marker 与期望值一致
- When 应用再次启动
- Then 跳过解压（日志显示 marker 命中），只做完整性断言，秒级进入就绪流程

### 场景 S3：升级重解压且不残留

- Given 归档被替换为新版本（哈希变化）、marker 仍为旧值
- When 应用启动
- Then 旧 `<userData>/pi-dist` 被清理、新归档被解压、marker 更新为新哈希；旧版本独有的文件不再存在

### 场景 S4：半残产物自愈

- Given marker 与期望值一致，但 `<userData>/pi-dist` 内缺少 Next 入口（解压中途被杀）
- When 应用启动
- Then 断言失败 → 强制重新解压 → 启动继续（用户无需手工清目录）

### 场景 S5：归档缺失可见失败

- Given `pi-dist.tar.gz` 不存在
- When 应用启动
- Then 抛出可读错误（提示生成产物或设置 `PI_DESKTOP_PI_DIST`）；窗口显示失败阶段与原因；诊断槽有值

### 场景 S6：开发出口

- Given 设置 `PI_DESKTOP_PI_DIST=<已解压目录>`
- When 应用启动
- Then 跳过解压与 marker 校验，但仍做完整性断言；日志明确记录「使用指定产物目录」

### 场景 S7：内存不随条目增长

- Given 解压 2.7 万量级文件（⬜ 实测基线）
- When 解压进行中采样主进程内存
- Then 内存曲线不随已解压条目数线性增长（固定上界）

### 场景 S8：路径逃逸被拒

- Given 构造一个含 `../evil.txt` 或绝对路径条目的测试归档
- When 解压
- Then 该条目被拒绝/跳过并记录 WARN；`<userData>/pi-dist` 之外不产生任何文件

## 6. 非功能需求

- **性能**：解压复杂度 O(n)（单遍状态机）；⬜ 首启解压 + 就绪耗时依 P0-4 实测（🔶 HOS 同源参考：约 15 s 含起服务）。
- **内存**：固定内存（FR-009-006、FR-009-024）；这是与旧实现（O(n²) 曾在真机卡死，🔶 HOS 结论）的关键差异，不得回退。
- **可靠性**：幂等 + 可重入 + 断言（三道防线），任何一道命中都能自愈。
- **可观测性**：SHA-256、marker 状态、文件数、耗时四要素必须落日志。
- **安全**：只写在 `<userData>` 内；拒绝路径逃逸；不执行归档内容。
- **磁盘**：解压后 `<userData>/pi-dist` 为解压态体积（🔶 HOS 参考 ≈682 MB）；磁盘不足时必须给出可读失败（不留下被误判为完整的树）。

## 7. 假设与约束

- **假设（✅ 决策 Q3、§8.3）**：`pi-dist.tar.gz` + 首启解压是既定方案；marker 内容 = 归档 SHA-256；解压目标 `<userData>/pi-dist`。
- **假设（🔶 沿用 HOS）**：流式 ustar 解压器（`tar-extract.js` 的形态）可直接移植；旧实现 O(n²) 曾卡死，**不得**回退到非流式实现。
- **约束**：归档格式固定 `ustar`（`tar --format=ustar`），因此解压器不需要处理 pax/GNU 长名扩展；出现其它类型条目按「跳过 + WARN」处置。
- **约束**：⚠️ **路径逃逸校验当前缺失**：`src/main/tar-extract.ts:171,174` 直接把成员名 `join(destBase, name)` 拼接（`readHeader` 只剥离 `./` 与 `pi-dist/` 前缀，不做 `..`/绝对路径拒绝）。本规格 FR-009-008 要求补齐；在补齐前该风险登记为 ⚠️（归档由本工程自行生成，风险面受控，但不得作为长期状态）。
- **约束**：不删除 `pi-dist` 之外的任何数据；升级清理范围严格限定 `<userData>/pi-dist`。
- **⬜ 待验证（P0-4）**：解压文件数与源目录一致；二次启动不再解压；tar 变更后重新解压；内存不随条目增长；首启耗时实测值。
- **⬜ 待验证**：`pi-dist.version` 的生成位置（`resources/` 还是仓库根）与 `forge.config.ts` 的 `ignore`/`extraResource` 是否已覆盖（当前 `forge.config.ts:38` 的 `extraResource` **未包含** `pi-dist.version`，而 `ignore` 已排除它 → 需在 010 中确认期望哈希在打包态如何分发）。

## 8. 依赖

**上游（被本模块消费）**

- 010-build-pipeline：产出 `pi-dist.tar.gz`（ustar）与 `pi-dist.version`；决定 `pi-dist` 的内容清单。
- `pi-web` 产物布局：`node_modules/next/dist/server/lib/start-server.js`、`node_modules/@earendil-works/pi-coding-agent/dist/index.js`（断言目标的依据）。

**下游（消费本模块）**

- 001-host：`piDistRoot` + `nextEntry`（起服务与密钥轮换的目录）。
- 007-app-entry：启动序中的 `[artifact]` 阶段与阶段文本。
- 005-lifecycle：退出时**不得**删除 `pi-dist`（FR-009-025 与 005 FR-005-019 一致）。

**外部**

- `node:fs`（`createReadStream` / `openSync` / `writeSync` / `mkdirSync` / `rmSync`）、`node:zlib`（`createGunzip`）、`node:crypto`（`createHash('sha256')`）、Electron `app`（`getPath`/`getAppPath`/`isPackaged`/`process.resourcesPath`）。
