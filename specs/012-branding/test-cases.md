# 012 — 品牌化（branding）测试用例

> **Module:** 012-branding  ｜ **对应规格:** [`./spec.md`](./spec.md) ｜ **对应方案:** [`./plan.md`](./plan.md)
> **取证目录:** `logs/20261013-0/`（未入库） ｜ **轮次:** 见 `docs/构建验证记录.md`

| 编号 | 对应 FR/AC | 用例 | 步骤 | 期望（可判） | 自动化 |
|---|---|---|---|---|---|
| TC-01 | FR-012-005 | 物料齐备时构建 | `node scripts/brand-assets.mjs` | exit 0；打印 6 项物料属性（尺寸/alpha/魔数/SVG 校验） | 脚本 |
| TC-02 | FR-012-005 / AC-05 | **负向**：物料缺失 | 造一个缺 `logo.svg` 的目录，`node scripts/brand-assets.mjs --assets <dir>` | exit≠0；错误信息含 `logo.svg` 与「缺失」 | 脚本 |
| TC-03 | FR-012-005 | **负向**：母版带透明 | 用带 alpha 的 PNG 冒充 1024 母版 | exit≠0；提示 `minAlpha` | 脚本 |
| TC-04 | FR-012-006 | 应用图标固化 | 打包后比对 `resources/{icon.png,icon.ico,icon.icns,tray.png,trayTemplate.png}` 与物料 | sha256 逐项相等（`icon.png`=1024 母版、`tray*.png`=200² 物料） | 脚本 + `sha256sum` |
| TC-05 | FR-012-007 | web 位图图标 | 检查 `pi-dist/public/icons/{icon-192,icon-512,apple-touch-icon}.png` 与 `.next/server/app/favicon.ico.body` | 尺寸 192/512/180/192 且为 PNG；512 为 `colorType=2`（不透明），其余含 alpha | 脚本 |
| TC-06 | FR-012-001/002/004 | 文案替换与断言 | `node scripts/collect-pi.mjs` | `Pi Web` 1055 处 → 0 处；技术标识符计数 750 → 750；`index.html`/`login.html` 有 `Pi Desktop` 无 `Pi Web`；终检 0 处 | 脚本 |
| TC-07 | FR-012-003 | 页面 Logo 路径替换 | 同上，统计 logo 路径替换数 | `src:"…"`/`src="…"`/`as="image" href=…` 共 6 处改写为 `/icons/logo.svg`；`rel="apple-touch-icon"` 元数据与 `public/sw.js` 未变 | 脚本 |
| TC-08 | FR-012-003 | Logo 与物料一致 | `sha256sum pi-dist/public/icons/logo.svg ../assets/logo.svg` | 相等 | shell |
| TC-09 | — | 幂等 | 连跑两次 `collect-pi`（或 `brand-assets`） | 第二次「改写 0 处」但断言仍通过，exit 0 | 脚本 |
| TC-10 | FR-012-010/011 | 版本检测关闭 + 版本显示 | 打包态：`GET /api/app-update`（带会话凭据） | `currentVersion="0.11.1"`、`updateAvailable=false`、`releaseUrl=""` | CDP |
| TC-11 | FR-012-001/003 / AC-01/03 | 打包态首屏品牌 | 打包态：取 `document.title`、DOM 文本、Logo 元素字节 | 标题含 `Pi Desktop`；`Pi Web` 计数 0；Logo 字节 = `assets/logo.svg` | CDP |
| TC-12 | FR-012-008 | 窗口图标 | 打包态：`BrowserWindow` 的 `icon` 来自 `resources/icon.png`（日志/`app` 断言） | 日志出现物料图标路径且文件存在 | 日志 |
| TC-13 | FR-012-013 | 打包态从 `<userData>/pi-dist` 就绪 | 打包态默认路径（含空格、反斜杠）启动 | 日志出现 `[ready] 第 N 次探测通过`；无 `ENOENT`/`就绪探测超时` | 日志 + CDP |
| TC-14 | FR-012-014 / AC-06 | 基本功能 | 打包态：设置 DeepSeek API Key → 创建工作区 → 发一轮对话 | 三项均成功，回复非空 | CDP + 截图 |
| TC-15 | AC-07 | 零上游改动 | `git -C ../pi status --short` 等三仓 | 全空；版本号与基线一致 | shell |
| TC-16 | — | 不回归 | `npm run typecheck`、`node scripts/smoke-desktop.mjs`、`npm run package` | 全绿（smoke 10 PASS / 0 FAIL） | shell |

---

## 执行结果（轮次：`docs/构建验证记录.md` §2「轮次 1」，2026-10-13）

| 编号 | 结果 | 实测（摘要） | 证据（`logs/` 未入库） |
|---|---|---|---|
| TC-01 | ✅ PASS | exit 0；打印 6 项物料属性（透明标记 200² minAlpha=0 / 不透明母版 1024² minAlpha=255 / 托盘底 200² / `logo.ico` 6 图像 / `logo.icns` 84178 B / `logo.svg` viewBox 已校验） | `20261013-0/evidence/13-tc01-brand-assets.txt` |
| TC-02 | ✅ PASS | exit 1；`[brand] ✖ 物料缺失（1 项）：logo.svg` | `evidence/13-tc02-missing-logo.txt` |
| TC-03 | ✅ PASS | exit 1；`[brand] ✖ 不透明母版含透明像素（minAlpha=0）` | `evidence/13-tc03-alpha-master.txt` |
| TC-04 | ✅ PASS | 仓库内 5 项与物料 sha256 逐项相等；**包内** `resources/{icon.png,tray.png,trayTemplate.png}` 同样相等（`e52c3a19de44…` / `d2a300fc4f55…` / `b57cd335229d…`）。`icon.ico/icns` 由 Forge 吃进 exe/应用包，不落 `resources/` | `evidence/13-packaged-resources.txt` |
| TC-05 | ✅ PASS | `icon-512.png` 512² colorType=2；`icon-192.png` 192²、`apple-touch-icon.png` 180²、`favicon.ico.body` 192² 均 colorType=6；全部 PNG 魔数（favicon 未落成 JPEG） | `evidence/13-web-icons-check.txt` |
| TC-06 | ✅ PASS | 扫描 666 个文本文件、改写 36 个：文案 **1035 处** + Logo 路径 6 处；技术标识符 **757 → 757**（逐项不变）；`index.html`/`login.html` 无 `Pi Web`、含 `Pi Desktop`；终检 0 处 | `20261013-0/06-package-fix.log`（`[brand]` 段） |
| TC-07 | ✅ PASS | `"/icons/logo.svg"` = 6 处；旧 Logo 路径 = 0 处；`rel="apple-touch-icon"` 与 `public/sw.js` 未改（打包态 DOM 仍见 `href=/icons/apple-touch-icon.png`） | 同上 + `14-tc-e2e.log`（TC-11d） |
| TC-08 | ✅ PASS | `pi-dist/public/icons/logo.svg` 与 `../assets/logo.svg` 逐字节一致（sha256 `7c98c891d69c…`） | `06-package-fix.log` |
| TC-09 | ✅ PASS | 第二次 `brand-assets`：扫描 666 文件、**改写 0 个（文案 0 处、Logo 0 处）**、断言仍通过、exit 0 | `evidence/13-tc09-idempotent-2nd.txt` |
| TC-10 | ✅ PASS | `{"currentVersion":"0.11.1","latestVersion":"0.11.1","updateAvailable":false,"releaseUrl":""}`；DOM 内 `releases/tag` 链接 0 条 | `14-tc-e2e.log`（TC-10a/10b） |
| TC-11 | ✅ PASS | 标题 `e2e-workspace - Pi Desktop`；DOM（含内联负载）`Pi Web`=0、`Pi Desktop`=11；`/icons/logo.svg` 取回 1288 B，sha256 = 物料 `7c98c891d69c…`；新会话页 `<img src="/icons/logo.svg">` 1 个；`GET /login` 被重定向回 `/` | `14-tc-e2e.log`（TC-11a–11e）+ `evidence/13-login-html-check.txt` |
| TC-12 | ✅ PASS | 日志 `窗口图标 = out\…\resources\icon.png`；该文件 sha256 `e52c3a19de44…` = 1024 母版 | `13-packaged-run.log` |
| TC-13 | ✅ PASS | 默认布局（cwd `D:\pi-workspace\pi-desktop`、产物 `C:\Users\…\Pi Desktop\pi-dist`）**第 1 次就绪探测即 200**；日志见「进程工作目录已切换到产物根」；**无 `ENOENT`、无「就绪探测超时」**。冷启动解压 51709 文件 / 143702 ms；二次启动 marker 一致跳过解压，20 s 到首屏 | `13-packaged-run.log`、`07-packaged-run.log`；机制对照探针 `evidence/TC13-probe-{A,B}-*.log` |
| TC-14 | ✅ PASS | Key 设置 `{"success":true}`；工作区会话创建 200；`prompt` 200；会话记录内 assistant 正文 = `PI_DESKTOP_E2E_OK`（DeepSeek `deepseek-v4-pro`，带 usage token 计数） | `14-tc-e2e.log`（TC-14a–14d）+ `evidence/tc14-screenshot.png` |
| TC-15 | ✅ PASS | `../pi`、`../pi-web`、`../harmonypc-electron` 的 **tracked 改动均为 0**；`pi-web` version = `0.11.1`（`pi` 的 `package.json` 为 `0.0.3`，基线口径按 tag `v1.1.0`）。⚠️ `harmonypc-electron/ohos_hap/{libadapter.so,libelectron.so}` 是**未跟踪的预编译产物**（mtime 2026-10-11 15:04，早于本工程动作） | `evidence/13-tc15-upstream-zero-diff.txt` |
| TC-16 | ✅ PASS | `npm run typecheck` 无错；`smoke-desktop` **10 PASS / 0 FAIL**（`marker=Pi Desktop`）；`npm run package` 成功，包内 `pi-dist.tar.gz` SHA-256 = `216c217d…` | `05-smoke-fix.log`、`06-package-fix.log` |

### 与用例原期望的两处「口径」更正（被测实现无缺陷，是用例口径不成立）

1. **TC-06 的绝对计数**：原写「`Pi Web` 1055 处 → 0 处；标识符 750 → 750」，这两个数是 `pi-desktop-hos` 同型产物的实测值。本工程本轮构建为 **1035 处 / 标识符 757**，且**绝对计数随上游 `next build` 变化**。机器判据应是「替换后全树 = 0」+「标识符逐项不变」+「`/icons/logo.svg` = 6 处」。
2. **TC-11 的 Logo 元素位置**：上游把该 Logo 只渲染在**登录页**（`app/login/page.tsx:52`）与**新会话页**（`components/ChatWindow.tsx:1437`）；打包态登录页会被重定向回 `/`（壳层注入会话 cookie 的既定行为）。首屏若停在会话列表，DOM 中本就没有这个 `<img>`。故断言改为「页面取回的 `/icons/logo.svg` 字节 = 物料字节」，登录页品牌化交由构建期 `login.html` 断言覆盖（详见 `spec.md` §5 的 AC-03 口径说明）。

### 本轮发现（**不属 012 品牌化范围，登记待办**）

- **终端 / PTY 在打包态不可用**：`POST /api/terminal` → 500 `Failed to load native module: conpty.node … Cannot find module './prebuilds/win32-x64/conpty.node'`。根因**不在本工程**：上游安装态 `../pi-web/node_modules/node-pty/prebuilds/win32-x64/` 只有一个**空的** `conpty/` 目录，**没有任何 `.node` 原生模块**（`build/Release/` 同样只有 `conpty/conpty.dll` + `OpenConsole.exe`）；带 `.node` 的只有 `win32-arm64`。`collect-pi` 的平台裁剪只删「非目标平台」目录（本机 x64 的保留项本来就是空的），**没有丢文件**（`pi-dist` 内 `.node` 共 7 个 = 上游 11 − 4 个非 Windows 平台项）。候选处置：重装/重建 `node-pty`（`npm rebuild node-pty` 或 `@electron/rebuild`）后重跑本用例；能力登记见 `docs/桌面能力清单.md` §A#1。证据：`13-probe-renderer.log`（R7）。

**处置（2026-10-13 轮次 2，已完成）**：**根因更正** —— 上游 npm 发布包 `node-pty-1.2.0-beta.15.tgz` **内含** `prebuilds/win32-x64/{conpty.node,conpty_console_list.node,conpty/*,*.pdb}`（6 条目，已逐项 sha256 核对），所以「上游缺件」的说法**不成立**；真因是本机 `node_modules` 安装不完整只剩空壳目录，而 node-pty 的 `scripts/prebuild.js` **只看目录是否存在** ⇒ 误判「已预构建」⇒ 跳过 `node-gyp`。已按发布物恢复预构建 → 打包态 R7 转 **PASS**（`logs/20261013-0/18-probe-renderer.log`、`25-probe-renderer-installed.log` 均 7 PASS / 0 FAIL）；并在流水线加**构建期硬失败**守卫 `verifyNativeDeps()`（`FR-010-027`，见 `docs/构建验证记录.md` 轮次 2）。
