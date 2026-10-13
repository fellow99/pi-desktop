# 002 — 窗口管理（window）技术实现方案

> **Module:** 002-window（窗口管理）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应规格:** [`./spec.md`](./spec.md)
> **架构基线:** `docs/工程规划.md` §4.3、§4.5、§5.2、§5.5、§5.6、§9.3、§11.1 R4/R6、§11.4 S1/S4/S6

## 1. 技术上下文

### 1.1 运行时环境

- **运行位置**：Electron 主进程；窗口由 007-app-entry 在宿主就绪前后分阶段驱动。
- **渲染进程**：Chromium 150，`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`（🔶 dsh 基线）。
- **编译产物**：`src/main/windows.ts` / `src/main/window-state.ts` → `.vite/build/main.js`；loading 页 = `index.html`（Vite renderer 目标 `main_window`，`vite.renderer.config.ts`）+ `src/renderer/renderer.ts`。
- **加载通道（唯一形态）**：`loadURL('http://127.0.0.1:<port>/')` —— 与上游 Host/Origin/`Sec-Fetch-Site` 校验天然兼容（✅ §4.3、`lib/request-security.ts` 对 IP 字面量放行）。
- **窗口形态**：常规系统标题栏（`frame: true`），无窗口控制 IPC、无自绘标题栏（§5.2）。

### 1.2 依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `electron`（`BrowserWindow` / `session` / `shell` / `screen` / `nativeTheme`） | 内置 | 建窗、cookie 与出栈头注入、外链、多显示器校验 |
| `src/main/window-state.ts` | 本模块 | `window-state.json` 读写（防抖 400 ms、`getNormalBounds()`、可见性校验） |
| `src/main/constants.ts` | 本项目（✅ 已存在） | `DEFAULT_WINDOW_WIDTH=1200`、`DEFAULT_WINDOW_HEIGHT=800`、`MIN_WINDOW_*`、`PI_WEB_SESSION_COOKIE='pi_web_session'`、`PI_WEB_AUTH_USERNAME='pi'`、`PI_WEB_SESSION_MAX_AGE_SECONDS` |
| `src/main/logger.ts` | 本项目（✅ 已存在） | `logInfo/logWarn/logError/describeError` |
| 001-host 的 `HostHandle` | 本工程 | `url`、`password` |
| 上游 `pi-web/lib/web-auth.ts` | 上游源码 | cookie 派生算法（复刻点，见 §3.3） |
| `index.html` + `src/renderer/renderer.ts` | 本项目（✅ 均已存在：`index.html`；`renderer.ts` 86 行） | loading/兜底页与阶段文本渲染 |

> 本模块不引入第三方运行时依赖；F11、外链、权限白名单全部用 Electron 内置能力实现。

## 2. 宪法合规检查

| 原则（`docs/工程规划.md` §3 / §4.5 / §11.4） | 状态 | 说明 |
|---|---|---|
| 同源数据面（§3 原则 4） | ✅ | 渲染层只同源 HTTP；窗口不承载数据面 IPC（FR-002-005） |
| 数据面零 IPC / preload 默认最小（§5.6） | ✅ | 本模块不注册任何 IPC；loading 页文本经 `executeJavaScript` 推送（FR-002-009） |
| 安全：渲染进程隔离（§4.5） | ✅ | `sandbox` + `contextIsolation` + 无 `nodeIntegration`（FR-002-004） |
| 安全：导航加固（§4.5、S6） | ✅ | `setWindowOpenHandler` 一律 deny + `will-navigate` 白名单（FR-002-018…021） |
| 安全：权限白名单（§4.5） | ✅ | 白名单 + 受信来源 + `webContents.id` 三条件（FR-002-022、FR-002-023） |
| 安全 S1/S4（生产无 --inspect / DevTools 仅 dev） | ✅ | 见 FR-002-006 的实现约定（`app.isPackaged` 判定） |
| 失败可见（§3 原则 5） | ✅ | loading 页阶段文本 + `did-fail-load`/`render-process-gone` 留痕（FR-002-010、FR-002-013） |
| 平台差异显式化（§3 原则 6、§9.3） | ✅ | 常规标题栏三平台一致；托盘图标差异在 003 |
| 零上游改动（§7） | ✅ | 本模块不改上游；凭据派生是**复刻**而非补丁（§3.3 登记的复核义务） |
| 代码质量：strict TS、无 `as any`、严禁空 catch | ⬜ | 代码已落地（2026-10-12 复核），待人工评审 |

> 合规结论：安全相关项全部 ✅；代码质量项在 `src/main/windows.ts` 落地后复核。

## 3. 研究结论

### 3.1 关键决策与理由

| 决策 | 理由 | 对应 FR |
|---|---|---|
| 同源 `loadURL` 为唯一渲染通道 | `file://` 静态导出不可行；自定义协议会 403（Host/Origin 校验） | FR-002-005、FR-002-008 |
| 常规标题栏（`frame: true`） | 🔶 dsh 已回退到此形态：无自绘标题栏即无窗口控制 IPC，安全面与维护成本同时下降 | FR-002-001、FR-002-002 |
| 先 loading 页、后真实 URL | 首启解压数十秒，直接加载会长时间白屏（🔶 §4.3） | FR-002-007…011 |
| 凭据注入两件（cookie + Basic） | ✅ 源码核实：Basic 只在 `/api/*` 生效，导航认 cookie | FR-002-014、FR-002-015 |
| `show: false` + `ready-to-show` | 避免白屏闪烁；与 loading 页配合形成「有内容的等待」 | FR-002-003 |
| 窗口状态用 `getNormalBounds()` | 避免把最大化/全屏尺寸写回去，导致「恢复后窗口比屏幕还大」 | FR-002-024 |
| 恢复前做多显示器可见性校验 | 外接屏拔掉后窗口可能落在不存在的坐标上 | FR-002-025 |
| 关窗即退出（放行 close） | 对齐 dsh；常驻模式属 Phase 2（O8） | FR-002-028 |

### 3.2 上游源码核实（✅ / 🔶 / ⬜）

| # | 事实 | 依据 |
|---|---|---|
| U1 | pi-web 不可静态导出（无 `output: 'export'`；有 route handler / SSE / fs / PTY / middleware） | ✅ `pi-web/next.config.ts`、§4.3 |
| U2 | 认证：matcher `["/", "/login", "/api/:path*"]`；未设 `PI_WEB_PASSWORD` = 完全无认证 | ✅ `pi-web/proxy.ts` |
| U3 | 页面导航只认 cookie `pi_web_session`（`v1.<exp>.<nonce>.<HMAC>`，30 天）；Basic 用户名固定 `pi` | ✅ `pi-web/lib/web-auth.ts`、`proxy.ts` |
| U4 | Host 门禁放行 IP 字面量 → `127.0.0.1` 天然通过；同源 Origin 与 `Sec-Fetch-Site` 校验通过 | ✅ `pi-web/lib/request-security.ts` |
| U5 | UI 用 `window.open` 打开 OAuth 登录页与会话导出；导出路径会 spawn `pi` CLI | ✅ §2.2；⚠️ R6（Electron 下 `process.execPath` 语义不同） |
| U6 | 壳层扩展点：浏览器事件 `pi-web:session-row-contextmenu`、保活注册表 `Symbol.for("@agegr/pi-web/session-liveness/v1")` | ✅ §2.2（本模块 v1 不接管右键菜单，属 Phase 2） |
| U7 | `http://127.0.0.1` 在 Chromium 中为可信来源（loopback 例外），`crypto.subtle`/`localStorage` 可用 | ⬜ P0-3 探针断言（§4.3 明确要求不得默认成立） |
| U8 | `sandbox: true` 下 preload 仍可在 `contextBridge` 上暴露 API（但本工程默认不需要） | 🔶 dsh 现状（`src/preload/index.ts` 默认空实现） |

### 3.3 凭据注入的两件套（FR-002-014、FR-002-015）

**为什么要派生 cookie 而不只注入 Basic**：`proxy.ts` 的鉴权分支是 `const authorization = isApiRequest ? request.headers.get("authorization") : null;` —— Basic 头**只在 `/api/*`** 请求上被读取；页面导航若没有有效会话 cookie 会被 302 到 `/login`。因此：

```
① 出栈注入（覆盖 API 与 SSE）
   session.webRequest.onBeforeSendHeaders({ urls: [`http://127.0.0.1:${port}/*`] }, (details, cb) => {
     cb({ requestHeaders: { ...details.requestHeaders, Authorization: `Basic ${base64('pi:' + password)}` } });
   });

② 会话 cookie（覆盖页面导航）
   payload   = `v1.${Math.floor(Date.now()/1000) + PI_WEB_SESSION_MAX_AGE_SECONDS}.${randomBytes(16).toString('hex')}`
   signature = HMAC-SHA256(key = password, data = 'pi-web-session:' + payload).toString('hex')
   token     = `${payload}.${signature}`
   session.cookies.set({ url, name: PI_WEB_SESSION_COOKIE, value: token, httpOnly: true, sameSite: 'lax' })
```

⚠️ 这是本工程**唯一一处复刻上游算法**的位置，因此对上游升级敏感（R10）。复核方式：`diff` 本实现与 `pi-web/lib/web-auth.ts`，若签名前缀（`pi-web-session:`）、payload 形状或有效期常量（`PI_WEB_SESSION_MAX_AGE`）变化，必须同步。**不得**改成「用户名口令式手工登录」：那会引入用户可见的多余步骤，与「凭据自动注入」的产品决策冲突。

### 3.4 加载时序与降级

```
createMainWindow()
  ├─ restoreState(window-state.json)   （可见性校验 → 失败回退默认 1200×800 居中）
  ├─ new BrowserWindow({ show:false, frame:true, ...webPreferences })
  ├─ installNavigationGuards(win)      （setWindowOpenHandler / will-navigate / setPermissionRequestHandler）
  ├─ loadFile(index.html)              （loading 页，FR-002-007）
  ├─ 等待 host 就绪：
  │    就绪 → installCredentials(win, { url, password }) → loadURL(url)  （FR-002-008）
  │    失败 → pushFailure(stage, reason)                                 （FR-002-010）
  └─ ready-to-show → win.show()
```

**开发态捷径**：`PI_DESKTOP_DEV_SERVER` 存在时跳过解压与内嵌服务器，直接 `loadURL(该地址)`（§8.4 的开发/调试循环）。此时凭据注入仍按同一函数执行（dev server 若设了 `PI_WEB_PASSWORD` 同样需要）。

## 4. 数据模型

### 4.1 实体

| 实体 | 字段 | 说明 |
|---|---|---|
| `WindowState` | `{ x: number; y: number; width: number; height: number; isMaximized: boolean }` | `<userData>/window-state.json`（FR-002-024） |
| `TrustedOrigin` | 判定函数，无状态 | 同源 `http://127.0.0.1:<port>` / dev server 前缀；解析失败 → `false` |
| `RENDERER_PERMISSIONS` | `Set<string>` | `notifications`（+ 可选 `clipboard-sanitized-write`）（FR-002-022） |
| `Credentials` | `{ url: string; password: string }` | 由 001 的 `HostHandle` 投影而来，注入后不保留明文引用 |

### 4.2 状态机（窗口）

```
created (show:false, loading 页)
  → loading      （阶段文本更新中；失败可停在此态并显示原因）
  → navigating   （loadURL(host url)）
  → shown        （ready-to-show → show()）
  → closed       （放行 close）→ window-all-closed → 007 触发 app.quit()

旁路：render-process-gone → 记录 + 提示（可选自动 reload 一次）
      did-fail-load       → 记录 + loading 页显示失败阶段（可重试）
```

### 4.3 校验规则

- 受信来源：`protocol === 'http:'` 且 `hostname ∈ {'127.0.0.1','localhost'}` 且 `port === <本次端口>`；或 `rawUrl.startsWith(PI_DESKTOP_DEV_SERVER)`。
- 权限：`RENDERER_PERMISSIONS.has(permission)` ∧ `isTrustedOrigin(details.requestingUrl)` ∧ `webContents.id === mainWindow.webContents.id`；任一不满足 → `callback(false)`。
- 窗口状态：宽高必须 ≥ 最小尺寸且 ≤ 任一显示器工作区尺寸 + 允许溢出裕量；不满足即整体回退默认值（不做「部分字段修正」，避免半残状态）。
- 凭据注入：URL 必须严格等于 `http://127.0.0.1:<port>/*`（协议、主机、端口三重匹配），否则不注入。

## 5. 接口契约

### 5.1 提供接口（本模块导出）

| 导出 | 签名 | 说明 |
|---|---|---|
| `createMainWindow(credentials)` | `(c: Credentials \| null) => BrowserWindow` | 建窗 + 装加固 + 加载 loading 页 |
| `loadHostUrl(win, credentials)` | `(win, c: Credentials) => Promise<void>` | 注入凭据并 `loadURL`（就绪后调用） |
| `pushStage(text)` / `pushFailure(stage, reason)` | `(string) => void` / `(string, string) => void` | 更新 loading 页与窗口标题（FR-002-009、FR-002-010） |
| `showMainWindow()` | `() => void` | 唤回（restore → show → focus）；供 003-tray 使用 |
| `getMainWindow()` | `() => BrowserWindow \| null` | 供 004-notification 判定可见性 |

### 5.2 消费接口（本模块依赖）

| 来源 | 符号 |
|---|---|
| `electron` | `BrowserWindow`, `session`, `shell`, `screen`, `app` |
| `src/main/window-state.ts` | `loadWindowState()`、`attachStatePersist(win)`（防抖） |
| `src/main/logger.ts` | `logInfo/logWarn/logError/describeError` |
| 001-host | `HostHandle.url`、`HostHandle.password` |

### 5.3 前端契约（loading 页 ↔ 主进程）

| 通道 | 方向 | 载荷 | 说明 |
|---|---|---|---|
| `executeJavaScript('window.__piDesktopStage(...)')` | 主进程 → loading 页 | `{ stage: string; detail?: string; elapsedMs?: number }` | 阶段推进（FR-002-009） |
| `executeJavaScript('window.__piDesktopFail(...)')` | 主进程 → loading 页 | `{ stage: string; reason: string }` | 失败态（FR-002-010） |
| 页面按钮 → 主进程 | loading 页 → 主进程 | 动作名（`open-log` / `retry` / `quit`） | v1 实现方式 ⬜：`file://` 文档下可用 preload 桥（见 006）；HTTP 文档下无桥 → 需 006 的 `file://` 限定策略配合 |

> ⚠️ 这是本模块唯一的前端契约。006-preload 对 `file://` 文档暴露 `piDesktop{..., onStage}` 就是为它服务的；**数据面（会话/对话）永不过该通道**。

## 6. 实现策略

### 6.1 架构模式

**工厂 + 一组加固安装函数**：`createMainWindow()` 负责建窗与装载 loading 页；`installNavigationGuards(win)`、`installCredentials(win, c)`、`attachStatePersist(win)` 各自独立、幂等、可单测。窗口实例由模块级变量持有（`mainWindow`），所有外部访问经 `getMainWindow()` / `showMainWindow()`（避免闭包持有过期引用）。

### 6.2 关键算法

- **可见性校验**：`screen.getAllDisplays()` → 逐个求工作区矩形交集面积 → 全部为 0 即判定不可见 → 回退默认尺寸并居中到 `screen.getPrimaryDisplay()`。
- **防抖持久化**：监听 `resize` / `move` / `maximize` / `unmaximize`，400 ms 防抖后写 `getNormalBounds()` + `isMaximized()`；`close` 前再落一次（取消挂起的定时器，先写后关）。
- **权限判定**：三条件合取（白名单 ∧ 受信来源 ∧ webContents 匹配），默认拒绝。
- **导航判定**：`will-navigate` 先 `isTrustedOrigin(url)`；不受信则 `event.preventDefault()` + `shell.openExternal(url)`（仅 `http:`/`https:`）。
- **F11**：`before-input-event` 监听 `key === 'F11'` → `win.setFullScreen(!win.isFullScreen())`；macOS 上保持同一行为（若不适用则忽略，不抛错）。

### 6.3 错误处理

- `did-fail-load`：忽略 `isMainFrame === false` 的子资源失败；主框架失败写 `logError` + loading 页失败态（错误码 `-105` 等需转成可读文本）。
- `render-process-gone`：`logError` 记录 `reason`；SHOULD 自动 reload 一次（上限 1 次），再失败即停在失败页。
- `pushStage`/`pushFailure` 的 `executeJavaScript` MUST `catch` 且只 `logWarn`（页面可能尚未加载完，属预期竞态；**非空 catch**）。
- 窗口状态文件：解析/校验失败 → 回退默认 + `logWarn`（不阻塞启动，FR-002-027）。

### 6.4 性能

- 加载路径无轮询（就绪判定在 001）；本模块只在 `ready-to-show` 与状态事件上工作。
- 状态写入防抖 400 ms，避免拖动窗口时高频 IO。
- 凭据注入为一次性注册（`onBeforeSendHeaders` 常驻但无额外 IPC 开销）。

## 7. 测试考量

| 层次 | 方式 | 覆盖需求 |
|---|---|---|
| 静态 | `npm run typecheck` | 全部 |
| 单元 | `isTrustedOrigin()`：同源 / 端口不同 / 非 loopback / 畸形 URL（解析失败）四类断言 | FR-002-019、FR-002-020 |
| 单元 | 窗口状态：正常 / 副屏消失 / 字段缺失 / JSON 损坏 四种输入的恢复结果 | FR-002-024、FR-002-025、FR-002-027 |
| 单元 | 权限判定三条件的真值表（含 `webContents.id` 不匹配分支） | FR-002-022、FR-002-023 |
| 集成（**门禁**） | `scripts/smoke-desktop.mjs` 的 SPA 断言保证 `GET /` 可被窗口渲染（窗口本身在 P0-3 探针验证） | FR-002-008 |
| 探针 | **P0-3**：窗口加载 `http://127.0.0.1:<port>/`，断言首屏（侧栏 + composer）、`fetch /api/*` 200、SSE 长连接稳定、`localStorage`/`crypto.subtle` 可用、`window.open` 被拦截 | FR-002-004、FR-002-007…009、FR-002-014…018 |
| 手动 | 三平台各跑一次：F11 往返、多显示器拖拽后重启、外链点击、关窗退出 | FR-002-024…030 |
| 负向 | 用 `POST /api/...` 之外的地址触发 `will-navigate`（如 `data:` URL）→ 断言被拦截且无外链调用 | FR-002-019、FR-002-020 |

## 8. 文件清单

| 文件 | 用途 | 状态（2026-10-12 复核） |
|---|---|---|
| `src/main/windows.ts` | 建窗 + 加固 + 壳层 IPC 注册 + 阶段文本 + UI 加载 | ✅ 已存在（201 行；实际导出 `createMainWindow(deps)` / `setStageOnWindow` / `loadPiWebUi` / `registerShellIpc` / `getMainWindow`） |
| `src/main/window-state.ts` | `window-state.json` 读写（防抖 / 可见性校验 / F11） | ✅ 已存在（124 行；`loadWindowState` / `trackWindowState` / `installFullscreenShortcut`） |
| `index.html` | loading / 兜底页（CSP `default-src 'self'`，含「打开日志/重试/退出」按钮） | ✅ 已存在 |
| `src/renderer/renderer.ts` | loading 页脚本（阶段渲染 + 动作按钮接线） | ✅ 已存在（86 行） |
| `src/preload/index.ts` | `file://` 文档下的最小壳层桥（`onStage` / 动作转发） | ✅ 已存在（34 行；见 006） |
| `src/main/host.ts`（001） | 提供宿主 URL、密码与凭据注入实现 | ✅ 已存在（518 行；凭据注入 `installAuthInjection` / `installAuthForWindow`） |
| `src/main/constants.ts` | 窗口尺寸、cookie 名与有效期常量 | ✅ 已存在（56 行） |

> `vite.renderer.config.ts` 已配置 renderer 目标（`main_window`），无需改动；本模块不新增配置文件。§5 的导出名为设计期建议，**以源文件为准**。

## 9. 与规格交叉引用

| 规格需求 | 实现落点 |
|---|---|
| FR-002-001…006（建窗 / 显示 / 隔离 / 目标 / dev 区分） | §3.1 决策表 + §6.1 + §4.2 状态机 |
| FR-002-007…013（loading 页 / 加载策略 / 失败可见） | §3.4 加载时序 + §5.3 前端契约 + §6.3 |
| FR-002-014…017（凭据注入两件 / 不外泄） | §3.3 注入算法 + §4.3 校验规则 |
| FR-002-018…021（导航加固 / 受信来源） | §6.2「导航判定」+ §6.3 |
| FR-002-022…023（权限白名单三条件） | §6.2「权限判定」 |
| FR-002-024…027（状态持久化 / 可见性 / F11 / 容错） | §6.2「防抖持久化」「可见性校验」 |
| FR-002-028…030（关窗退出 / 确认 / 不拦截） | §4.2 状态机的 `closed` 边 + 007-app-entry 的 `window-all-closed` |
| §5 验收场景 S1–S9 | §7 测试考量（P0-3 覆盖 S1/S2/S4/S5，手动覆盖 S6/S7/S9，负向覆盖 S3/S8） |
