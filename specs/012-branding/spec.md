# 012 — 品牌化（branding）功能规格

> **Module:** 012-branding（品牌化）  **Status:** Implemented  **Last Updated:** 2026-10-13  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应方案:** [`./plan.md`](./plan.md)
> **实现落点:** `scripts/brand-assets.mjs`（新增）、`scripts/collect-pi.mjs`、`resources/`、`resources/brand/`（新增）、`src/main/host.ts`、`src/main/windows.ts`、`package.json`
> **规划依据:** `docs/工程规划.md` §7（零上游改动）、§8.1（流水线）、§9.1（验收）、§9.3（平台差异）、§11.1（风险）
> **参考工程:** `pi-desktop-hos` 的 `specs/103-branding`（同型需求在鸿蒙版已交付并真机验证）

## 1. 模块概述

### 1.1 目的

把**别人的品牌**从交付物里清掉，换成 `Pi Desktop`：上游 `pi-web` 的 UI 文案与图标、以及壳层自己的图标位。
本工程是「装配」工程（§7 零上游改动），因此品牌化**只在本工程自己的产物副本上施加**：

1. `pi-dist/`（`collect-pi` 从 `../pi-web` 复制出来的运行产物）—— UI 文案、页面 Logo、web 位图图标、favicon；
2. 本工程自有的图标位（`resources/`）—— 应用图标、窗口图标、托盘图标、安装器图标。

同时**关掉上游的「新版本检测」**（应用自己有一套半自动更新引导，见 `011-release-update`），
但**保留当前版本显示**。

### 1.2 解决的问题

- **用户看到的是上游品牌**：主界面标题、登录页 `<h1>`、空会话 hero 品牌名都是 `Pi Web`，用户无法区分「Pi」与「Pi Desktop 这个壳」。
- **上游图标会被当成我们的图标**：favicon / PWA 图标 / 页面 Logo 都是 `pi-web` 自带图标，与父工程物料（`assets/`）不一致。
- **上游的版本检测与本工程的更新引导冲突**：`/api/app-update` 会去查 pi-web 的发布源，可能给用户「有新版本」的错误提示（他装的是 `pi-desktop`，不是 `pi-web`）。
- **品牌化不可复现**：靠手工拷贝图标 → 换物料不生效、丢物料不报错、不透明/透明用法漂移（参考工程 `pi-desktop-hos` 已踩过占位图与 alpha 的坑）。

### 1.3 范围

**包含**

- `pi-dist` 副本内的 `Pi Web` → `Pi Desktop` 文案替换（构建期，带后置断言）。
- 页面 Logo 改用父工程物料 `assets/logo.svg`（矢量，任意尺寸清晰）。
- web 位图图标（`icon-192.png` / `icon-512.png` / `apple-touch-icon.png` / favicon 路由体）由父工程物料生成。
- 应用级图标（`resources/icon.{png,ico,icns}`、`tray.png`、`trayTemplate.png`）由父工程物料生成/固化，并接进构建流水线（缺失 ⇒ 硬失败）。
- 运行时禁用上游版本检测（`PI_WEB_SKIP_VERSION_CHECK=1`）与显示名注入（`PI_WEB_APP_NAME=Pi Desktop`）。
- 本工程版本号与上游基线对齐：`0.1.0` → `0.11.1`。
- 打包态可用性：Windows 上「进程内 Next 服务器」必须能从 `<userData>/pi-dist`（含空格、反斜杠）正常就绪 —— 这是「打包后测基本功能」的前置。

**不包含**

- 改上游任何仓库的任何字节（§7）——包含「把 `pi-web` 的源码改成读环境变量」这类改动。
- 应用内更新引导本身（`011-release-update`，已实现）。
- 官网 / 发布说明的品牌物料（`pi-desktop-website` 属另一工程）。
- 代码签名、公证（§9.2）。
- 换掉壳层 loading 页的视觉设计（该页本来只有文字标题，无上游图标）。

## 2. 用户故事

- 作为用户，我进入应用后看到的名字是 **Pi Desktop**，不管在标题栏、登录页、还是空会话 hero 上。
- 作为用户，我希望应用不去检查「pi-web 有没有新版本」，但我要能看到**当前**版本号。
- 作为用户，我希望应用各处（任务栏、托盘、窗口、安装器、浏览器标签页）看到的是**同一个** Logo。
- 作为维护者，我希望换 Logo 只需要换父工程 `assets/` 里的物料，重跑一次流水线即可全链生效。
- 作为维护者，我希望「物料缺失/尺寸不符/不该透明的地方透明了」**在构建期就炸**，而不是打出一个无品牌的包。
- 作为维护者，我希望 CI（拿不到父工程目录）也能打出**同样的**品牌产物。

## 3. 功能需求

动作词：**MUST** 必须满足；**MUST NOT** 禁止；**SHOULD** 建议；**MAY** 可选。

### 3.1 UI 文案与页面 Logo

| 编号 | 需求 |
|---|---|
| **FR-012-001** | 构建期 **MUST** 在 `pi-dist` **副本**（不含 `node_modules`）内把带空格的字面量 `Pi Web` 替换为 `Pi Desktop`；上游三仓 **MUST NOT** 被改动。 |
| **FR-012-002** | 替换 **MUST NOT** 触及技术标识符：`pi-web`、`@agegr/pi-web`、`pi_web_session`、`PI_WEB_`、`PiWeb` —— 替换前后这些标识符的出现次数 **MUST** 逐项不变（机器断言）。 |
| **FR-012-003** | 页面 Logo（真正渲染的 `<img src>` / `next/image` 的 `src:`）**MUST** 指向物料矢量 `/icons/logo.svg`；`rel="apple-touch-icon"` 等**元数据声明**与 `public/sw.js` 预缓存列表 **MUST NOT** 被改动。 |
| **FR-012-004** | 构建期 **MUST** 断言：`.next/server/app/index.html` 与 `login.html` 内 `Pi Web` = 0 处、`Pi Desktop` > 0 处；`pi-dist` 全树（不含 `node_modules`）内 `Pi Web` **MUST** = 0 处。任一不满足 ⇒ **构建失败**。 |

### 3.2 图标物料

| 编号 | 需求 |
|---|---|
| **FR-012-005** | 物料唯一来源是**父工程** `../assets/`（`logo.svg`、`logo.png`、`logo-1024-with-bg.png`、`logo-200-with-bg.png`、`logo.ico`、`logo.icns`）；物料缺失、尺寸不符、透明度不符 ⇒ **构建失败**（MUST NOT 静默降级）。 |
| **FR-012-006** | 应用图标 **MUST** 由物料固化：`resources/icon.ico`←`logo.ico`、`resources/icon.icns`←`logo.icns`、`resources/icon.png`←`logo-1024-with-bg.png`（1024²、minAlpha=255）；托盘 `resources/tray.png`←`logo-200-with-bg.png`（200²、不透明）；macOS 模板 `resources/trayTemplate.png`←`logo.png`（200²、**必须真的含透明像素**）。 |
| **FR-012-007** | web 位图图标 **MUST** 由物料生成且**回读校验 IHDR**：`public/icons/icon-512.png`（512²、rgb24 不透明）、`public/icons/icon-192.png`（192²、rgba）、`public/icons/apple-touch-icon.png`（180²、rgba）、`.next/server/app/favicon.ico.body`（192²、rgba，PNG 字节；不得落成 JPEG）。 |
| **FR-012-008** | 窗口图标 **MUST** 显式使用物料（Windows/Linux 的 `BrowserWindow.icon`），不得只依赖可执行文件图标。 |
| **FR-012-009** | 物料 **MUST** 同时固化到本仓 `resources/brand/`（与父工程逐字节一致）：父工程存在时以其为准并**刷新**副本；父工程不存在（CI）时用副本并在日志里 WARN。 |

### 3.3 版本显示与检测

| 编号 | 需求 |
|---|---|
| **FR-012-010** | 运行时 **MUST** 置位 `PI_WEB_SKIP_VERSION_CHECK=1`：上游 `GET /api/app-update` 返回 `updateAvailable:false` 且 `releaseUrl` 为空；**MUST** 保留 `currentVersion`（版本仍显示）。 |
| **FR-012-011** | 运行时 **MUST** 注入 `PI_WEB_APP_NAME=Pi Desktop`（PWA/manifest 显示名）。 |
| **FR-012-012** | 本工程版本号 **MUST** 为 `0.11.1`（`package.json` / `package-lock.json` / README / 发布文档同步），与上游基线 `pi-web v0.11.1` 对齐；上游三仓版本号 **MUST NOT** 被改动。 |

### 3.4 打包态可用性

| 编号 | 需求 |
|---|---|
| **FR-012-013** | 打包态应用 **MUST** 能在 Windows 上从 `<userData>/pi-dist`（路径**含空格**、使用**反斜杠**的默认形态）启动进程内 Next 服务器并到达首屏；**MUST NOT** 依赖 `PI_DESKTOP_PI_DIST` 之类的调试开关。 |
| **FR-012-014** | 首屏到达后 **MUST** 能完成：设置 DeepSeek API Key、创建工作区、进行一次真实对话（见 §6 验收）。 |

## 4. 关键实体

### 4.1 物料 → 目标位映射

| 物料（`../assets/`） | 属性（硬校验） | 目标位 |
|---|---|---|
| `logo-1024-with-bg.png` | 1024²、minAlpha=255（真不透明） | `resources/icon.png`；`pi-dist/public/icons/icon-512.png`（512²、rgb24） |
| `logo.png` | 200²、**含真透明像素**（minAlpha<255） | `resources/trayTemplate.png`；`pi-dist/public/icons/icon-192.png`（192²）、`apple-touch-icon.png`（180²）、`favicon.ico.body`（192²） |
| `logo-200-with-bg.png` | 200²、minAlpha=255 | `resources/tray.png` |
| `logo.ico` | ICONDIR（`00 00 01 00`） | `resources/icon.ico`（Windows 应用/安装器图标） |
| `logo.icns` | `icns` 魔数 | `resources/icon.icns`（macOS 应用图标） |
| `logo.svg` | 含 `<svg` 与 `viewBox` | `pi-dist/public/icons/logo.svg`（页面 Logo，与物料逐字节一致） |

### 4.2 替换规则（FR-012-001 / FR-012-003）

| 形态 | 说明 |
|---|---|
| `Pi Web` → `Pi Desktop` | 带空格字面量；全树（不含 `node_modules`） |
| `src:"/icons/apple-touch-icon.png"` → `src:"/icons/logo.svg"` | 客户端/服务端 JS chunk 里的 `next/image` 渲染点 |
| `src="/icons/apple-touch-icon.png"` → `src="/icons/logo.svg"` | 预渲染 HTML 的 `<img src>` |
| `"src":"/icons/apple-touch-icon.png"` → `"src":"/icons/logo.svg"` | JSON/RSC 负载形态（上游若产出则一并覆盖） |
| `as="image" href="/icons/apple-touch-icon.png"` → `…/logo.svg` | Next 为 `priority` 图自动插入的 preload 链接 |
| ~~`rel="apple-touch-icon" href=…`~~ | **不改**（元数据仍声明 PNG；该 PNG 已由物料重新生成） |
| ~~`public/sw.js` 预缓存列表~~ | **不改**（列表里的 PNG 仍存在且已是物料） |

## 5. 验收场景

- **AC-01（文案）** Given 打包态应用已到首屏，When 取 `document.title` 与 DOM 文本，Then 标题为 `Pi Desktop`、DOM 内 `Pi Web` 计数 = 0、`Pi Desktop` > 0。
- **AC-02（版本仍显示、不检测）** Given 已注入会话凭据，When `GET /api/app-update`，Then `currentVersion="0.11.1"`、`updateAvailable=false`、`releaseUrl=""`；且 DOM 内无 `releases/tag` 更新链接。
- **AC-03（Logo）** Given 首屏与登录页，When 取页面 Logo 元素的实际字节，Then 与 `../assets/logo.svg` **逐字节一致**（sha256 相等），且元数据里 `rel="apple-touch-icon"` 仍指向 PNG。
- **AC-03 口径说明（2026-10-13 实测后追加，不修订原句）**：打包态注入了会话 cookie，`GET /login` 会被代理**重定向回 `/`**（用户永远看不到登录页，这是壳层的既定行为）；而该 Logo 在上游只渲染在**登录页**（`app/login/page.tsx:52`）与**新会话页**（`components/ChatWindow.tsx:1437`），首屏停在会话列表时 DOM 里可以没有这个 `<img>`。因此落地取证为三条并列证据：① 页面实际取回的 `/icons/logo.svg` 字节 = 物料字节（sha256 相等，`logs/20261013-0/14-tc-e2e.log`）；② 新会话页 DOM 内该 `<img src="/icons/logo.svg">` 存在且取回字节一致；③ 登录页产物 `.next/server/app/login.html` 构建期断言（`Pi Web`=0、`Pi Desktop`=9、`/icons/logo.svg`=2，证据 `logs/20261013-0/evidence/13-login-html-check.txt`）。
- **AC-04（图标）** Given 打包产物，When 解包比对 `resources/{icon.png,icon.ico,icon.icns,tray.png,trayTemplate.png}` 与物料，Then 逐字节一致；`pi-dist/public/icons/*` 与 favicon 路由体是物料生成物（尺寸/colorType 符合 §3.2）。
- **AC-05（物料硬失败）** Given 把 `--assets` 指向一个缺 `logo.svg` 的目录，When 跑 `node scripts/brand-assets.mjs`，Then **非 0 退出**并打印缺失项（负向用例）。
- **AC-06（打包与基本功能）** Given 干净构建，When `npm run package` 后启动打包态应用，Then 首屏可达；能设置 DeepSeek API Key、创建工作区、发出一轮对话并收到回复（FR-012-013/014）。
- **AC-07（零上游改动）** Given 品牌化前后，When `git -C ../pi status --short`、`git -C ../pi-web status --short`、`git -C ../harmonypc-electron status --short`，Then 三个仓**零改动**且版本号不变。

## 6. 非功能需求

- **可复现**：同一物料 ⇒ 同一产物字节（参数固定、无时间戳；替换幂等）。
- **失败可见**：物料缺失/不符、断言不通过 → 构建失败并给出可操作信息（哪个文件、期望什么、怎么修）。
- **零上游改动**：不修改 `../pi`、`../pi-web`、`../harmonypc-electron`。
- **安全**：品牌化不接触凭据；日志不得打印 `PI_WEB_PASSWORD` 明文。
- **体积**：品牌化不显著改变包体（`resources/brand/` ≈ 0.3 MB；web 图标为等尺寸替换）。

## 7. 假设与约束

- 物料目录 `../assets/` 存在（本机/流水线）；CI 场景靠 `resources/brand/` 副本（FR-012-009）。
- 生成 web 位图图标需要 `ffmpeg`（缩放与 `rgb24/rgba` 显式指定）；缺失 ⇒ 硬失败。
- 上游 `pi-web` 的构建产物结构（`.next/server/app/*.html`、`favicon.ico.body`、`public/icons/`）与 v0.11.1 一致；结构变化时断言会失败并提示更新脚本。
- Electron Forge 的 `packagerConfig.icon` 按平台取 `resources/icon.{ico,icns,png}`（✅ 读 `forge.config.ts:27,51`）。

## 8. 依赖

| 依赖 | 类型 | 说明 |
|---|---|---|
| `010-build-pipeline` | 本工程 | `collect-pi` 调用品牌化（顺序：组装 → 预置资源 → 品牌化 → 终检 → tar） |
| `009-artifact-bootstrap` | 本工程 | `pi-dist` 解压目标 `<userData>/pi-dist`（FR-012-013 的路径来源） |
| `007-app-entry` / `002-window` | 本工程 | 窗口图标（FR-012-008） |
| `011-release-update` | 本工程 | 壳层自带的「检查更新」是唯一更新引导（FR-012-010 的动机） |
| 父工程 `../assets/` | 外部 | 品牌物料唯一来源（FR-012-005） |
| `ffmpeg` | 外部 | web 位图图标生成 |
| `pi-desktop-hos` `103-branding` | 参考 | 同型需求的已交付实现（替换规则与断言口径沿用） |
