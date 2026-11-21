# 301 — 中枢服务同步（sync-daemon 内嵌）功能规格

> 需求编号 `301-sync-daemon` · 涉及工程：父工程 / pi-desktop / pi-desktop-android / pi-desktop-hos / pi-desktop-ark
> **本轮范围：仅 pi-desktop 实现**；android / hos / ark 三工程各建本编号目录记录「暂不实现」决策（各自 specs 内）。
> 上游参照：`pi-agent-hub`（`docs/001-协议规范.md`、`docs/002-插件开发指南.md`、`deploy/README.md`；
> `packages/sync-daemon`、`packages/sync-plugin-pi-web`，均以 npm 包 `@0.1.0` 发布）。

## 1. 模块概述

### 1.1 目的

把 pi-agent-hub 的端侧守护进程（`@pi-agent-hub/sync-daemon`）内嵌进 pi-desktop，
让桌面端无需独立部署 daemon，即可把本机 pi 会话（`~/.pi/agent/sessions`，与内嵌 pi-web 同源）
上行同步到中枢服务（hub-service），并接收中枢下行事件。

### 1.2 解决的问题

- 用户想在 pi-desktop 上"零额外部署"地接入中枢服务：当前需手动安装 sync-daemon、
  手写 `~/.pi-agent-hub/sync-daemon.json`、手动 `node .../main.js run`。
- 需要产品级的配置入口：中枢地址 / 本端名称 / 本端令牌 / 是否启用，需可视化表单 + 即时应用。

### 1.3 范围

| 项 | 范围内 | 范围外 |
|---|---|---|
| 托盘菜单 | 移除「会话目录」项；**不设**「设置」项（设置入口统一到 pi-web 设置对话框） | 上游 pi-web UI 使用的 IPC `pi-desktop:open-session-dir` **保留不动** |
| 中枢服务设置 | 在 **pi-web 设置对话框**末尾新增「中枢服务」分区（构建期补丁实现），内容与旧原生设置窗口一致（状态灯 / 地址 / 本端名称 / 本端令牌 / 是否启用 / 应用） | pi-web 其它分区的行为、顺序与样式 |
| 配置持久化 | `~/.pi-desktop/sync-daemon.json`（结构参考 `~/.pi-agent-hub/sync-daemon.json`，顶层加 `enabled`） | 迁移既有 `~/.pi-agent-hub/sync-daemon.json`（不读不写） |
| daemon 运行 | 以**子进程**方式拉起 npm 包 `@pi-agent-hub/sync-daemon@0.1.0` 的 CLI（`dist/main.js run --config`），`ELECTRON_RUN_AS_NODE=1` + `process.execPath`；pi-web 就绪后按 `enabled` 启动；应用按钮 / 退出时重启 / 停止 | 主进程内嵌 `Daemon` 类（弃，见 plan §3.1 D1） |
| 插件对接 | 启用 `@pi-agent-hub/sync-plugin-pi-web@0.1.0`（npm 包随 pi-desktop 安装），options（server / agentDir / password）由壳按运行时状态自动注入 | 用户可编辑插件 options（本轮不暴露 UI） |
| 状态反馈 | 进程级红绿状态灯：绿 = daemon 存活且 control API 可达；红 = 未启用 / 启动失败 / 进程退出 | hub SSE 连接级状态（daemon 未对外暴露，⬜ 后续） |
| 其它版别 | android / hos / ark 占位记录「暂不实现」 | 三端任何代码改动 |

## 2. 用户故事

1. 作为桌面用户，我在 pi-web 侧栏打开「设置」，切到「中枢服务」分区，就能配置同步，不必再翻命令行。
2. 作为桌面用户，我在「中枢服务」分区填入中枢地址 / 本端名称 / 本端令牌、打开「是否启用」，
   点「应用」，pi-desktop 立即按新配置（重）启动 sync-daemon，状态灯变绿即表示已接管。
3. 作为桌面用户，我关掉「是否启用」并「应用」，daemon 被停止，状态灯变红。
4. 作为桌面用户，pi-desktop 启动完成后，若配置中 `enabled=true` 且配置完整，sync-daemon 自动启动，
   本机 `~/.pi` 的会话数据开始上行到中枢。
5. 作为桌面用户，中枢地址填错时，应用后状态灯保持红、主窗口功能不受影响，我改对地址再次「应用」即可恢复。

## 3. 功能需求

> 编号 `FR-301-NNN`。动词规范：MUST / MUST NOT / SHOULD / MAY。

### 3.1 托盘菜单变更

- **FR-301-001**：托盘右键菜单 MUST 移除「会话目录」菜单项（及其 `hasAgentDir` 依赖逻辑）。
- **FR-301-002**：托盘右键菜单 MUST NOT 再提供「设置」菜单项；菜单只保留
  `显示主窗口 / 打开日志 / 检查更新… / 退出`（外加禁用的产品名标题与分隔线）。
- **FR-301-003**：渲染层 IPC `pi-desktop:open-session-dir`（preload `openSessionDir`）MUST 保留（上游 pi-web UI 可能调用）。

### 3.2 中枢服务设置分区（pi-web 设置对话框）

- **FR-301-004**：中枢服务设置 MUST 以 **pi-web 设置对话框的一个分区**呈现，MUST NOT 再使用独立 BrowserWindow /
  原生静态页；排序 MUST 位于 `MCP` 之后（`常规 / 模型 / 技能 / Agents / 插件 / MCP / 中枢服务`）。
- **FR-301-004a**：该分区 MUST 通过**构建期幂等补丁**实现（`patches/<pi-web-tag>/`），
  在 `prepare-next` 的 `next build` 之前应用、构建完成后回退；`../pi-web` 在工作树层面 MUST 保持 pristine
  （除构建窗口期外 `git status --porcelain` 为空）。补丁冲突 MUST 硬失败，MUST NOT 使用 `--3way` 或覆盖用户改动。
- **FR-301-004b**：该分区依赖的壳能力 MUST 经 `preload` 暴露为独立命名空间 `window.piDesktopSync`
  （仅 `get` / `apply`），MUST NOT 复用或扩大既有 `window.piDesktop` 壳动作桥；主进程 MUST 对每次 IPC
  调用校验 `senderFrame` 属于当前内嵌 pi-web 源（`http://127.0.0.1:<port>`），非本应用源一律拒绝并记 WARN。
- **FR-301-004c**：若 `window.piDesktopSync` 不存在（补丁版 pi-web 被单独在浏览器打开等），该分区 MUST NOT 显示，
  MUST NOT 呈现点了即报错的假入口。
- **FR-301-005**：分区 MUST 复用 pi-web 既有的 Settings 分区骨架（同一 `sections` 数组 → tab、手机端分区首页、
  键盘/焦点与 Escape 行为自动一致）；MUST NOT 自建第二套设置对话框。
- **FR-301-006**：「中枢服务」分区 MUST 包含：连接状态（红/绿状态灯 + 文案）、中枢服务地址（输入框）、
  本端名称（输入框）、本端令牌（输入框）、是否启用（switch）、`应用` 按钮。
- **FR-301-007**：分区挂载时 MUST 回填当前 `~/.pi-desktop/sync-daemon.json` 中的表单字段；
  本端令牌输入框 SHOULD 以密码形态展示并提供显示切换；分区文案 MUST 随 pi-web 语言（zh-CN / en / zh-TW）切换。

### 3.3 配置持久化

- **FR-301-008**：配置 MUST 存储于 `~/.pi-desktop/sync-daemon.json`（主进程负责读写，
  目录不存在则创建；文件权限 MUST NOT 宽于 0600）。
- **FR-301-009**：配置文件结构 MUST 与 `@pi-agent-hub/protocol` 的 SyncDaemonConfig 兼容
  （`hub{url,token}`、`host.name`、`plugins[]`、`agents`、`pluginRoot`、`pluginInstall`），
  顶层 MAY 附加壳私有字段（本轮：`enabled`）。
- **FR-301-010**：以下字段 MUST 由壳自动生成 / 固化，不暴露给用户编辑：
  `plugins = ["@pi-agent-hub/sync-plugin-pi-web"]`、
  `pluginRoot = ~/.pi-desktop/sync-daemon`（与本机独立 daemon 的 `~/.pi-agent-hub` 隔离）、
  `pluginInstall = false`（插件包随 pi-desktop 的 node_modules 安装，不运行期 npm install）、
  `agents["pi-web"].options`（`server` = 内嵌 pi-web URL、`agentDir` = 运行时 agentDir、
  `password` = 运行时 pi-web 密码）。
- **FR-301-011**：「应用」时 MUST 校验：`enabled=true` 时地址 MUST 为 http(s) URL、
  本端名称与令牌 MUST 非空；不通过 MUST 拒绝写入并给出可读错误提示。
- **FR-301-012**：写入 MUST 原子化（临时文件 + rename），避免半截 JSON 被 daemon 读到。

### 3.4 daemon 生命周期

- **FR-301-013**：pi-desktop 依赖 MUST 包含 `@pi-agent-hub/sync-daemon@0.1.0` 与
  `@pi-agent-hub/sync-plugin-pi-web@0.1.0`（npm registry，固定版本）。
- **FR-301-014**：pi-web 就绪（`boot()` 完成、`setStage('就绪')` 之后）时，MUST 读取配置，
  若 `enabled=true` 则按 FR-301-010 注入运行时 options 后拉起 daemon 子进程；
  `enabled=false` 或配置缺失/损坏时 MUST NOT 启动。
- **FR-301-015**：daemon MUST 以子进程运行：`process.execPath` + `ELECTRON_RUN_AS_NODE=1`
  + `@pi-agent-hub/sync-daemon/dist/main.js run --config <配置路径>`；
  MUST NOT 在 pi-desktop 主进程内 import 运行 Daemon 类（插件拉起依赖 node 身份，见 plan §3.1 D1）。
- **FR-301-016**：daemon 启动/运行失败（拉起失败、非 0 退出）MUST NOT 阻塞或拖垮主流程：
  只记日志 + 状态灯置红。
- **FR-301-017**：「应用」MUST 执行：校验并写回配置 → 若 daemon 在跑则先停止（等待退出）→
  按新 `enabled` 决定（重）启动；完成后 MUST 更新状态灯。
- **FR-301-018**：应用退出（will-quit）时 MUST 停止 daemon 子进程（含其插件子进程），
  不遗留孤儿进程。
- **FR-301-019**：daemon 子进程 env MUST 继承主进程 env 并显式带 `ELECTRON_RUN_AS_NODE=1`
  （使其内的插件 RpcClient 以 node 身份拉起插件）。
- **FR-301-020**：打包构建 MUST 开启 `FuseV1Options.RunAsNode`（当前为 false，会使
  `ELECTRON_RUN_AS_NODE` 在打包态失效；dev 态不受 fuse 影响），并在 plan 中记录安全权衡。

### 3.5 连接状态（红绿灯）

- **FR-301-021**：状态灯语义 = **进程级**（plan §3.3 D8，本轮已定）：
  - 绿 = daemon 子进程存活且其 control API（`pluginRoot/daemon-control.json` 中
    `{port,token}` → `GET http://127.0.0.1:<port>/local/status`，Bearer）可达；
  - 红 = `enabled=false`、启动中失败（20s 内 control 始终不可达）、进程退出、control 不可达。
  - **MUST NOT** 探测 hub 连通性来驱动灯色（不额外发起壳→中枢请求）。
- **FR-301-021a**：因此灯色**不保证**中枢可用：`hub.url` 填错或令牌无效时灯仍可能为绿。
  该局限 MUST 在文档中显式声明，MUST NOT 用「已连接」等可能误导的文案；
  上游 `sync-daemon` 未在 `/local/status` 暴露 SSE 连接状态（只读参照，不可改），
  「hub 连接级状态」标 ⬜ 待上游支持。
- **FR-301-021b**：状态文案 MUST 为：`running`→「运行中」、`starting`→「启动中…」、
  `disabled`→「未启用」、`stopped`→「已停止（<原因>）」；表单行标签仍为「连接状态」（需求原文）。
- **FR-301-021c**：探活 MUST 与状态解耦——只要子进程存活就持续探活（2.5s）；
  `starting` 超 20s 不可达虽置红，但**不视为终态**，其后 control 可达 MUST 自动回绿；
  超时时 SHOULD 终止该子进程树，避免「假红 + 实际在同步」的假死状态。
- **FR-301-022**：中枢服务分区**挂载期间** SHOULD 以短周期（≤3s）轮询 daemon 状态并刷新界面；
  分区卸载或页面卸载时 MUST 停止轮询，不泄漏定时器。

### 3.6 其它版别（占位）

- **FR-301-023**：pi-desktop-android / pi-desktop-hos / pi-desktop-ark MUST 在各自
  `specs/301-sync-daemon/` 记录「本轮暂不实现」决策；MUST NOT 产生任何代码改动。

## 4. 关键实体

| 实体 | 说明 |
|---|---|
| `SyncDaemonSettings`（壳私有视图） | `{ enabled: boolean; hubUrl: string; hostName: string; hubToken: string }` — 表单四字段 |
| `~/.pi-desktop/sync-daemon.json` | 落盘形态 = SyncDaemonConfig + `enabled`；`agents["pi-web"].options` 由壳维护 |
| daemon 子进程 | `electron.exe --(RUN_AS_NODE) dist/main.js run --config <path>`；插件再经其拉一层 node 子进程 |
| control 凭据 | `~/.pi-desktop/sync-daemon/daemon-control.json`（daemon 自写，0600）`{port, token}` |
| 状态 | `disabled` / `starting` / `running`(绿) / `stopped`(红，含失败原因) |
| 设置分区 | pi-web `SettingsPanel` 的 `sync` 分区（补丁新增 `components/SyncConfig.tsx`）；桥 `window.piDesktopSync` 仅 `get` / `apply` |

## 5. 验收场景

### 场景 S1：设置入口（pi-web）
Given 应用已启动就绪 → When 打开 pi-web 侧栏「设置」 → Then 分区列表最后一项为「中枢服务」；
切到该分区可见状态灯与四字段；托盘右键菜单不再出现「会话目录」与「设置」。

### 场景 S2：配置回填与保存
Given 已有 `~/.pi-desktop/sync-daemon.json`（enabled=true，有地址/名称/令牌） → When 打开设置 ›「中枢服务」
→ Then 四字段回填、状态灯显示当前真实状态；改动后点「应用」 → Then 文件原子更新（结构兼容 SyncDaemonConfig）、
daemon 按新配置重启、状态灯随实际状态更新。

### 场景 S3：启用同步（端到端，Docker hub）
Given 本机 Docker 起 hub（`docker compose -f pi-agent-hub/deploy/docker-compose.yml up -d`，入口 127.0.0.1:12380），
配置填 `http://127.0.0.1:12380` + 分配的 daemon token、enabled=true、本端名称任意 → When 应用/启动
→ Then daemon 子进程存活、状态灯绿、`~/.pi` 已有会话在 hub console（`/hub/`）可见（本机会话数据上行成功）。

### 场景 S4：禁用
Given daemon 运行中 → When 关闭「是否启用」点「应用」 → Then 子进程（含插件子进程）退出、状态灯红。

### 场景 S5：坏配置不阻塞
Given 地址填错或令牌无效、enabled=true → When 启动/应用 → Then 主窗口功能正常，状态灯红，
日志含失败原因；不出现弹窗死循环/崩溃。

### 场景 S6：退出清理
Given daemon 运行中 → When 退出应用 → Then 无残留 `pi-agent-hub-sync-daemon` 相关 node 子进程。

## 6. 非功能需求

- 安全：令牌仅落盘于 0600 文件；日志 MUST NOT 回显令牌/密码全文；设置分区沿用 pi-web 页面安全模型
  （无 nodeIntegration），壳能力只经 `piDesktopSync`（`get`/`apply`）并做 `senderFrame` 校验。
- 安全（取舍，plan §3.3 D9）：`~/.pi-desktop/sync-daemon.json` 的**明文令牌**属**有意接受**的取舍——
  上游 daemon 的 `loadConfig` 只认明文 `hub.token`，加密必然要再落一份明文，收益为零；
  Windows 上 `chmod 0o600` 实为 no-op，实际保护来自用户目录 NTFS ACL。加密存储（safeStorage /
  系统凭据）**不在本轮范围**。
- 稳健：daemon 崩溃可经再次「应用」恢复；`~/.pi-desktop/sync-daemon.json` 损坏（非 JSON）时
  按「配置缺失」处理（不启动 + 日志告警），MUST NOT 抛到主流程。
- 性能：daemon 探活开销可忽（≤1 次/2.5s，读 control 文件 + 本机 HTTP）；
  状态刷新 ≤1 次/2.5s，**仅中枢服务分区挂载期间**。
- 兼容性：dev（`npm start`）与打包态行为一致（RunAsNode fuse）。

## 7. 假设与约束

- 假设 npm registry 可达（构建期安装两个 npm 包；运行期不 npm install，`pluginInstall=false`）。
- 约束：`sync-plugin-pi-web` 的 collect 读磁盘 `<agentDir>/sessions`（与 pi-web 同源 jsonl），
  故 agentDir 必须与内嵌 pi-web 运行时一致；`server` 必须为内嵌 pi-web 实际监听地址（127.0.0.1:动态端口）。
- 约束：pi-web 密码每启动随机生成（`PI_WEB_PASSWORD` 可固定）→ 每次（重）启动 daemon 前
  由壳刷新 options.password 写入配置文件。
- 假设：本机已有 `~/.pi` 会话数据用于采集验证；测试 hub 用 Docker Desktop（见 deploy/README.md）。
- 约束（plan §3.3 D10）：**hub 侧 host 身份由 `daemonTokens[].hostName` 决定，不由 `host.name` 决定**。
  故跨机复用同一 token 会把本端写进别的 host 身份（覆盖其 agent 行）。测试 MUST 使用专属 token
  （本轮：`win-pi-desktop` / `phk_win_pi_desktop_301`）；`host.name` 仅参与 `agentId` 计算。
- 假设：ELECTRON_RUN_AS_NODE=1 下 Electron 二进制等价 Node（ESM 可用；Electron 43 内置 Node ≥22.19）。

## 8. 依赖

- 上游 npm 包：`@pi-agent-hub/sync-daemon@0.1.0`、`@pi-agent-hub/sync-plugin-pi-web@0.1.0`
  （其传递依赖 protocol / pi-session / sync-plugin-sdk 一并由 npm 安装）。
- 本工程模块：`108-tray`（菜单）、`103-window`/`104-preload`（窗口/桥模式与来源校验）、
  `111-app-entry`（boot 编排插入点）、`112-runtime-config`（配置读写风格）、
  `012-building-workflow`（构建期补丁的幂等应用/回退与往返校验）。
- 测试环境：`pi-agent-hub/deploy/`（Docker Compose：hub-service + hub-console + nginx，对外 12380）。
