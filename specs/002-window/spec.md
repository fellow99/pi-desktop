# 002 — 窗口管理（window）功能规格

> **Module:** 002-window（窗口管理）  **Status:** Proposed  **Last Updated:** 2026-10-12  **上游基线:** pi v1.1.0 / pi-web v0.11.1
> **对应方案:** [`./plan.md`](./plan.md)
> **实现落点:** `src/main/windows.ts`、`src/main/window-state.ts`（配套 `index.html`、`src/renderer/renderer.ts`）
> **规划依据:** `docs/工程规划.md` §4.3、§4.5、§5.2、§5.5、§9.3、§11.1 R4/R6、§11.4 S1/S4/S6

## 1. 模块概述

### 1.1 目的

窗口模块的职责是：**用 BrowserWindow 承载 Pi Web UI（同源加载 `http://127.0.0.1:<port>/`），在宿主就绪前用本地 loading 页替代白屏，并把渲染进程按不可信内容做导航加固、权限白名单与状态持久化**。

加载通道只有一种形态（✅ 决策 §4.3）：`BrowserWindow` 同源加载内嵌服务器地址。`file://` 加载静态导出**不可行**（pi-web 无 `output: 'export'`，有 route handler / SSE / fs / PTY / middleware），自定义协议会触发 `proxy.ts` 的 Host/Origin 403。

### 1.2 解决的问题

- **首启白屏**：首次启动要解压 pi-dist（数万文件，HOS 同源实测约 15 s）+ 起服务 + 首屏，直接加载会长时间白屏（🔶 §4.3、§8.3）。必须以 loading 页承载「阶段 + 耗时 + 失败原因」。
- **OAuth 与导出的新窗口**：Pi Web UI 用 `window.open` 打开 OAuth 登录页与会话 HTML 导出（⚠️ R6：导出会 spawn `pi` CLI）。应用内必须一律拦截，外链交系统浏览器。
- **渲染层按不可信内容对待**：渲染层加载的是 loopback HTTP 内容（含用户会话与模型输出），一旦有 XSS，未加固的渲染进程可提权到 Node 环境（`docs/工程规划.md` §4.5）。
- **凭据注入缺一不可**：✅ 源码核实 —— Basic 头**只在 `/api/*`** 校验，页面导航只认 `pi_web_session` cookie。只注入 Basic 会把用户送到 `/login`。
- **状态记忆**：用户期望窗口位置/尺寸/最大化状态在重启后保留；且多显示器拔插后不得出现「窗口在屏幕外」。

### 1.3 范围

**包含**

- 主窗口创建与显示（尺寸、常规标题栏、`show:false` + `ready-to-show`）。
- loading / 兜底页（`index.html` + `src/renderer/renderer.ts`）与主进程 → 页面的阶段文本通道。
- 加载策略：就绪前 loading 页、就绪后 `loadURL`、开发态直连 dev server、加载失败可见。
- 凭据注入（cookie + Basic 两件，出栈注入）。
- 导航加固（`setWindowOpenHandler` / `will-navigate`）与权限白名单。
- 窗口状态持久化（防抖、边界校验）与 F11 全屏。
- 关窗即退出的放行语义（真正的退出由 007 编排）。

**不包含**

- 宿主启动、端口、密码生成 → 001-host。
- 托盘图标与菜单 → 003-tray。
- 原生通知 → 004-notification。
- 应用退出链（`before-quit` / deadline 强退）→ 005-lifecycle、007-app-entry。
- 渲染层业务 UI（会话/对话/终端）→ 上游 Pi Web UI，本工程不 fork、不重写。
- 无边框窗口、自绘标题栏、窗口控制 IPC（`window:*`）→ **明确不做**（§5.2、§5.8；dsh 已回退到 `frame:true`）。

## 2. 用户故事

- 作为用户，我希望启动时看到的是「正在启动 Pi」的阶段说明（而不是白屏），并且能在失败时读到具体原因与打开日志。
- 作为用户，我希望就绪后自动进入 Pi Web UI，且不需要手工登录（凭据由壳层注入）。
- 作为用户，我希望窗口的大小/位置/最大化状态在下次启动时被记住。
- 作为用户，我希望 F11 能切换全屏，退出全屏后窗口回到原来的位置与尺寸。
- 作为用户，我希望点界面里的外部链接时用系统默认浏览器打开，而不是把应用窗口变成浏览器。
- 作为用户，我希望关掉窗口就等于退出应用，不在后台留下看不见的常驻进程。
- 作为安全评审者，我希望知道渲染进程没有 Node 能力、只放行了白名单权限、并且加载的页面不会被劫持导航到任意外部地址。

## 3. 功能需求

动作词：**MUST** 必须满足；**MUST NOT** 禁止；**SHOULD** 建议；**MAY** 可选。

### 3.1 建窗与显示

- FR-002-001：系统 MUST 创建唯一的应用主窗口（`BrowserWindow`），默认尺寸 1200×800、最小尺寸 800×600、**常规系统标题栏**（`frame: true`）。
- FR-002-002：系统 MUST NOT 实现无边框/自绘标题栏或任何窗口控制 IPC 通道（`window:minimize` 之类）。
- FR-002-003：系统 MUST 以 `show: false` 创建窗口，并在 `ready-to-show` 后再显示，避免白屏闪烁。
- FR-002-004：系统 MUST 以 `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` 配置渲染进程。**MUST NOT** 打开任何 Node 集成能力。
- FR-002-005：系统 MUST 以 001-host 提供的 `HostHandle.url` 作为加载目标，**MUST NOT** 自行猜测端口或自行拉起服务器。
- FR-002-006：系统 MUST 在开发态（`openDevTools` / `--inspect`）与生产态之间显式区分：生产构建 MUST NOT 打开 DevTools、MUST NOT 注册远程调试端口（§11.4 S1/S4）。

### 3.2 加载策略与 loading 页

- FR-002-007：系统 MUST 在宿主就绪之前加载本地 loading 页（`index.html`，CSP `default-src 'self'`），**MUST NOT** 以空白页或无内容窗口替代。
- FR-002-008：系统 MUST 在宿主就绪后调用 `loadURL('http://127.0.0.1:<port>/')`，并在首屏完成后不再显示 loading 页。
- FR-002-009：系统 MUST 把当前启动阶段文本推送进 loading 页；阶段至少覆盖：环境装配 / 产物就位 / 密钥轮换 / 服务器启动 / 就绪等待 / 加载 UI。
- FR-002-010：任一阶段失败时，系统 MUST 在 loading 页显示「阶段名 + 原因」，并 MUST 同时把同一信息写入窗口标题与应用日志。
- FR-002-011：loading 页 MUST 提供「打开日志」「重试」「退出」三个动作，且三者的可用性在失败态下不得静默失效。
- FR-002-012：系统 MAY 在 `PI_DESKTOP_DEV_SERVER` 被设置时直接加载该地址（开发态捷径，跳过解压与内嵌服务器）。
- FR-002-013：系统 MUST 记录 `did-fail-load`（错误码、描述、失败 URL）与 `render-process-gone`（原因）到日志，并在界面上可感知（不静默）。

### 3.3 凭据注入（与 001 的契约）

- FR-002-014：系统 MUST 按上游 `lib/web-auth.ts` 的算法派生会话 token 并写入 cookie `pi_web_session`（`session.cookies.set`，作用域限定为本服务 origin）。**MUST NOT** 自行发明新的鉴权协议。
- FR-002-015：系统 MUST 经 `session.webRequest.onBeforeSendHeaders` 对本服务 origin 的请求注入 `Authorization: Basic pi:<password>`，覆盖 `/api/*` 与 SSE 连接。
- FR-002-016：凭据注入 MUST 只针对 `http://127.0.0.1:<port>`；**MUST NOT** 对外部地址注入任何凭据。
- FR-002-017：密码 MUST NOT 出现在日志、窗口标题、loading 页文本或任何落盘文件（含 `window-state.json`）。

### 3.4 导航加固

- FR-002-018：系统 MUST 用 `setWindowOpenHandler` 拒绝一切新窗口请求；`http:`/`https:` 目标交 `shell.openExternal`，其它协议一律丢弃。
- FR-002-019：系统 MUST 用 `will-navigate` 只放行同源导航（`http://127.0.0.1:<port>` 与 dev server 前缀）；其它地址一律 `preventDefault()` 并交系统浏览器。
- FR-002-020：系统 MUST NOT 在应用窗口内嵌加载任意网页（§11.4 S6）；受信来源判定 MUST 在解析失败时返回「不受信」。
- FR-002-021：受信来源判定 MUST 同时覆盖主窗口的 `webContents.id`（权限与导航校验都不得对其它 webContents 放行）。

### 3.5 权限白名单

- FR-002-022：系统 MUST 仅放行白名单权限（`notifications`；如确需粘贴图片再追加 `clipboard-sanitized-write`），并 MUST 同时满足「权限在白名单内」「来源为受信来源」「`webContents.id` 匹配主窗口」三个条件，否则一律拒绝。
- FR-002-023：系统 MUST NOT 放行 `geolocation`/`media`/`midi`/`openExternal` 等任何未列入白名单的权限。

### 3.6 窗口状态与全屏

- FR-002-024：系统 MUST 在 `<userData>/window-state.json` 持久化窗口尺寸、位置与最大化状态，写入 MUST 防抖（默认 400 ms），取尺寸 MUST 用 `getNormalBounds()`（避免把最大化/全屏尺寸写回去）。
- FR-002-025：系统 MUST 在恢复状态前做多显示器可见性校验（窗口矩形与任一显示器工作区有交集）；校验失败 MUST 回退默认尺寸与居中位置，**MUST NOT** 让窗口落在不可见区域。
- FR-002-026：系统 MUST 支持 F11 切换全屏，且全屏切换 MUST NOT 破坏已持久化的普通状态（普通 bounds 不被覆盖）。
- FR-002-027：窗口状态文件损坏或字段缺失时，系统 MUST 回退默认值并继续启动（记录 WARN，不阻塞）。

### 3.7 关闭语义

- FR-002-028：系统 MUST 放行窗口关闭（不拦截、不最小化到托盘），由 007-app-entry 的 `window-all-closed` 触发 `app.quit()`（关窗即退出，对齐 `dsh-desktop`）。
- FR-002-029：系统 SHOULD 在存在运行中的 agent 会话时，关窗前给一次确认提示。⬜ 会话运行态的判定来源待 P0-5 探针（会话 JSONL 尾随）确定；未确定前不得用「猜测的活跃会话」阻止退出。
- FR-002-030：系统 MUST NOT 在 `before-quit` 流程中拦截窗口关闭（退出链必须能走完）。

## 4. 关键实体

| 实体 | 说明 | 关键属性 |
|---|---|---|
| 主窗口 | 应用唯一窗口 | 尺寸（1200×800，最小 800×600）、`frame: true`、`show: false`、webPreferences（sandbox/contextIsolation/nodeIntegration） |
| 窗口状态 | 持久化的窗口几何 | `{ x, y, width, height, isMaximized }` → `<userData>/window-state.json` |
| 受信来源判定 | 是否允许原地导航 / 注入凭据 | 同源 `http://127.0.0.1:<port>`、dev server 前缀；解析失败 = 不受信 |
| 权限白名单 | 允许渲染层申请的权限集合 | `notifications`（+ 可选 `clipboard-sanitized-write`） |
| loading 页契约 | 主进程 → 页面的唯一前端契约 | `pushStage(text)`、`pushFailure(stage, reason)`（`index.html` + `src/renderer/renderer.ts` 实现） |
| 加载目标 | 窗口加载的地址 | `HostHandle.url`（就绪后）/ `index.html`（就绪前）/ `PI_DESKTOP_DEV_SERVER`（可选） |

## 5. 验收场景

### 场景 S1：首启 loading → 首屏

- Given 首次启动且需要解压产物（数十秒量级）
- When 窗口创建完成
- Then 窗口先显示 loading 页并按阶段更新文本；宿主就绪后自动加载 `http://127.0.0.1:<port>/` 并进入 Pi Web UI 首屏

### 场景 S2：无需手工登录

- Given 宿主已就绪且 `PI_WEB_PASSWORD` 已注入
- When 窗口加载 UI
- Then 页面直接进入应用界面（不被重定向到 `/login`），`/api/*` 与 SSE 均携带凭据

### 场景 S3：外部链接走系统浏览器

- Given Pi Web UI 中出现指向外部站点的链接（或页面尝试导航到外部地址）
- When 用户点击该链接
- Then 应用窗口不跳转，系统默认浏览器打开该地址

### 场景 S4：`window.open` 一律拦截

- Given UI 触发 `window.open('https://example.com/oauth')`
- When 请求到达主进程
- Then 返回 `{ action: 'deny' }`，应用内不出现新窗口，地址交系统浏览器

### 场景 S5：权限白名单

- Given 渲染层申请 `notifications` 且来源受信、`webContents.id` 匹配
- When 权限请求被处理
- Then 放行；申请任何白名单外权限（如 `geolocation`）时一律拒绝

### 场景 S6：窗口状态记忆

- Given 用户把窗口移动到副屏并最大化后退出
- When 用户重新启动应用
- Then 窗口按持久化状态恢复；若副屏已断开，则回退到主屏可见位置的默认尺寸

### 场景 S7：F11 全屏往返

- Given 窗口处于普通状态、尺寸 1200×800
- When 用户按 F11 进入全屏再按 F11 退出
- Then 返回后窗口恢复到进入前的普通尺寸与位置（状态文件中普通 bounds 未被全屏尺寸污染）

### 场景 S8：加载失败可见

- Given 服务器地址不可达（例如就绪后进程内异常）
- When 窗口加载失败
- Then `did-fail-load` 的错误码与 URL 进入日志，loading 页显示失败阶段与原因，并提供「打开日志 / 重试 / 退出」

### 场景 S9：关窗即退出

- Given 应用运行中
- When 用户关闭主窗口
- Then 窗口关闭事件被放行，007 触发 `app.quit()` 并走优雅关闭链（无残留进程）

## 6. 非功能需求

- **安全**：渲染进程加载的是本地服务提供的**不可信内容**，必须按「沙箱 + 隔离 + 导航加固 + 权限白名单」四件套处理（§4.5）；凭据只进本服务 origin。
- **可观测性**：加载失败、渲染进程崩溃、权限拒绝都必须留痕且可见（fail-visible）。
- **性能**：`show: false` + `ready-to-show` 避免白屏闪烁；窗口状态写入防抖，避免高频磁盘 IO。
- **可用性**：loading 页在窄窗口（最小 800×600）下仍可读；阶段文本包含耗时，便于用户判断「是否卡住」。
- **可维护性**：加载策略、受信来源判定、权限白名单、状态持久化集中在两个文件内，便于安全审计。
- **平台一致性**：常规标题栏在三平台一致（不做平台特化标题栏）；F11 在 macOS 上退化为无操作 MUST NOT 导致异常。

## 7. 假设与约束

- **假设（🔶 沿用 dsh）**：`frame: true` 的常规标题栏是本工程的既定形态（dsh 已从无边框回退）；因此**没有**窗口控制 IPC，`preload` 也不需要窗口控制 API。
- **假设（⬜ 待验证 P0-3）**：`http://127.0.0.1` 在 Chromium 中属**可信来源**（loopback 例外），因此 `crypto.subtle`、`localStorage`、剪贴板等能力可用。**不默认成立**，必须在 P0-3 中断言。
- **假设（✅ 源码核实）**：Basic 凭据只在 `/api/*` 被校验，页面导航只认 cookie —— 因此注入必须做两件（FR-002-014、FR-002-015）。
- **约束**：受信来源仅限本服务 origin 与 dev server；不信任任何其它 http/https 地址。
- **约束**：v1 关窗即退出，不做「关窗最小化到托盘」常驻模式（§9.2、§11.2 O8 属 Phase 2）。
- **约束**：⬜ 会话 HTML 导出会 spawn `pi` CLI（`process.execPath` 在 Electron 下语义不同，⚠️ R6）。本模块只负责「新窗口一律 deny + 交系统浏览器」，导出是否可用由 P0 实测决定；**不得**为此改上游。
- **约束**：⬜ 关窗确认（FR-002-029）依赖「会话是否运行中」的判定来源，当前唯一候选是会话 JSONL 尾随（P0-5）；在探针出结论前不得实现为阻塞式确认。

## 8. 依赖

**上游（被本模块消费）**

- 001-host：`HostHandle{ url, password }`；本模块只消费，不参与启动。
- 008-runtime-config：`<userData>` 路径解析（窗口状态文件落点）。
- 上游 `pi-web/lib/web-auth.ts`：cookie 派生算法（复刻点，升级需复核）。

**下游（消费本模块）**

- 003-tray：「显示主窗口」需要本模块的窗口实例与唤回函数。
- 004-notification：判断「窗口是否可见/聚焦」以决定是否弹通知。
- 007-app-entry：建窗时机、`window-all-closed`、macOS `activate` 重建窗口。

**外部**

- Electron `BrowserWindow` / `session` / `shell` / `screen`；`node:fs`/`node:path`（状态文件）；`index.html` + `src/renderer/renderer.ts`（loading 页）。
