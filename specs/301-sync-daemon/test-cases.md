# 301-sync-daemon 测试用例

> 环境：Windows 11 + Node ≥22.19 + Docker Desktop（hub：`docker compose -f pi-agent-hub/deploy/docker-compose.yml up -d`，入口 `http://127.0.0.1:12380`）。
> 应用启动：`npm start`（dev 态）。`~/.pi` 已有会话数据。
> daemon token：取 `pi-agent-hub/deploy/data/hub-service.json` 中 `daemonTokens` 分配值。

## A. 托盘菜单（FR-301-001~003）

| # | 前置 | 步骤 | 期望 |
|---|---|---|---|
| TC-01 | 应用就绪 | 托盘右键 | 菜单**无**「会话目录」；**有**「设置」（位置：检查更新之后、分隔线之前） |
| TC-02 | 同上 | 点「设置」→ 再点一次「设置」 | 第一次开窗；第二次仅聚焦，无第二个窗口 |
| TC-03 | 同上 | 渲染层调用 `window.piDesktop.openSessionDir()` | 仍可用（会话目录被文件管理器打开）——IPC 保留 |

## B. 设置窗口与表单（FR-301-004~007）

| # | 前置 | 步骤 | 期望 |
|---|---|---|---|
| TC-04 | 无配置文件 | 打开设置窗口 | 「中枢服务」tab 可见；多 tabs 骨架可点击切换（其它 tab 仅占位）；状态灯红 |
| TC-05 | 已有配置（TC-06 产出后回跑） | 打开设置窗口 | 地址/本端名称/令牌/switch 全部回填，与文件一致 |
| TC-06 | 窗口打开 | 填 `http://127.0.0.1:12380`、名称 `win-pi-desktop`、令牌 `<token>`，开启 switch，点「应用」 | 提示成功；`~/.pi-desktop/sync-daemon.json` 生成且结构含 `hub/host/plugins/pluginRoot/pluginInstall=false/agents["pi-web"].options{server,agentDir,password}`、`enabled=true`；文件权限 0600（icacls 抽查） |
| TC-07 | 窗口打开 | 空地址/空名称/空令牌 + enabled=true，点「应用」 | 拒绝：可读错误提示，文件不被改写，daemon 不（重）启动 |
| TC-08 | 令牌框有值 | 切换密码显示开关 | 明文/密文切换正常 |

## C. daemon 生命周期（FR-301-013~019）

| # | 前置 | 步骤 | 期望 |
|---|---|---|---|
| TC-09 | 配置 enabled=true（TC-06） | 重启应用 | pi-web 就绪后 daemon 自动启动；`ps`/任务管理器可见 `... pi-agent-hub... dist/main.js run --config C:\Users\fello\.pi-desktop\sync-daemon.json` 子进程；状态灯绿 |
| TC-10 | TC-09 运行中 | 读 `~/.pi-desktop/sync-daemon/daemon-control.json` → curl `GET /local/status`（Bearer token） | 返回 JSON 含 host + plugins（`kind:"pi-web"`） |
| TC-11 | daemon 运行中 | 设置窗口点「应用」（不改值） | 旧子进程退出、新子进程拉起（PID 变化）；状态先红/后绿 |
| TC-12 | daemon 运行中 | switch 关闭 → 应用 | 子进程与插件子进程全部退出（`tasklist` 无残留）；状态灯红 |
| TC-13 | 地址填 `http://127.0.0.1:1`（不通）+ enabled | 应用 | 主窗口正常；状态灯红；日志有失败原因（无回显令牌） |
| TC-14 | daemon 运行中 | 退出应用 | 无残留 sync-daemon/插件子进程（S6） |

## D. 端到端同步（场景 S3）

| # | 前置 | 步骤 | 期望 |
|---|---|---|---|
| TC-15 | Docker hub 健康（`/api` 可达）；`~/.pi/agent/sessions` 有历史会话 | TC-09 状态绿后等待 ≤1 个同步周期（30s） | hub console `http://127.0.0.1:12380/hub/` 登录后可见本 host 与会话列表（含 `~/.pi` 既有会话） |
| TC-16 | 同上 | 在 pi-desktop 新建会话并发一条消息，等一个同步周期 | 新会话/消息出现在 hub console 会话正文 |
| TC-17 | 复位环境后（`down` + 清库 + `up`） | 重跑 TC-09/TC-15 | 全链路可复现（复测流程） |

## E. 稳健性

| # | 前置 | 步骤 | 期望 |
|---|---|---|---|
| TC-18 | 配置文件写入坏 JSON | 启动应用 | 不启动 daemon；日志 WARN；主功能正常；状态灯红；「应用」可恢复 |
| TC-19 | 手工 kill daemon 子进程 | 等待 ≤3s 后再「应用」 | 状态变红→可重新拉起变绿；无孤儿进程 |
| TC-20 | 打包态（`npm run make` 产物） | 启动安装包，TC-06/TC-09/TC-12 | 与 dev 态一致（RunAsNode fuse 生效验证）——**本轮若时间不允许做 make，标记 ⬜ 待验证并在报告注明** |

## 判定

- 全绿（A/B/C/D 全过）→ 通过；E-TC20 可 ⬜ 放行但必须注明。
- TC-13/18 属负向用例：期望行为即"红 + 不阻塞"。
