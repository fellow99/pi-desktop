# 012 — 品牌化（branding）技术实现方案

> **Module:** 012-branding（品牌化）  **Status:** Implemented  **Last Updated:** 2026-10-13  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应规格:** [`./spec.md`](./spec.md) ｜ **测试用例:** [`./test-cases.md`](./test-cases.md)
> **架构基线:** `docs/工程规划.md` §7（零上游改动）、§8.1（流水线）、§9.3（平台差异）、§11.1（风险）

## 1. 技术上下文

- **运行环境**：Electron 43.7.9（Node 24.21.0）主进程内起 `pi-web` 的 Next 16.3.8 服务器；`PI_WEB_*` 环境变量在 `assembleEnv()` 里注入，**早于任何 pi 代码被加载**（`src/main/host.ts:69-96`）。
- **构建期**：`prepare-next`（`npm ci` + `next build` 于 `../pi-web`）→ `collect-pi`（组装 `pi-dist/` → 预置资源 → tar.gz + SHA-256）→ Forge 打包。品牌化插在 `collect-pi` 的**组装之后、tar 之前**。
- **既有常量**：`PRODUCT_NAME='Pi Desktop'`、`UI_HTML_MARKERS`（`src/main/constants.ts:11,27`）；`PI_WEB_SKIP_VERSION_CHECK`（`src/main/host.ts:77`）。
- **上游契约（✅ 读源码）**：
  - `pi-web/app/api/app-update/route.ts:11,69-77`：`PI_WEB_SKIP_VERSION_CHECK==='1'` ⇒ `{currentVersion, latestVersion:currentVersion, updateAvailable:false, releaseUrl:''}`。
  - `pi-web/app/manifest.ts:6`：`PI_WEB_APP_NAME?.trim() || 'Pi Web'`（**仅** PWA 显示名）。
  - `pi-web/next.config.ts:30`：`images: { unoptimized: true }` ⇒ `next/image` 直接用 `<img>` 输出 `src`，**不会**走 `/_next/image` 优化器（因此 SVG Logo 可直出，无需 `dangerouslyAllowSVG`）。
  - 渲染点：`components/ChatWindow.tsx:1437`（`width=40`）、`app/login/page.tsx:52`（`width=52`）；文案点：`components/PiWebTitle.tsx:14`、`ChatWindow.tsx:1439`、`AppShell.tsx:1377`、`app/layout.tsx`、`app/login/page.tsx:54`。

## 2. 宪法合规检查

| 原则 | 状态 | 说明 |
|---|---|---|
| 零上游改动（§7） | ✅ | 只改 `pi-dist` 副本与 `resources/`；不碰 `../pi`、`../pi-web`、`../harmonypc-electron` |
| 失败可见（§3 原则 5） | ✅ | 物料缺失/尺寸不符/断言失败 ⇒ 构建失败（FR-012-004/005） |
| 可复现（§6.1） | ✅ | ffmpeg 参数固定；替换幂等；`resources/`、`resources/brand/` 入库 |
| 平台差异显式化（§9.3） | ✅ | `.ico`(Windows)/`.icns`(macOS)/`.png`(Linux) 三个位；`tray.png` vs `trayTemplate.png` 分平台 |
| 安全 S2 | ✅ | 不接触凭据；日志不打印密码 |
| 代码质量：strict TS、无 `as any`、严禁空 catch | ✅ | 脚本为 ESM `.mjs`（不经 tsc）；TS 改动保持 strict |

## 3. 研究结论（源码级核实，2026-10-13）

1. **上游文案规模（本工程实测；计数随上游构建变化）**：组装后的 `pi-dist`（排除 `node_modules`）内 `Pi Web` = **1035 处 / 36 个文件**（2026-10-13 的 `prepare-next` 构建；同一脚本在 `pi-desktop-hos` 的同型产物上是 1055 处 / 40 文件）。**机器判据不是绝对计数**，而是「替换后全树 = 0 处」+「技术标识符计数逐项不变（本轮 757 → 757）」+「`/icons/logo.svg` = 6 处」。
2. **页面 Logo 的三种编译形态**：JS chunk 用 `src:"/icons/apple-touch-icon.png"`（4 处：`server/app/login/page.js`、`static/chunks/app/login/page-*.js`、`server/app/page.js`、`static/chunks/app/page-*.js`）；预渲染 HTML 用 `src="/icons/apple-touch-icon.png"`（`server/app/login.html`）；Next 另插 `as="image" href="/icons/apple-touch-icon.png"`（preload，1 处）。
3. **必须保留的引用**：`rel="apple-touch-icon" href=...` 元数据（多处）与 `public/sw.js` 预缓存列表 → 只替换**渲染点**，元数据与 SW 不动（PNG 本身已由物料重建）。
4. **`favicon.ico.body`** 存在（`.next/server/app/`），内容是 PNG 字节；与 `public/icons/icon-512.png` 同尺寸来源，需一并重建，否则 favicon 仍是上游图标。
5. **打包态就绪缺陷（P0，已修；根因已更正）**：上一轮 `logs/20261012-0/runA-stdout.log` 与本轮 `logs/20261013-0/04-packaged-run.log` 都在**默认布局**（cwd 在应用所在盘 `D:`、产物在 `<userData>` `C:`）下失败：`ENOENT … '<cwd>\C:\…\pi-dist\C:\…\pi-dist\.next\routes-manifest.json'` → 每个请求 500 → `就绪探测超时`。当时把原因归给「反斜杠绝对路径」，并用换正斜杠的同盘符探针（`exp-t1/t2c/t3b.out`）验证“通过”——**该归因是混淆的**：那三个探针的 `dir` 与 cwd 同盘符，`path.relative()` 本来就能表达相对关系，与斜杠无关。真正的根因是**跨盘符**：Next 用 `join(process.cwd(), path.relative(process.cwd(), dir))` 还原项目根（`next/dist/server/route-modules/route-module.js` → `next/dist/server/load-manifest.external.js` 的 `loadManifestFromRelativePath({projectDir, distDir, manifest})`），而 Windows 的 `path.relative()` **跨盘符只能返回绝对路径**，`join()` 会把它当相对段再拼一次。本轮用同一份产物 + 同一 Node 做了对照探针（`logs/20261013-0/evidence/TC13-probe-A-crossdrive-no-chdir.log` 复现该 ENOENT；`TC13-probe-B-crossdrive-chdir.log` 在 chdir 后第 1 次探测即 200）。⇒ 处理：**把进程工作目录切到产物根**（与上游 `next start` 的约定一致）+ fail-visible 守卫（`src/main/host.ts`）；打包态回归见 FR-012-013、`logs/20261013-0/13-packaged-run.log`。

## 4. 数据模型

模块无持久化实体；唯一「数据」是**物料 → 目标位**映射（`spec.md` §4.1）与 `resources/brand/` 副本清单：

```
resources/brand/                     # 固化物料（入库；CI 无父工程时使用）
├── logo.png                         # 200²、含 alpha（= ../assets/logo.png）
├── logo-1024-with-bg.png            # 1024²、不透明
├── logo-200-with-bg.png             # 200²、不透明
├── logo.ico / logo.icns             # Windows / macOS 图标
└── logo.svg                         # 页面 Logo
```

## 5. 接口契约

`scripts/brand-assets.mjs`（新增，ESM，可 import 亦可 CLI）：

| 导出 | 签名 | 职责 |
|---|---|---|
| `loadMaterial(argv)` | `(string[]) => Material` | 解析物料目录（`--assets` > `$PI_ASSETS_DIR` > `../assets` > `resources/brand/`）、硬校验、必要时刷新 `resources/brand/` 副本 |
| `applyRepoBranding({material})` | `=> string[]` | 写 `resources/{icon.png,icon.ico,icon.icns,tray.png,trayTemplate.png}`（物料逐字节固化） |
| `applyWebBranding(piDistDir,{material})` | `=> {stats,favicon}` | 写 `pi-dist/public/icons/*` + favicon 路由体 + `logo.svg`；全树替换文案/Logo 路径；后置断言 |
| `assertNoBrandLeftovers(piDistDir)` | `=> {hits:0}` | 终检：`pi-dist`（排除 `node_modules`）内 `Pi Web` = 0 处 |

CLI：`node scripts/brand-assets.mjs [--assets <dir>]`（`resources/` 恒做；`pi-dist/` 存在时一并做 + 终检）。

`scripts/collect-pi.mjs`（改）调用顺序：组装 staging → `materializePresets` → **`applyWebBranding(staging)`** → **`assertNoBrandLeftovers(staging)`** → 生成 `pi-dist.tar.gz` + `pi-dist.version`。

## 6. 实现策略

1. **物料固化而非手工拷贝**：`resources/*` 全部由脚本从物料重新写出并逐字节比对（`icon.png`←1024 母版、`tray.png`←200² 带底、`trayTemplate.png`←200² 透明标记、`icon.ico/icns`←物料原件）。物料同时镜像到 `resources/brand/`（入库），父工程在场时**以父工程为准并刷新镜像**（FR-012-009）—— 解决「CI 拿不到父工程目录」与「镜像腐化」两个问题。
2. **替换范围 = 全树（排除 `node_modules`）**：`pi-dist` 只含 `.next` / `public` / `bin` / `next.config.ts` / `package.json` / `resources`，因此「全树」与参考工程的「`.next`+`public`+`bin`」等价，但能让终检断言（0 处）真正闭合。
3. **断言三层**：① 技术标识符计数不变（防误伤）；② `index.html`/`login.html` 无 `Pi Web`、有 `Pi Desktop`；③ 全树 `Pi Web` = 0。任一失败 ⇒ 非 0 退出（`collect-pi` 随之失败）。
4. **窗口图标**（FR-012-008）：`BrowserWindow` 显式 `icon`（打包态取 `process.resourcesPath/icon.png`，开发态取 `resources/icon.png`；缺失只告警不阻断启动）。
5. **打包态路径缺陷修复**（FR-012-013）：`host.ts` 在 `startServer` **之前** `process.chdir(<产物根>)`，让 Next 的 `join(cwd, path.relative(cwd, dir))` 退化为 `''`；并加守卫——若 `path.relative(cwd, dir)` 仍返回绝对路径（跨盘符）则**立即抛错**（fail-visible，不再表现为 30 s 就绪超时）。传给 Next 的 `dir` 保持正斜杠形式（与已实测通过的组合一致），原始路径只用于日志。
6. **版本**（FR-012-012）：`package.json` + `package-lock.json`（2 处根版本）+ README/`docs/发布与更新.md`/`specs/011-*` 的「当前版本」表述一并改为 `0.11.1`。

## 7. 测试考量

- **构建期（机器可判，脚本内断言）**：替换计数、技术标识符计数、HTML 断言、终检、物料 sha256 一致性、生成物 IHDR 回读。
- **负向用例**：`--assets` 指向缺 `logo.svg` 的目录 ⇒ 非 0 退出（AC-05）；重复运行幂等（第二次替换 0 处但断言仍通过）。
- **打包态（端到端，已执行）**：**不另开 `--user-data-dir`** —— 默认布局「cwd 在应用所在盘、产物在 `<userData>`」正是待测形态，另开目录会把它藏起来（单实例锁在本机无冲突，实测未串台）→ 打包 exe 加 `--remote-debugging-port=9333` 启动（宿主自身也占 CDP，端口必须错开）→ CDP 抓页面 → 断言标题/文案/Logo 字节/`/api/app-update`/窗口图标/`login` 重定向 → 设置 DeepSeek API Key → 创建工作区 → 真实对话一轮（**回复断言以会话记录里 `role=assistant` 的正文为准**，不信 SSE 事件流——本形态下该流只回 user 消息事件）。证据：`logs/20261013-0/{13-packaged-run,13-probe-renderer,14-tc-e2e}.log`、`logs/20261013-0/evidence/`。
- **不回归**：`npm run typecheck`、`node scripts/smoke-desktop.mjs`（10 项门禁）、`npm run package`。

## 8. 文件清单

| 文件 | 动作 |
|---|---|
| `scripts/brand-assets.mjs` | 新增（品牌化唯一实现） |
| `resources/brand/*`（6 个物料 + README） | 新增（固化物料，入库） |
| `resources/{icon.png,icon.ico,icon.icns,tray.png,trayTemplate.png}` | 由脚本重写（物料逐字节） |
| `scripts/collect-pi.mjs` | 改（接线品牌化 + 终检） |
| `package.json` / `package-lock.json` | 改（version 0.11.1；新增 `brand` 脚本） |
| `src/main/host.ts` | 改（`startServer` 的 `dir` 规范化） |
| `src/main/windows.ts` | 改（窗口图标用物料） |
| `specs/012-branding/{spec,plan,test-cases}.md` | 新增 |
| `specs/README.md` / `SPECS_CHECKLIST.md` | 改（登记 012） |
| `README.md` / `docs/*.md` | 改（版本、流水线、能力清单、验证台账） |

## 9. 与规格交叉引用

| FR | 落点 |
|---|---|
| FR-012-001 / 002 | `scripts/brand-assets.mjs` `replaceBrandInTree()` + 计数字段 |
| FR-012-003 | `LOGO_SRC_REPLACEMENTS`（5 条形态） |
| FR-012-004 | `applyWebBranding()` 后置断言 + `assertNoBrandLeftovers()` |
| FR-012-005 | `loadMaterial()` 硬校验（PNG 尺寸/alpha、ICO/ICNS 魔数、SVG 结构） |
| FR-012-006 | `applyRepoBranding()` |
| FR-012-007 | `scaleTo()`（`-c:v png -f image2` 显式 + IHDR 回读） |
| FR-012-008 | `src/main/windows.ts` |
| FR-012-009 | `loadMaterial()` 的镜像逻辑 |
| FR-012-010 / 011 | `src/main/host.ts:74,77`（已存在，本轮验证） |
| FR-012-012 | `package.json` / `package-lock.json` / 文档 |
| FR-012-013 | `src/main/host.ts` 的「chdir 到产物根 + 跨盘符 fail-visible 守卫」 |
| FR-012-014 | `logs/20261013-0/` 端到端测试证据 |
