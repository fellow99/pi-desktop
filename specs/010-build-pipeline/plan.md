# 010 — 构建流水线（build-pipeline）技术实现方案

> **Module:** 010-build-pipeline（构建流水线）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应规格:** [`./spec.md`](./spec.md)
> **架构基线:** `docs/工程规划.md` §8.1（四阶段 + 门禁）、§8.2、§8.3、§8.4、§8.5、附录 A/B、§11.1 R2/R11/R12

## 1. 技术上下文

### 1.1 运行环境

- **宿主侧（任意平台）**：Node **24.21.0**（与 Electron 43.7.9 内置版本一致 —— 这是门禁可信的前提）+ `npm`。
- **脚本形态**：Node ESM（`.mjs`），零第三方依赖，用 `node:child_process.spawnSync` 调外部命令（npm / next / tar / git）。
- **执行入口**（✅ `package.json` 已声明）：

| 脚本 | 命令 | 说明 |
|---|---|---|
| `npm run prepare:next` | `node scripts/prepare-next.mjs` | 阶段 ① |
| `npm run smoke` | `node scripts/smoke-desktop.mjs` | 阶段 ②（门禁） |
| `npm run collect:pi` | `node scripts/collect-pi.mjs` | 阶段 ③ |
| `npm run pin:upstream` | `node scripts/pin-upstream.mjs` | 记录 SHA |
| `npm run prepackage` | `prepare-next && collect-pi` | 打包前自动串联（✅） |
| `npm run premake` | `prepare-next && collect-pi` | 出安装包前自动串联（✅） |
| `npm run typecheck` | `tsc --noEmit` | 质量门（✅） |

### 1.2 依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| 上游 `../pi-web` | submodule（Branch_v0.11.1） | `npm ci`、`next build`、`bin/rotate-preview-secrets.js` |
| 上游 `../pi` | submodule（Branch_v1.1.0） | `npm install`（产出 `@earendil-works/*` 依赖树） |
| `node:child_process` / `node:fs` / `node:path` / `node:crypto` | 内置 | 子进程、文件、路径、SHA-256 |
| Electron Forge 7.11.x 全家桶 | devDependencies（✅ `package.json`） | `make` / `package` / vite 插件 / fuses 插件 / makers |
| 平台工具 | 系统 | `tar`（ustar）、`git`、Linux 侧 `fakeroot`/`rpm` |
| `src/main/constants.ts` | 本项目（✅） | 归档名/版本文件名/marker 名（与 009 共享语义） |

> ⚠️ 注意：本模块的「产物名」必须与 009 的常量一致（`pi-dist.tar.gz`、`pi-dist.version`、`pi-dist.sha256`）；不一致会导致运行时断言失败。

## 2. 宪法合规检查

| 原则（`docs/工程规划.md` §3 / §7 / §8） | 状态 | 说明 |
|---|---|---|
| 零上游改动（§3 原则 1、§7） | ✅ | 不在 `../pi` / `../pi-web` 上写文件；裁剪只在副本（FR-010-002） |
| 只写装配代码（§3 原则 3） | ✅ | 脚本只做「构建 + 拷贝 + 打包 + 断言」 |
| 失败可见（§3 原则 5） | ✅ | 门禁阻断 + 阶段化日志 + 非零退出（FR-010-005、FR-010-024） |
| 安全 S1/S4（生产无 --inspect） | ✅ | 构建脚本不注入调试参数；产物由 Fuses 收紧（FR-010-016） |
| 安全 S5（Fuses 六项） | ✅ | `forge.config.ts` 已配置六项（✅ 已存在） |
| 可复现（§6.1、附录 B） | ✅ | `upstream.lock.json` 记录 SHA（FR-010-019/020） |
| 平台差异显式化（§8.2、§8.5） | ✅ | 平台裁剪矩阵 + 不交叉打包（FR-010-011、FR-010-018） |
| 质量门（§8.4） | ✅ | `typecheck` + `smoke` 双门禁（FR-010-021） |
| 代码质量：strict TS、无 `as any`、严禁空 catch | ⬜ | 脚本为 `.mjs`（不参与 TS 检查）；⬜ 需人工评审错误处理完整性 |

> 合规结论：构建纪律相关项 ✅；⬜ 项为脚本侧错误处理与 `node-pty` 结论（见 §3.3）。

## 3. 研究结论

### 3.1 关键决策与理由

| 决策 | 理由 | 对应 FR |
|---|---|---|
| 四阶段 + 门禁（①准备 ②冒烟 ③组装 ④打包） | 与规划一致；把昂贵的打包放在便宜的门禁之后（✅ §8.1） | FR-010-001…018 |
| 裁剪在副本上做 | 直接改 `../pi-web` 会污染 sibling 工作区并破坏后续构建（🔶 HOS v1.1 修正结论） | FR-010-002 |
| 门禁用**与 Electron 同版**的 Node 24.21.0 | 门禁结论要对运行时成立；Node 版本差异会掩盖 `node:sqlite`/API 差异（✅ §8.1 阶段 ②） | FR-010-004 |
| 门禁断言四项（SPA / API / SSE / SDK） | 覆盖运行时全部关键路径：页面、上行、下行、agent 本体 | FR-010-004 |
| ustar + SHA-256（而非「存在即跳过」） | 与 009 的 marker 语义闭环 | FR-010-009、FR-010-010 |
| 临时文件 + 原子重命名 | 避免半成品 tar 被 009 判为完整 | FR-010-012 |
| `executableName: 'pi-desktop'` | Linux maker 用 `package.json.name`，productName 带空格会导致可执行名不匹配（✅ §8.5 注意事项 5） | FR-010-013 |
| 不交叉打包 | 原生件必须与目标平台一致；Linux rpm strip 会误伤其它架构 | FR-010-018（§8.5 注意事项 3/8） |
| 零依赖 `.mjs` 脚本 | CI 与本地行为一致；无需为一组线性命令引入构建框架 | FR-010-022 |

### 3.2 上游/实现核实（✅ / 🔶 / ⬜ / ⚠️）

| # | 事实 | 依据 |
|---|---|---|
| U1 | `pi-web` 无 `output: 'standalone'`，不可静态导出；生产**必须以包目录为 `cwd` 基准**（⚠️ 2026-10-13 更正：原写「`.next` 固定解析为 `path.join(__dirname,'..','.next')`」不成立 —— 实际是 Next 用 `join(process.cwd(), path.relative(process.cwd(), dir))` 还原项目根；跨盘符时该式必拼坏，故 `host.ts` 起服务前 `process.chdir(<产物根>)`，见 `specs/012-branding/plan.md` §3.5 与轮次 1） | ✅ `next/dist/server/route-modules/route-module.js`、`next/dist/server/load-manifest.external.js` |
| U2 | `pi-web` 的原生依赖**只有** `node-pty` 1.2.0-beta.15（在 `serverExternalPackages` 中，`prebuilds/` 内含多平台目录）；**无** `better-sqlite3`（会话是 JSONL） | ✅ §2.2、§8.2 |
| U3 | 平台有原生 SWC（`@next/swc-<platform>-<arch>`），**不需要** HOS 的 WASM 兜底；但必须每个 runner 各自构建 | ✅ §8.2（🔶 与 HOS 的差异点） |
| U4 | `forge.config.ts` 已存在且包含 `extraResource: ['pi-dist.tar.gz', 'resources/icon.png', 'resources/tray.png', 'resources/trayTemplate.png']`、makers（Squirrel/ZIP/DMG/RPM/DEB）、Fuses 六项、`ignore` 清单 | ✅ `forge.config.ts:18-71` |
| U5 | `package.json` 已声明 `prepackage`/`premake` 钩子（`prepare-next && collect-pi`）与四个脚本名 | ✅ `package.json:12-24` |
| U6 | `resources/`、`scripts/*.mjs`、`config/{settings.json,mcp.json}`、`.github/workflows/{ci,release}.yml` 均**已存在**（2026-10-12 复核）；`config/trust.json`、`upstream.lock.json` 尚未见 | ✅ 目录与脚本已落地；本模块的职责转为「核对与门禁执行」 |
| U7 | `node-pty` 是否 N-API（能否在 ABI 148 下直接加载） | ⬜ **P0-3 探针**；不可用则 `@electron/rebuild` 或裁剪 + 终端降级（⚠️ R2） |
| U8 | ⬜ 门禁所需的「一条带凭据的 `/api/*`」端点选择 | ⬜ 实现时从 `pi-web/app/api/**` 选定只读端点（spec §7） |

### 3.3 平台裁剪矩阵（构建期）

| 目标 | 保留 | 剔除 | 依据 |
|---|---|---|---|
| Windows x64 | `node-pty/prebuilds/win32-x64`、`@next/swc-win32-x64-msvc`（或等价的 next 平台包） | 其它平台 prebuilds、`.next/cache`、devDependencies 痕迹 | §8.2、§8.5 |
| macOS arm64/x64 | `node-pty/prebuilds/darwin-<arch>`、`@next/swc-darwin-<arch>` | 同上 | §8.2 |
| Linux x64 | `node-pty/prebuilds/linux-x64`、`@next/swc-linux-x64-gnu` | 同上 | §8.5（rpm strip 风险） |

实现要点：

- 裁剪作用对象是**副本**（`pi-dist` 工作目录），源目录只读（FR-010-002）。
- 剔除清单以「按目标平台保留白名单」实现，而不是「黑名单删已知平台」—— 前者对未来新增平台安全。
- `pi-tui` 的自带 N-API prebuilds（✅ darwin/linux/win32 × x64/arm64）**保留**：加载失败在上游即优雅降级（§8.2）。
- `undici` / `web-push` / `@earendil-works/*` 为纯 JS（含 wasm：codemode 的 QuickJS），保留（§8.2）。

### 3.4 门禁（`smoke-desktop.mjs`）的运行方式

```
1) 解析 pi-dist 与 Electron 同版 Node（✅ 断言 process.version 前缀为 v24.21 或显式校验 engines）
2) 起服务器：直接 require(<pi-dist>/node_modules/next/dist/server/lib/start-server.js) 的 startServer
   （或退化为 `next start -H 127.0.0.1 -p <free>` 子进程 —— 门禁允许子进程，运行时不允）
3) 断言 1：GET / → 200 且 body 含 Pi Web UI 标记
4) 断言 2：GET /api/web-auth → 200；GET <选定只读端点>（带 Basic pi:<随机密码>）→ 200
5) 断言 3：GET /api/agent/<新建或占位 id>/events → Content-Type: text/event-stream（不要求数据帧）
6) 断言 4：require(<pi-dist>/node_modules/@earendil-works/pi-coding-agent) → createAgentSession(...)（不调用模型）
7) 关闭服务器并退出（0=通过；非 0=阻断）
```

注意：

- 门禁**必须设置** `PI_WEB_PASSWORD`（否则断言 2 会因「完全无认证」而失去意义）。
- 断言 3 需要一条真实存在的会话 id 或上游允许的占位形态；⬜ 实现时确认 SSE 路由对未知 id 的响应（若返回 404，则先创建会话再订阅）。
- 断言 4 只验证 SDK 可加载 + 会话对象可创建，**不联网、不调模型**（避免把门禁变成计费/网络依赖）。

## 4. 数据模型

### 4.1 实体

| 实体 | 字段 | 说明 |
|---|---|---|
| 阶段结果 | `{ stage, ok, exitCode, ms, tail }` | 每个阶段的结论（供日志与 CI 输出） |
| 门禁断言 | `{ name, ok, detail }` × 4 | SPA / API / SSE / SDK |
| 上游锁 | `{ pi: { commit, ref }, piWeb: { commit, ref }, pinnedAt }` | `upstream.lock.json` |
| 产物清单 | `pi-dist` 白名单 | 见 spec §4 |
| 目标平台 | `{ platform: 'win32' \| 'darwin' \| 'linux', arch }` | 裁剪输入 |

### 4.2 状态机

```
clean
  → prepared   （../pi-web 构建产物就绪；副本已裁剪；预览密钥已轮换）
  → smoked     （四项断言全绿；否则 → blocked，不进入下一阶段）
  → collected  （pi-dist.tar.gz + 哈希文件原子落盘）
  → packaged   （out/make/** 产物就绪）
失败边：任一阶段 → failed(stage)（非零退出；不产出后续产物）
```

### 4.3 校验规则

- 阶段前置检查：`../pi` 与 `../pi-web` 存在且 `package.json` 的 version 与预期基线一致（1.1.0 / 0.11.1）；不在预期版本时 WARN（不阻断，但写入日志）。
- 门禁：四项断言全 true 才允许返回 0；任何异常（网络、进程、解析）都算失败。
- 产物：`pi-dist.tar.gz` 的 SHA-256 必须写入 `pi-dist.version`（内容为 64 位十六进制 + 换行）。
- 打包前置：`extraResource` 中声明的每个路径必须存在，否则**提前失败**（避免 maker 生成缺资源的安装包）。

## 5. 接口契约

### 5.1 提供接口（脚本与命令）

| 接口 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `node scripts/prepare-next.mjs` | 环境（目标平台由运行平台推断，可用 `--platform` 覆盖） | 已裁剪的 `pi-dist` 工作目录 + 已轮换的 `.next` | 阶段 ① |
| `node scripts/smoke-desktop.mjs` | `pi-dist` 工作目录 | 退出码 0/非 0 + 四行断言结果 | 阶段 ②（门禁） |
| `node scripts/collect-pi.mjs` | `pi-dist` 工作目录 | `pi-dist.tar.gz` + `pi-dist.version` | 阶段 ③ |
| `node scripts/pin-upstream.mjs` | `../pi`、`../pi-web` | `upstream.lock.json` | 版本钉住 |
| `npm run make` | 上述全部（经 `premake` 钩子） | `out/make/**` | 阶段 ④ |

### 5.2 消费接口（外部命令）

| 来源 | 用途 |
|---|---|
| `npm ci`（在 `../pi-web`） | 安装 pi-web 依赖（含 `.bin/next`） |
| `npx next build` / `node_modules/.bin/next build` | 生产构建 |
| `npm install`（在 `../pi`） | 产出 `@earendil-works/*` 依赖树 |
| `tar --format=ustar -czf` | 归档（Windows 用 `tar.exe`（bsdtar）或 Node 内置等价实现兜底） |
| `git -C ../pi rev-parse HEAD` / `git -C ../pi-web rev-parse HEAD` | 上游 SHA |
| `electron-forge make` | 打包（经 `premake`） |

### 5.3 事件协议

- **无 IPC**；脚本之间只通过文件系统与退出码协作。
- 日志统一前缀（`[pi-desktop]`）；CI 通过退出码与 stdout 判定。

## 6. 实现策略

### 6.1 架构模式

四个脚本各管一段，共享一个薄的 `scripts/lib`（⬜ 若需要；当前规划未列该目录，若引入需同步更新 §6.2 结构文档）：路径解析、`spawnSync` 包装（带日志与退出码检查）、目标平台推断。**不引入任务运行器**（gulp/nx 等）—— 命令链是线性的，`package.json` 钩子已经足够。

### 6.2 关键算法

- **跨平台 tar**：优先使用系统 `tar`（Windows 10+ 自带 bsdtar，支持 `--format=ustar`）；不可用时用 Node 侧 ustar 写出实现（⚠️ 与 009 的解压器对称，需保证 512 对齐与结束块）。⬜ 实现时二者择一并在 README 记录。
- **原子落盘**：写 `pi-dist.tar.gz.tmp` → `fs.renameSync` 覆盖目标；哈希文件同理（先写 `.tmp`，再 rename）。
- **裁剪**：遍历 `node_modules/**/prebuilds/*` 与 next 平台包目录；按白名单保留，删除其它（用 `fs.rmSync(..., {recursive:true, force:true})`）。
- **预览密钥轮换**：`require(<pi-dist>/bin/rotate-preview-secrets.js)` 或按其 CLI 调用（⬜ 确认是导出函数还是 CLI；HOS 侧是 `require` 后调用）。
- **同版 Node 断言**：读取 `process.version` 与 `package.json` 的 Electron 版本映射（硬编码 `24.21.0` 与 `43.7.9` 的对应关系，并在注释登记来源），不匹配时失败（避免用错 Node 跑门禁）。

### 6.3 错误处理

- `spawnSync` 结果统一检查：`status !== 0` → 打印命令、退出码与 stderr 尾部 → 以同一退出码结束。
- 网络类失败（`npm ci`）→ 提示镜像方案（`ELECTRON_MIRROR`、npm registry）后失败。
- 清理：失败时**保留**工作目录供排查，但**删除**未完成的 `.tmp` 产物（避免被误认为成品）。
- **严禁空 catch**：脚本内 catch 必须打印并退出（不得吞掉）。

### 6.4 性能

- 阶段 ①（`npm ci` + `next build`）是主要耗时项（⬜ 实测；CI 中可缓存 npm 缓存目录）。
- 阶段 ③ 的 gzip 压缩 682 MB → ≈116 MB 也是分钟级（⬜ 实测）。
- 阶段 ② 门禁应在秒级到十几秒（起服务 + 四条断言），因此放在昂贵的 ③④ 之前。

## 7. 测试考量

| 层次 | 方式 | 覆盖需求 |
|---|---|---|
| 门禁（本模块的核心测试） | `node scripts/smoke-desktop.mjs`：四项断言（SPA/API/SSE/SDK） | FR-010-004、FR-010-007 |
| 集成 | `npm run make` 端到端：产物出现在 `out/make/**`；`pi-dist.tar.gz` 可被 009 解压并通过断言 | FR-010-008…018 |
| 静态 | `npm run typecheck` | FR-010-021 |
| 负向 | ① 破坏 `pi-dist` 的 Next 入口 → 门禁必须失败且非零退出；② 门禁失败时断言未产出 tar；③ 缺 `resources/icon.png` → 打包提前失败 | FR-010-005、FR-010-012、§4.3 |
| 洁净度 | 流水线后 `git -C ../pi-web status --porcelain` 必须为空 | FR-010-002 |
| 复现性 | 连续两次 `collect-pi` 对同一 `pi-dist` 产出**相同哈希**（确定性 tar：固定顺序与 mtime 归一化；⬜ 若不满足则记录差异原因） | FR-010-019 |
| 体积/时长 | 记录 `pi-dist.tar.gz` 大小、`out/make/**` 大小、各阶段耗时 | §6 非功能（⬜ 实测基线） |

## 8. 文件清单

| 文件 | 用途 | 状态（2026-10-12 复核） |
|---|---|---|
| `scripts/prepare-next.mjs` | 阶段 ①：`npm ci` + `next build` + 平台裁剪（副本）+ 预览密钥轮换 | ✅ 已存在（150 行） |
| `scripts/smoke-desktop.mjs` | 阶段 ②：同版 Node 起服务 + 四项断言（门禁） | ✅ 已存在（287 行） |
| `scripts/collect-pi.mjs` | 阶段 ③：组装 `pi-dist` + ustar tar.gz + SHA-256 | ✅ 已存在（287 行） |
| `scripts/pin-upstream.mjs` | 记录 `../pi` 与 `../pi-web` 的 commit SHA | ✅ 已存在（117 行） |
| `forge.config.ts` | 打包配置（asar/extraResource/executableName/makers/Fuses） | ✅ 已存在（73 行） |
| `package.json` | 脚本入口与 `prepackage`/`premake` 钩子、Electron 43.7.9 精确钉版 | ✅ 已存在（43 行） |
| `vite.{main,preload,renderer}.config.ts` | 三目标构建配置 | ✅ 已存在 |
| `upstream.lock.json` | 上游 SHA 钉住（产物，进版本控制） | ⬜ 由脚本产出 |
| `resources/icon.ico` / `icon.icns` / `icon.png` / `tray.png` / `trayTemplate.png` | 打包与托盘图标（`extraResource` 已声明） | ✅ 已存在 |
| `config/{settings.json,mcp.json,trust.json}` | 预置模板（组装时收进 `pi-dist`） | ✅ `settings.json` / `mcp.json` 已存在；`trust.json` 未见 |
| `.gitignore` | 排除 `pi-dist/`、`pi-dist.tar.gz`、`pi-dist.version`、`out/` | ✅ 已存在（⬜ 需核对条目） |

## 9. 与规格交叉引用

| 规格需求 | 实现落点 |
|---|---|
| FR-010-001…003（阶段 ①、副本裁剪、node-pty 处置） | §1.1 命令表 + §3.3 裁剪矩阵 + §6.2 |
| FR-010-004…007（门禁四项 / 阻断 / 前置 / 可读结论） | §3.4 门禁流程 + §7「门禁」 |
| FR-010-008…012（组装 / ustar / 哈希 / 排除项 / 原子落盘） | §6.2「原子落盘」+ §4.3 |
| FR-010-013…018（Forge 配置 / extraResource / makers / Fuses / 钩子 / 不交叉打包） | `forge.config.ts`（✅）+ `package.json` 钩子（✅）+ §3.1 决策表 |
| FR-010-019…020（上游钉住） | §5.1 `pin-upstream.mjs` + §4.1 上游锁实体 |
| FR-010-021…024（双门禁 / 零依赖脚本 / 镜像 / 日志） | §1.1 命令表 + §6.1、§6.3 |
| FR-010-025…026（目录结构 / 不依赖 HOS 构建） | §8 文件清单（对照 §6.2 结构） |
| §5 验收场景 S1–S8 | §7 测试考量（S1/S3/S4 集成与洁净度；S2/S5/S6/S7 负向与门禁；S8 镜像） |
