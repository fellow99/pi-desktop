# 009 — 产物引导（artifact-bootstrap）技术实现方案

> **Module:** 009-artifact-bootstrap（产物引导）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应规格:** [`./spec.md`](./spec.md)
> **架构基线:** `docs/工程规划.md` §8.1 ③、§8.3、§4.10、§11.1 R5/R12、§10（P0-4）

## 1. 技术上下文

### 1.1 运行时环境

- **运行位置**：Electron 主进程；启动序中的 `[artifact]` 阶段（先于任何 pi / pi-web 模块加载，先于宿主启动、先于 001 的密钥轮换）。
- **编译产物**：`src/main/artifact.ts`（✅ 已实现，163 行）+ `src/main/tar-extract.ts`（✅ 已实现，218 行）→ `.vite/build/main.js`。
- **数据落点**：`<userData>/pi-dist/`（解压目标）、`<userData>/pi-dist.sha256`（marker）。
- **归档来源**：打包态 `process.resourcesPath/pi-dist.tar.gz`（`forge.config.ts:38` 的 `extraResource` 已包含）；开发态 `app.getAppPath()/pi-dist.tar.gz`。

### 1.2 依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `electron.app` | 内置 | `isPackaged`、`getAppPath()`、`getPath('userData')`、`process.resourcesPath` |
| `node:fs` | 内置 | `createReadStream`、`openSync`/`writeSync`/`closeSync`、`mkdirSync`、`rmSync`、`existsSync`、`readFileSync`、`writeFileSync` |
| `node:zlib` | 内置 | `createGunzip()`（流式） |
| `node:crypto` | 内置 | `createHash('sha256')` 流式哈希 |
| `src/main/constants.ts` | 本项目（✅ 已存在） | `ARCHIVE_NAME='pi-dist.tar.gz'`、`VERSION_NAME='pi-dist.version'`、`MARKER_NAME='pi-dist.sha256'` |
| `src/main/logger.ts` | 本项目（✅ 已存在） | `logInfo/logWarn/describeError` |
| `src/main/tar-extract.ts` | 本模块 | `createUstarParser()`、`extractTarGz()`（✅ 已实现） |

> 无第三方依赖（不使用 `tar`/`tar-stream`：需要的是**流式、固定内存**的 ustar 子集，自研状态机更可控，且与 HOS 的可移植实现同源）。

## 2. 宪法合规检查

| 原则（`docs/工程规划.md` §3 / §8.3 / §11.4） | 状态 | 说明 |
|---|---|---|
| 只写装配代码（§3 原则 3） | ✅ | 只做「解压 + 校验 + 汇报路径」 |
| 失败可见（§3 原则 5） | ✅ | 断言失败抛可读错误 + 诊断槽 + 日志四要素（FR-009-017、FR-009-020、FR-009-021） |
| 零上游改动（§7） | ✅ | 不改上游；归档由本工程构建产出 |
| 数据安全（§8.3、005） | ✅ | 只写 `<userData>`；退出不删（FR-009-025、FR-009-027） |
| 安装包体积（§8.3、R12） | ✅ | 单归档（🔶 116 MB 量级）替代原始目录树（≈1 GB / 5.6 万文件） |
| 平台差异显式化（§3 原则 6、§8.2） | ✅ | 平台裁剪在**构建期**（010）完成；运行时解压与平台无关 |
| 安全 S3 类（越界写防护） | ⚠️ | ⚠️ 路径逃逸校验当前缺失（`tar-extract.ts:171,174`），FR-009-008 要求补齐 |
| 代码质量：strict TS、无 `as any`、严禁空 catch | ✅ | 已核对：`artifact.ts` 的 catch 均有 WARN 或返回语义；`tar-extract.ts` 无 catch（错误经 `reject` 上抛） |

> 合规结论：唯一 ⚠️ 是路径逃逸校验（未对齐 FR-009-008），其余 ✅。

## 3. 研究结论

### 3.1 关键决策与理由

| 决策 | 理由 | 对应 FR |
|---|---|---|
| 单归档 + 首启解压（而非 `extraResources` 原始目录） | 安装包体积 ≈1/10；解压目标可写 → 预览密钥可轮换；升级语义清晰（✅ Q3、§8.3） | FR-009-001、FR-009-005 |
| 流式 ustar 状态机（非「读全量再解析」） | 固定内存、O(n)；旧非流式/O(n²) 实现曾在真机卡死（🔶 HOS 结论） | FR-009-006、FR-009-024 |
| marker 内容 = 归档 SHA-256（内容寻址） | 「目录存在即跳过」会让就地升级不生效；内容寻址天然覆盖升级与换包 | FR-009-010、FR-009-011 |
| marker 命中仍做完整性断言 | 解压中途被杀会留下「看似完整」的树；只信 marker 会永久卡在坏状态 | FR-009-012、FR-009-014 |
| 哈希不一致 → **清理后**重解压 | 覆盖式解压会残留旧版本幽灵文件（升级不彻底） | FR-009-013 |
| `pi-dist.version` 缺失时退化 | 开发态/临时构建仍可用；退化后仍是内容寻址（tar 变化即重解压） | FR-009-002 |
| 保留 `PI_DESKTOP_PI_DIST` 开发出口 | 摆脱打包往返（§8.4 的开发循环），但仍强制断言 | FR-009-004、FR-009-019 |
| 跳过非文件/目录条目（含符号链接） | `pi-dist` 由本工程在构建期生成，理应为纯目录+文件；遇到其它类型说明归档异常，按「跳过 + WARN」而非崩溃 | FR-009-007 |

### 3.2 上游/实现核实（✅ / 🔶 / ⬜ / ⚠️）

| # | 事实 | 依据 |
|---|---|---|
| U1 | HOS 侧的 `tar-extract.js` 是真正流式的 ustar(.gz) 解压器（状态机、固定内存、O(n)），marker 幂等**不是**「存在性判断」 | 🔶 `docs/工程规划.md` §2.4、§4.10（可移植） |
| U2 | 实测量级：源目录 682 MB / 27,279 文件 → `pi-dist.tar.gz` 115.9 MB；首启解压 + 就绪约 15 s | 🔶 HOS 真机数据（本工程 ⬜ 待实测） |
| U3 | **实现现状**：`ensureArtifact()` 依据 marker 与期望哈希决策，命中时仍 `assertPayloadComplete()`，不一致时 `rmSync` 后重解压，并在三个入口（env 目录 / marker 命中 / 解压后）都断言；`nextEntry` 随 `ArtifactState` 返回 | ✅ `src/main/artifact.ts:87,102,135,143,149,158` |
| U4 | **实现现状**：`readHeader()` 剥离 `./` 与 `pi-dist/` 前缀，typeflag `5` → dir、`0`/NUL → file、其它 → skip 并计数 | ✅ `src/main/tar-extract.ts:39-56,93-106` |
| U5 | ⚠️ **实现现状缺口**：`extractTarGz()` 的 `onDirectory`/`onFile` 直接 `join(destBase, name)`，**未做** `..`/绝对路径拒绝（成员名可逃逸目标目录） | ✅ `src/main/tar-extract.ts:171,174`（对齐 FR-009-008 需补齐） |
| U6 | `forge.config.ts` 的 `extraResource` 仅含 `pi-dist.tar.gz` + `resources/icon.png/tray.png/trayTemplate.png`；`ignore` 已排除 `pi-dist.version` | ✅ `forge.config.ts:26-38` → ⬜ 打包态期望哈希的分发方式待 010 定（见 §3.3） |
| U7 | 预览密钥轮换必须在解压之后、起服务之前（因为 `.next` 位于 `pi-dist` 内、且目标需可写） | ✅ §4.2；🔶 HOS 结论 |

### 3.3 `pi-dist.version` 的分发方式（⬜ 待定，影响 FR-009-002）

三个可选方案（Phase 1 前定案，由 010 落地）：

1. 作为第二条 `extraResource` 加入（`extraResource: ['pi-dist.tar.gz', 'pi-dist.version', ...]`）→ 打包态 `process.resourcesPath/pi-dist.version`，与当前 `artifact.ts:117` 的读取路径一致。**推荐**。
2. 由 `collect-pi.mjs` 把哈希写进 `package.json` 的额外字段（构建期注入）→ 运行时读 `app.getAppPath()` 内的包元数据（需注意 asar 内的可读性）。
3. 去掉 `pi-dist.version`，纯内容寻址（marker 与「当前归档实算哈希」比较）。

无论选哪个：**marker 的内容语义不变**（归档 SHA-256），且退化模式（FR-009-002）必须保留 —— 它保证方案 1/2 缺失时不至于让应用无法启动。

### 3.4 解压状态机（由 `tar-extract.ts` 实现）

```
createReadStream(archive)
  → createGunzip()
      → push(chunk) → createUstarParser()
            state = header:
              读 512B header；首字节 0 → finished（忽略其后所有字节，兼容双零结束块与尾随填充）
              typeflag 5 → onDirectory(name)              （mkdirSync recursive）
              typeflag 0/NUL → 建 sink，state = data
              其它 → onSkip(name, size)（跳过载荷）
            state = data:  按 size 写 sink（openSync('w') + writeSync）
            state = padding: 丢弃 (512 - size%512)%512 的填充字节
      每 chunk 有界：carry ≤ 一个 header/padding 残片（< 512 B）
```

要点：

- **计数器** `parser.count` 只统计文件条目（目录不计），用于日志与 P0-4 的「文件数与源目录一致」断言。
- **结束判定靠首字节 0**，不依赖「两个 512 块」的严格写法（兼容不同 tar 实现的尾随块）。
- **错误传播**：`gunzip` 的 `data`/`end` 事件内 `try/catch` → `reject`（`settled` 保证只 settle 一次）；`createReadStream` 的错误同样 `reject`。

## 4. 数据模型

### 4.1 实体

| 实体 | 字段 | 来源 |
|---|---|---|
| `ArtifactState` | `archivePath`、`piDistRoot`、`markerPath`、`nextEntry: string \| null` | ✅ `artifact.ts:18-27` |
| `HeaderMeta` | `name`、`type: 'dir' \| 'file' \| 'skip'`、`size` | ✅ `tar-extract.ts:37` |
| `Sink` | `write(buf)`、`end()` | ✅ `tar-extract.ts:23` |
| 期望哈希 | `declared: string \| null`（来自 `pi-dist.version`）、`actual: string`（实算） | ✅ `artifact.ts:125-130` |
| marker | `string \| null`（64 位十六进制才被接受） | ✅ `artifact.ts:69-76` |

### 4.2 状态机（产物就位）

```
resolve
  ├─ PI_DESKTOP_PI_DIST 存在 → 断言 → 就位（跳过 marker）
  ├─ 归档缺失 → fail(可读错误)
  ├─ actual = sha256(archive)；declared = read(pi-dist.version)（缺失 → WARN，用 actual）
  ├─ marker === expected 且目录存在
  │     ├─ 断言通过 → 就位（跳过解压）
  │     └─ 断言失败 → WARN + 清理 → 重新解压
  ├─ marker === expected 但目录不存在 → WARN + 重新解压
  ├─ marker 存在且 ≠ expected → 升级路径 → 清理 → 重新解压
  └─ marker 缺失（首次）→ 解压
        解压 → 断言 → 写 marker（内容 = actual）→ 就位
```

### 4.3 校验规则

- `readMarker` 只接受 `/^[0-9a-f]{64}$/`（大小写归一为小写）；`readExpectedHash` 同样只接受 64 位十六进制，否则 WARN 并视为缺失。
- `assertPayloadComplete`：`payloadEntryCandidates()` 三个 Next 候选任一存在 + `@earendil-works/pi-coding-agent/dist/index.js` 必须存在；错误信息包含「已探测 N 处」与缺失的 SDK 路径。
- 清理范围：只允许 `rmSync(state.piDistRoot, { recursive: true, force: true })`，且 `piDistRoot` 必须位于 `<userData>` 下（FR-009-025/027）。
- 解压目标不存在时 `mkdirSync(recursive)` 后开始；marker 在**断言通过之后**才写入（避免把坏树标记为完整）。

## 5. 接口契约

### 5.1 提供接口（本模块导出，✅ 已实现）

| 导出 | 签名 | 说明 |
|---|---|---|
| `resolveArchivePath()` | `() => string` | 打包/开发两态归档路径 |
| `resolveEnvPiDist()` | `() => string \| null` | `PI_DESKTOP_PI_DIST` 开发出口（不存在则抛错） |
| `sha256File(filePath)` | `(p: string) => Promise<string>` | 流式哈希 |
| `assertPayloadComplete(piDistRoot, where)` | `(r: string, w: string) => string` | 完整性断言，返回 Next 入口路径 |
| `ensureArtifact(userData)` | `(u: string) => Promise<ArtifactState>` | 幂等就位（失败抛出） |
| `createUstarParser(handlers)` | `(h: UstarHandlers) => UstarParser` | 流式解析器（可单测） |
| `extractTarGz(archivePath, destBase)` | `(a: string, d: string) => Promise<number>` | 流式解压，返回文件数 |

### 5.2 消费接口（本模块依赖）

| 来源 | 符号 |
|---|---|
| `electron.app` | `isPackaged`、`getAppPath()`、`getPath('userData')`、`process.resourcesPath` |
| `node:fs` / `node:zlib` / `node:crypto` | 文件流、gunzip、哈希 |
| `src/main/logger.ts` | `logInfo/logWarn/describeError` |
| `src/main/constants.ts` | `ARCHIVE_NAME`、`VERSION_NAME`、`MARKER_NAME` |

### 5.3 事件协议

- **无 IPC 通道**；只通过返回值与日志对外沟通。
- 诊断槽：`globalThis.__extractError` 由 007 的 `failVisible()` 写入，本模块负责抛出可读错误。

## 6. 实现策略

### 6.1 架构模式

**解析器与编排分离**：`tar-extract.ts` 是纯解析/IO（可对构造的测试归档单测，无 Electron 依赖）；`artifact.ts` 是幂等编排（定位、哈希、marker、清理、断言）。两者对 001/007 只暴露 `ArtifactState`。

### 6.2 关键算法

- **流式哈希**：`createHash('sha256')` + `createReadStream` 的 `data` 事件累加（✅ `artifact.ts:48`）——注意这是 116 MB 文件的**一次完整读取**：P0-4 SHOULD 记录这一步的耗时（可考虑与解压合并为单次读，⬜ 优化项，不在本版范围）。
- **marker 决策**顺序见 §4.2；**先断言后写 marker**。
- **解压**：见 §3.4；`openSync(destPath, 'w')`（截断写，天然覆盖同名文件）。
- **入口探测**：按 `payloadEntryCandidates()` 顺序 `existsSync` 命中即返回。

### 6.3 错误处理

- 归档缺失 → 抛 `Error`，消息含归档路径与「先跑 `node scripts/prepare-next.mjs && node scripts/collect-pi.mjs`」提示（✅ `artifact.ts:119-122`）。
- 哈希失败/IO 失败 → `reject` 上抛，由 007 落 `globalThis.__extractError` + loading 页。
- `rmSync`/`mkdirSync` 失败 → 上抛（清理失败意味着升级会残留，必须让用户看到）。
- **严禁空 catch**：现有 `readMarker` 的 catch 返回 `null`（显式降级，非空 catch，✅）。

### 6.4 性能

- 解压：单遍、固定内存、O(n)；⬜ P0-4 实测耗时与内存曲线。
- 哈希：额外一次 116 MB 顺序读（⬜ 可优化为与解压合并）。
- marker 命中路径：一次哈希（116 MB）+ 几次 `existsSync`（秒级）→ 二次启动足够快。
- 不缓存归档内容；不保留文件句柄（每个条目写完即 `closeSync`）。

## 7. 测试考量

| 层次 | 方式 | 覆盖需求 |
|---|---|---|
| 静态 | `npm run typecheck` | 全部 |
| 单元 | `createUstarParser()`：用内存构造的 ustar 字节（目录/文件/跳过类型/双零结束块/尾随填充/跨 chunk 边界）断言回调序列与 `count` | FR-009-007、FR-009-009 |
| 单元 | `extractTarGz()`：临时目录 + 构造的 `.tar.gz`，断言文件内容、目录层级、文件数 | FR-009-005、FR-009-006 |
| 单元（**待补**） | 路径逃逸：构造含 `../evil.txt`、`/abs/evil.txt` 的归档 → 断言被拒绝且目标外无文件 | FR-009-008（⚠️ 当前会失败，见 §3.2 U5） |
| 单元 | marker 决策真值表：marker 缺失 / 一致 / 不一致 / 一致但目录缺失 / 一致但断言失败 五种输入 | FR-009-011…014 |
| 单元 | `assertPayloadComplete()`：缺少 SDK 入口 / 缺少全部 Next 候选 / 正常 三种输入 | FR-009-015…017 |
| 探针（**P0-4**） | 真解压：文件数与源目录一致；二次启动不再解压；替换 tar 后重新解压；解压期间内存不增长 | FR-009-006、FR-009-012、FR-009-022、FR-009-024 |
| 集成 | `PI_DESKTOP_PI_DIST` 指向已解压目录 → 跳过解压但仍断言（含指向坏目录的负向） | FR-009-004、FR-009-019 |
| 负向 | 归档缺失 / marker 为非法内容 / 解压中途 kill 进程后重启 | FR-009-002、FR-009-003、FR-009-012、FR-009-022 |
| 安全 | 断言解压与 marker 只在 `<userData>` 内产生写入（用只读旁路目录探测） | FR-009-025、FR-009-027 |

## 8. 文件清单

| 文件 | 用途 | 状态（2026-10-12 复核） |
|---|---|---|
| `src/main/artifact.ts` | 定位 / 哈希 / marker 幂等 / 清理 / 完整性断言 | ✅ 已存在（163 行） |
| `src/main/tar-extract.ts` | 流式 ustar(.gz) 解压器（可单测） | ✅ 已存在（218 行；⚠️ 路径逃逸校验仍缺失，见 §3.2 U5） |
| `src/main/constants.ts` | `ARCHIVE_NAME` / `VERSION_NAME` / `MARKER_NAME` | ✅ 已存在（56 行） |
| `src/main/logger.ts` | 四要素日志 | ✅ 已存在（86 行） |
| `pi-desktop/pi-dist.tar.gz` | 构建产物（不进 git；`forge.config.ts` 的 `ignore` 已排除） | ⬜ 由 010 产出（`scripts/collect-pi.mjs` 已存在） |
| `pi-desktop/pi-dist.version` | 期望 SHA-256（分发方式待定，见 §3.3） | ⬜ 由 010 产出 |
| `scripts/collect-pi.mjs`（010） | 组装 `pi-dist` + ustar tar.gz + 写哈希（并在组装时收 `config/` 模板） | ✅ 已存在（287 行；`join(ROOT,'config',name)` 见 `collect-pi.mjs:218`） |
| `forge.config.ts` | `extraResource: ['pi-dist.tar.gz', …]` | ✅ 已存在（73 行） |

## 9. 与规格交叉引用

| 规格需求 | 实现落点 |
|---|---|
| FR-009-001…004（定位 / 期望哈希 / 缺失可见 / 开发出口） | `resolveArchivePath` / `readExpectedHash` / `resolveEnvPiDist`（✅ `artifact.ts:29,36,58`） |
| FR-009-005…009（目标目录 / 流式 / 类型支持 / 逃逸拒绝 / ustar） | §3.4 状态机 + §7（⬜ 逃逸校验待补） |
| FR-009-010…014（marker 语义与三种分支） | §4.2 决策树 + `ensureArtifact`（✅） |
| FR-009-015…019（完整性断言与 `nextEntry`） | `assertPayloadComplete` + `payloadEntryCandidates`（✅ `artifact.ts:78,87`） |
| FR-009-020…024（日志四要素 / 诊断槽 / 可重入 / 进度 / 固定内存） | §6.2、§6.4 + `logger.ts` + 007 `failVisible()` |
| FR-009-025…027（只写 userData / 不执行内容 / 只清理 pi-dist） | §4.3 校验规则 + §6.3 |
| §5 验收场景 S1–S8 | §7 测试考量（S1/S2/S3/S4/S7 由 P0-4 探针；S5/S6/S8 由负向与单元覆盖） |
