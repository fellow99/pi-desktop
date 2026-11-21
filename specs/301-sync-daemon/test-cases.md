# 301-sync-daemon 测试用例

> 环境：Windows 11 + Node ≥22.19 + Docker Desktop（hub：`docker compose -f pi-agent-hub/deploy/docker-compose.yml up -d`，入口 `http://127.0.0.1:12380`）。
> 应用启动：`npm start`（dev 态）；`~/.pi` 已有会话数据。
> daemon token：取 `pi-agent-hub/deploy/data/hub-service.json` 的 `daemonTokens` 分配值。
> 设置入口：**pi-web 设置对话框**（侧栏「设置」），最后一个分区为「中枢服务」；托盘不再提供「设置」项。

## A. 托盘菜单（FR-301-001~003）

| # | 前置 | 步骤 | 期望 |
|---|---|---|---|
| TC-01 | 应用就绪 | 托盘右键 | 菜单只有：`Pi Desktop`（禁用标题）、显示主窗口、打开日志、检查更新…、退出。**无「会话目录」，也无「设置」** |
| TC-02 | 同上 | 手动点击「打开日志」/「显示主窗口」 | 行为与旧版一致（日志目录 / 主窗口可见）；菜单项顺序与文案不漂移 |
| TC-03 | 同上 | 渲染层调用 `window.piDesktop.openSessionDir()` | 仍可用（会话目录被文件管理器打开）——IPC 保留 |

## B. 中枢服务设置分区（FR-301-004~007、022）

| # | 前置 | 步骤 | 期望 |
|---|---|---|---|
| TC-04 | 无配置文件 | 打开 pi-web 设置 | 分区顺序为 `常规 / 模型 / 技能 / Agents / 插件 / MCP / 中枢服务`；「中枢服务」在最后；进入后状态灯红、文案「未启用」；四字段为空/默认本端名称 |
| TC-05 | 已有配置（TC-06 产出后回跑） | 打开设置 ›「中枢服务」 | 地址 / 本端名称 / 令牌 / switch 全部回填，与 `~/.pi-desktop/sync-daemon.json` 一致；状态灯显示真实状态 |
| TC-06 | 分区打开 | 填 `http://127.0.0.1:12380`、名称 `win-pi-desktop`、令牌 `<token>`，打开 switch，点「应用」 | 提示成功；`~/.pi-desktop/sync-daemon.json` 生成且结构含 `hub/host/plugins/pluginRoot/pluginInstall=false/agents["pi-web"].options{server,agentDir,password}`、`enabled=true`；文件权限 0600（icacls 抽查） |
| TC-07 | 分区打开 | 空地址 / 空名称 / 空令牌 + enabled=true，点「应用」 | 拒绝：可读错误提示（与旧原生窗口同文案），文件不被改写，daemon 不（重）启动 |
| TC-08 | 令牌框有值 | 点令牌框旁「显示 / 隐藏」 | 明文/密文切换正常；切换不改变值 |
| TC-08a | 分区打开 | 切到其它分区再切回 | 表单值与状态保持；≤2.5s 内状态灯自动刷新（不泄漏定时器；关闭设置后日志无持续请求） |
| TC-08b | 系统语言切到 en / zh-TW（设置 › 常规） | 重开「中枢服务」 | 分区名与字段标签随语言切换（Hub service / 中樞服務） |

## C. daemon 生命周期（FR-301-013~019）

| # | 前置 | 步骤 | 期望 |
|---|---|---|---|
| TC-09 | 配置 enabled=true（TC-06 产物） | 重启应用 | pi-web 就绪后 daemon 自动启动；任务管理器可见 `... sync-daemon... dist/main.js run --config C:\Users\fello\.pi-desktop\sync-daemon.json` 子进程；状态灯绿 |
| TC-10 | TC-09 运行中 | 读 `~/.pi-desktop/sync-daemon/daemon-control.json`，curl `GET /local/status`（Bearer token） | 返回 JSON 含 host + plugins（`kind:"pi-web"`） |
| TC-11 | daemon 运行中 | 设置 ›「中枢服务」点「应用」（不改值） | 旧子进程退出、新子进程拉起（PID 变化）；状态先「启动中…」后「运行中」 |
| TC-12 | daemon 运行中 | switch 关闭 → 「应用」 | 子进程与插件子进程全部退出（`tasklist` 无残留）；状态灯红 |
| TC-13 | 地址填 `http://127.0.0.1:1`（不通）+ enabled | 「应用」 | 主窗口正常；状态灯红；日志有失败原因（无回显令牌） |
| TC-14 | daemon 运行中 | 退出应用 | 无残留 sync-daemon / 插件子进程（S6） |

## D. 端到端同步（场景 S3）

| # | 前置 | 步骤 | 期望 |
|---|---|---|---|
| TC-15 | Docker hub 健康（`/api` 可达）；`~/.pi/agent/sessions` 有历史会话 | TC-09 状态绿后等待 ≥1 个同步周期（30s） | hub console（`http://127.0.0.1:12380/hub/`）登录后可见本 host 与会话列表（含 `~/.pi` 既有会话） |
| TC-16 | 同上 | 在 pi-desktop 新建会话并发一条消息，等一个同步周期 | 新会话/消息出现在 hub console 会话正文 |
| TC-17 | 复位环境后（`down` + 清库 + `up`） | 重跑 TC-09 / TC-15 | 全链路可复现（复测流程） |

## E. 稳健性、补丁与桥

| # | 前置 | 步骤 | 期望 |
|---|---|---|---|
| TC-18 | 配置文件被写成坏 JSON | 启动应用 | 不启动 daemon；日志 WARN；主功能正常；状态灯红；「应用」可恢复 |
| TC-19 | 手工 kill daemon 子进程 | 等待 ≤5s 后再「应用」 | 状态变红→可重新拉起变绿；无孤儿进程 |
| TC-20 | 打包态（`npm run make` 产物） | 启动安装包/目录态产物，TC-06 / TC-09 / TC-12 | 与 dev 态一致（RunAsNode fuse 生效；pi-web 设置里有「中枢服务」分区） |
| TC-21 | 干净 `../pi-web`（`git status --porcelain` 为空） | `node scripts/patches.mjs status` → 跑一次 `prepare-next`（或 `npm run package`） | 补丁状态先 `clean`，构建期应用→反向→SHA-256 往返校验通过；构建完成后 `../pi-web` 再次为 clean，`patches` 无残留 |
| TC-22 | 应用运行中 | 在非应用源页面（`about:blank` 或 `http://localhost:<其它端口>` 的测试页）调用 `window.piDesktopSync?.get()` | 不存在或调用被拒；主进程日志出现 WARN「已拒绝来源不明的 IPC 调用」，不返回配置 |
| TC-23 | 补丁版 pi-web 被单独用浏览器打开（无 preload） | 打开设置 | 分区列表**不出现**「中枢服务」；其余分区正常 |

## 判定

- 全绿（A/B/C/D 全过）→ 通过；E 中 TC-20 可放行但必须注明；TC-21/22/23 属本轮新增回归项，必须过。
- TC-13/18 属负向用例：期望行为是「红 + 不阻塞」。
