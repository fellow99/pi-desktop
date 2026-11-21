/**
 * 中枢服务同步（module 301-sync-daemon）—— sync-daemon 子进程守护。
 *
 * 形态（specs/301-sync-daemon plan §3.1）：
 *   - daemon 以**子进程**运行：`spawn(process.execPath, [daemonBin, 'run', '--config', <path>],
 *     { env: {...process.env, ELECTRON_RUN_AS_NODE:'1'}, stdio:['ignore','pipe','pipe'], windowsHide:true })`。
 *     主进程内**不** import 运行 Daemon 类（插件 RpcClient 依赖 node 身份，见 D1）。
 *   - 配置：`~/.pi-desktop/sync-daemon.json` = SyncDaemonConfig + 顶层 `enabled`（壳私有字段）；
 *     原子写（临时文件 + rename）、0o600；损坏按「配置缺失」处理（WARN + 不启动）。
 *   - 状态：`disabled / starting / running / stopped`。`running`（绿）判定 = 子进程存活
 *     且 control API 可达：`~/.pi-desktop/sync-daemon/daemon-control.json` → `{port,token}`
 *     → `GET http://127.0.0.1:<port>/local/status`（Bearer）。
 *   - 停止：先 `POST /local/quit`（优雅），超时后杀进程树（win: taskkill /T /F，unix: SIGKILL）。
 *   - 纪律：日志不回显令牌/密码；daemon 失败只记日志 + 置红，绝不阻塞主流程（FR-301-016）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { describeError, logInfo, logWarn } from './logger';

// ---------------------------------------------------------------------------
// 路径与常量
// ---------------------------------------------------------------------------

/** 壳私有配置根（与本机独立 daemon 的 `~/.pi-agent-hub` 完全隔离，见 plan D6）。 */
const CONFIG_ROOT = join(homedir(), '.pi-desktop');
const CONFIG_PATH = join(CONFIG_ROOT, 'sync-daemon.json');
/** daemon 的 pluginRoot：control 文件 / 日志 / 插件工作区都在这里。 */
const PLUGIN_ROOT = join(CONFIG_ROOT, 'sync-daemon');
const CONTROL_FILE = join(PLUGIN_ROOT, 'daemon-control.json');

/** 状态轮询周期（FR-301-022：≤3s，取 2.5s）。 */
const POLL_INTERVAL_MS = 2_500;
/** starting 宽限上限（拉起后 20s 内 control 不可达不算失败，超过按失败处理并终止子进程）。 */
const STARTING_DEADLINE_MS = 20_000;
/** control 探活（GET /local/status）超时。 */
const STATUS_TIMEOUT_MS = 2_000;
/**
 * 优雅停止窗口。上游 `Daemon.stop()` 只 abort SSE + 关 control + 停插件，**不清理** 30s 的
 * `setInterval`（`pi-agent-hub/packages/sync-daemon/src/daemon.ts:114`，既无 `unref` 也无
 * `process.exit`），因此**不能假设**它会自行退出——实测本机 `/local/quit` 后约 1.8s 退出
 * （code=1），但该行为依赖上游未来改动。故窗口取 1.5s，超时**必须**强制终止进程树
 * （FR-301-018）。见评审 Important-5 / plan D17。
 */
const STOP_DEADLINE_MS = 1_500;
/** 单行日志转发截断。 */
const LOG_LINE_MAX = 300;

/** 壳固化的插件清单（FR-301-010：不暴露给用户编辑）。 */
const FIXED_PLUGINS = ['@pi-agent-hub/sync-plugin-pi-web'];
const FIXED_PLUGIN_ALLOWLIST = ['@pi-agent-hub/*'];

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 表单四字段（壳私有视图；其余字段由壳固化）。 */
export type SyncDaemonSettings = {
  enabled: boolean;
  hubUrl: string;
  hostName: string;
  hubToken: string;
};

/** 运行时注入的插件 options（pi-web 实际地址 / agentDir / 密码）。 */
export type SyncRuntimeOptions = {
  server: string;
  agentDir: string;
  password: string;
};

export type SyncStatus =
  | { state: 'disabled' }
  | { state: 'starting' }
  | { state: 'running' }
  | { state: 'stopped'; reason?: string };

/** 落盘形态 = SyncDaemonConfig + 顶层 `enabled`。 */
type SyncDaemonFile = {
  enabled: boolean;
  hub: { url: string; token: string };
  host: { name: string };
  plugins: string[];
  pluginRoot: string;
  pluginInstall: false;
  pluginAllowlist: string[];
  agents: {
    'pi-web': {
      instances: Array<{ name: string }>;
      options: { server: string; agentDir: string; password: string };
    };
  };
};

type ControlCreds = { port: number; token: string };

type LoadResult = { enabled: boolean; settings: SyncDaemonSettings } | null;

// ---------------------------------------------------------------------------
// 模块状态
// ---------------------------------------------------------------------------

let child: ChildProcess | null = null;
/** 子进程是否被我们预期存活（false = 已主动停止，退出不再记 WARN/不再置 stopped）。 */
let expectAlive = false;
let status: SyncStatus = { state: 'disabled' };
let pollTimer: NodeJS.Timeout | null = null;
const statusListeners = new Set<(s: SyncStatus) => void>();

/**
 * start/stop 串行队列 + 退出闸门（评审 Important-3）：
 * start 内部有多个 `await` 让出点，并发调用会各自通过 `childAlive()` 检查而各自 spawn，
 * 后一个覆盖 `child` 引用 → 前一个子进程成孤儿、control 文件被两代共用。
 * 所有导出入口（start/stop/apply）排队执行，互相不重入。
 */
let inflight: Promise<unknown> = Promise.resolve();
/** 退出链已开始：此后一律不再 spawn（否则「点应用后立刻退出」会放出 detached 孤儿）。 */
let shuttingDown = false;

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = inflight.then(task, task);
  // 队列自身不能因单个任务失败而断裂。
  inflight = run.catch(() => undefined);
  return run;
}

/** 退出链入口调用：置闸门，后续 start 一律拒绝。 */
export function markSyncDaemonShuttingDown(): void {
  shuttingDown = true;
}

function setStatus(next: SyncStatus): void {
  const changed = JSON.stringify(next) !== JSON.stringify(status);
  status = next;
  if (!changed) return;
  logInfo(`[sync-daemon] 状态 → ${next.state}${'reason' in next && next.reason ? `（${next.reason}）` : ''}`);
  for (const listener of statusListeners) {
    try {
      listener(next);
    } catch (err) {
      logWarn(`[sync-daemon] 状态监听器异常：${describeError(err)}`);
    }
  }
}

function childAlive(): boolean {
  return child !== null && !child.killed;
}

// ---------------------------------------------------------------------------
// 配置读写
// ---------------------------------------------------------------------------

/**
 * daemon CLI 入口（bin = dist/main.js）。
 * 包 exports 只暴露 "."（→ dist/daemon.js）且仅含 `import` 条件——CJS 的 require.resolve
 * 会因 exports 无 require/default 条件而抛 ERR_PACKAGE_PATH_NOT_EXPORTED（已本机验证）。
 * 因此：1) 优先尝试 resolve（若将来包补齐 require 条件即走此路）；
 *        2) 回退：自 __dirname 逐级向上找 node_modules/@pi-agent-hub/sync-daemon/dist/main.js
 *        （dev 态在 pi-desktop/node_modules；打包态在 app.asar 内 node_modules，
 *          Electron 的 fs 补丁对 asar 透明，node 身份下同样可读）。找不到抛错，由调用方 fail-soft。
 */
function resolveDaemonBin(): string {
  const candidates: string[] = [];
  try {
    const entry = createRequire(__filename).resolve('@pi-agent-hub/sync-daemon');
    candidates.push(join(dirname(entry), 'main.js'));
  } catch (err) {
    // 设计如此（包 exports 只暴露 import 条件）；降为 info，避免每次启动都像故障（评审 Minor-15）。
    logInfo(`[sync-daemon] 包入口 require.resolve 不可用，改用 node_modules 目录探测：${describeError(err).split('\n')[0]}`);
  }
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    candidates.push(join(dir, 'node_modules', '@pi-agent-hub', 'sync-daemon', 'dist', 'main.js'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('未找到 daemon CLI（node_modules/@pi-agent-hub/sync-daemon/dist/main.js）');
}

/** 把 `~` 展开为 HOME（daemon 侧 expandHome 兼容，但我们直接落绝对路径）。 */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

function validateSettings(settings: SyncDaemonSettings): string | null {
  if (!settings.enabled) return null; // 禁用态允许保存半成品（FR-301-011）
  const hubUrl = settings.hubUrl.trim();
  if (!hubUrl) return '中枢服务地址不能为空';
  try {
    const parsed = new URL(hubUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '中枢服务地址必须是 http(s) URL';
    }
  } catch {
    return '中枢服务地址不是合法 URL';
  }
  if (settings.hostName.trim().length === 0) return '本端名称不能为空';
  if (settings.hubToken.trim().length === 0) return '本端令牌不能为空';
  return null;
}

function toFile(settings: SyncDaemonSettings, opts: SyncRuntimeOptions): SyncDaemonFile {
  return {
    enabled: settings.enabled,
    hub: { url: settings.hubUrl.trim(), token: settings.hubToken.trim() },
    host: { name: settings.hostName.trim() },
    plugins: [...FIXED_PLUGINS],
    pluginRoot: expandHome(PLUGIN_ROOT),
    pluginInstall: false,
    pluginAllowlist: [...FIXED_PLUGIN_ALLOWLIST],
    agents: {
      'pi-web': {
        instances: [{ name: 'default' }],
        options: { server: opts.server, agentDir: expandHome(opts.agentDir), password: opts.password },
      },
    },
  };
}

function parseFile(text: string): LoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logWarn(`[sync-daemon] 配置文件损坏，按缺失处理：${CONFIG_PATH}（${describeError(err).split('\n')[0]}）`);
    return null;
  }
  const raw = parsed as Partial<SyncDaemonFile>;
  const hub = raw.hub;
  const host = raw.host;
  if (!hub || typeof hub.url !== 'string' || typeof hub.token !== 'string') {
    logWarn('[sync-daemon] 配置文件缺少 hub.url/hub.token，按缺失处理');
    return null;
  }
  if (!host || typeof host.name !== 'string') {
    logWarn('[sync-daemon] 配置文件缺少 host.name，按缺失处理');
    return null;
  }
  return {
    enabled: raw.enabled === true,
    settings: { enabled: raw.enabled === true, hubUrl: hub.url, hostName: host.name, hubToken: hub.token },
  };
}

/** 读配置；不存在 / 损坏 / 缺必填 → null（调用方按「配置缺失」处理，不抛错）。 */
export async function loadSyncConfig(): Promise<LoadResult> {
  let text: string;
  try {
    text = await readFile(CONFIG_PATH, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT' && code !== 'EACCES') {
      logWarn(`[sync-daemon] 读取配置失败，按缺失处理：${describeError(err).split('\n')[0]}`);
    }
    return null;
  }
  return parseFile(text);
}

/** 原子写配置（临时文件 + rename，0o600）。校验失败抛 Error（可读消息，供设置分区展示）。 */
export async function saveSyncConfig(settings: SyncDaemonSettings, opts: SyncRuntimeOptions): Promise<void> {
  const problem = validateSettings(settings);
  if (problem) throw new Error(problem);

  const file = toFile(settings, opts);
  await mkdir(CONFIG_ROOT, { recursive: true });
  const tmpPath = join(CONFIG_ROOT, `sync-daemon.json.tmp-${process.pid}-${Date.now()}`);
  try {
    await writeFile(tmpPath, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      await chmod(tmpPath, 0o600);
    } catch (err) {
      // Windows 上 chmod 对 NTFS ACL 无效属正常；其它平台必须留痕（评审 Important-6）。
      if (process.platform !== 'win32') {
        logWarn(`[sync-daemon] 配置文件 chmod 0600 失败：${describeError(err).split('\n')[0]}`);
      }
    }
    await rename(tmpPath, CONFIG_PATH);
    logInfo(`[sync-daemon] 配置已写入：${CONFIG_PATH}（enabled=${file.enabled}，hub=${file.hub.url}，host=${file.host.name}，token 不回显）`);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw new Error(`写入配置文件失败：${describeError(err).split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------------------
// control API
// ---------------------------------------------------------------------------

function controlRequest(creds: ControlCreds, method: 'GET' | 'POST', path: string, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: creds.port, method, path, headers: { Authorization: `Bearer ${creds.token}` }, timeout: timeoutMs },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('timeout', () => req.destroy(new Error('control 请求超时')));
    req.on('error', reject);
    req.end();
  });
}

async function readControlCreds(): Promise<ControlCreds | null> {
  let raw: string;
  try {
    raw = await readFile(CONTROL_FILE, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // 尚未写出来（daemon 刚拉起）属正常；其它错误必须留痕（评审 Important-6）。
    if (code !== 'ENOENT') {
      logWarn(`[sync-daemon] 读取 control 凭据失败：${describeError(err).split('\n')[0]}`);
    }
    return null;
  }
  let parsed: Partial<ControlCreds>;
  try {
    parsed = JSON.parse(raw) as Partial<ControlCreds>;
  } catch (err) {
    logWarn(`[sync-daemon] control 凭据文件损坏：${describeError(err).split('\n')[0]}`);
    return null;
  }
  if (typeof parsed.port === 'number' && typeof parsed.token === 'string' && parsed.token.length > 0) {
    return { port: parsed.port, token: parsed.token };
  }
  logWarn('[sync-daemon] control 凭据缺 port/token 字段');
  return null;
}

/** control 是否可达（绿灯判据之一）：GET /local/status，2s 超时。 */
async function controlReachable(): Promise<boolean> {
  if (!childAlive()) return false;
  const creds = await readControlCreds();
  if (!creds) return false;
  try {
    const code = await controlRequest(creds, 'GET', '/local/status', STATUS_TIMEOUT_MS);
    if (code === 200) return true;
    logWarn(`[sync-daemon] control 探活返回 HTTP ${code}（token 过期或非本进程代际）`);
    return false;
  } catch (err) {
    logWarn(`[sync-daemon] control 探活失败：${describeError(err).split('\n')[0]}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 状态轮询
// ---------------------------------------------------------------------------

let startedAt = 0;

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling(): void {
  stopPolling();
  pollTimer = setInterval(() => {
    void (async () => {
      if (!childAlive()) return; // 退出事件已处理
      const reachable = await controlReachable();

      // 可达即回绿（含 starting → running、stopped → running 自愈）：
      // 上游 control server 在插件握手之后才监听，20s 预算在打包态冷启动时并不宽裕；
      // 超时置红后仍继续探活，避免「假红 + 实际在同步」（评审 Important-4）。
      if (reachable) {
        if (status.state !== 'running') setStatus({ state: 'running' });
        return;
      }

      if (status.state === 'running') {
        setStatus({ state: 'stopped', reason: 'control API 不可达' });
        return;
      }

      if (status.state === 'starting' && Date.now() - startedAt > STARTING_DEADLINE_MS) {
        // 超时且不可达：认定为起不来，终止子进程树，不把它留成假死状态。
        logWarn(`[sync-daemon] 启动超时（${STARTING_DEADLINE_MS} ms 内 control API 始终不可达），强制终止子进程`);
        const proc = child;
        expectAlive = false;
        setStatus({ state: 'stopped', reason: '启动超时（control API 始终不可达）' });
        if (proc) killTree(proc);
      }
    })().catch((err) => logWarn(`[sync-daemon] 状态轮询异常：${describeError(err)}`));
  }, POLL_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// 子进程生命周期
// ---------------------------------------------------------------------------

/** 日志转发：截断长行；含 token/password 形态的行脱敏（FR 非功能：不回显密钥）。 */
function sanitize(line: string): string {
  let out = line
    .replace(/\r/g, '')
    .replace(/("[^"]*(?:token|password|authorization|secret)[^"]*"\s*:\s*)("[^"]*")/gi, '$1"***"')
    .replace(/(Bearer\s+)\S+/gi, '$1***');
  if (out.length > LOG_LINE_MAX) out = `${out.slice(0, LOG_LINE_MAX)}…（截断）`;
  return out;
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  if (proc.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function killTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', (err) => {
        logWarn(`[sync-daemon] taskkill 拉起失败（进程可能已退出）：${describeError(err).split('\n')[0]}`);
      });
    } else {
      // POSIX：daemon 以独立进程组运行（spawn detached，见 startSyncDaemon），
      // 杀进程组才能连其插件子进程一起终止（FR-301-018）；失败退化为杀直接子进程。
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* 进程可能已退出 */
        }
      }
    }
  } catch {
    /* 进程可能已退出 */
  }
}

/**
 * 停止 daemon（幂等）。先 `POST /local/quit` 优雅退出，超时后杀进程树。
 * 停完后状态：配置 enabled=true → `stopped`，否则 `disabled`。
 */
async function stopSyncDaemonInner(): Promise<void> {
  stopPolling();
  expectAlive = false;

  if (!child) {
    // 无存活子进程（已停/未拉起）：保留已有停止原因，仅在当前状态不是终态时更新。
    if (status.state === 'running' || status.state === 'starting') {
      const loaded = await loadSyncConfig();
      setStatus(loaded?.enabled ? { state: 'stopped', reason: '已停用' } : { state: 'disabled' });
    }
    return;
  }
  const proc = child;
  child = null;

  const creds = await readControlCreds();
  if (creds) {
    try {
      await controlRequest(creds, 'POST', '/local/quit', 3_000);
      logInfo('[sync-daemon] 已请求 daemon 优雅退出（/local/quit）');
    } catch (err) {
      logWarn(`[sync-daemon] /local/quit 失败（将直接终止）：${describeError(err).split('\n')[0]}`);
    }
  }

  await waitForExit(proc, STOP_DEADLINE_MS);
  if (proc.exitCode === null && proc.signalCode === null) {
    logWarn(`[sync-daemon] 优雅停止未在 ${STOP_DEADLINE_MS} ms 内退出，强制终止进程树（pid=${proc.pid ?? 'unknown'}）`);
    killTree(proc);
    await waitForExit(proc, 3_000);
  }
  logInfo(`[sync-daemon] daemon 已停止（code=${proc.exitCode ?? 'null'} signal=${proc.signalCode ?? 'null'}）`);

  const loaded = await loadSyncConfig();
  setStatus(loaded?.enabled ? { state: 'stopped', reason: '已停用' } : { state: 'disabled' });
}

/** 停止 daemon（幂等、串行）：退出链 / 中枢服务设置分区 / 应用链路统一入口。 */
export function stopSyncDaemon(): Promise<void> {
  return serialize(() => stopSyncDaemonInner());
}

/**
 * 拉起 daemon 子进程（前提：配置已写好且 enabled=true）。
 * 失败不抛出：只记日志 + 置 `stopped`（FR-301-016）。
 */
async function startSyncDaemonInner(opts: SyncRuntimeOptions): Promise<void> {
  if (shuttingDown) {
    logWarn('[sync-daemon] 应用正在退出，拒绝启动 daemon');
    return;
  }
  if (childAlive()) {
    logWarn('[sync-daemon] 已有 daemon 在运行，先停止');
    await stopSyncDaemonInner();
  }

  const loaded = await loadSyncConfig();
  if (!loaded || !loaded.enabled) {
    const reason = loaded ? '配置 enabled=false' : '配置缺失/损坏';
    logWarn(`[sync-daemon] 未启动：${reason}`);
    setStatus({ state: 'stopped', reason });
    return;
  }

  // pi-web 密码每启动随机：每次拉起前刷新运行时 options 落盘（plan §7 风险表）。
  try {
    await saveSyncConfig(loaded.settings, opts);
  } catch (err) {
    logWarn(`[sync-daemon] 刷新运行时 options 失败，放弃启动：${describeError(err).split('\n')[0]}`);
    setStatus({ state: 'stopped', reason: '配置写入失败' });
    return;
  }

  let daemonBin: string;
  try {
    daemonBin = resolveDaemonBin();
  } catch (err) {
    logWarn(`[sync-daemon] 无法解析 daemon CLI，放弃启动：${describeError(err)}`);
    setStatus({ state: 'stopped', reason: 'daemon CLI 缺失' });
    return;
  }

  logInfo(`[sync-daemon] 拉起子进程：${process.execPath} ${daemonBin} run --config ${CONFIG_PATH}`);
  // 清掉上一代的 control 凭据：否则新代际在自写凭据前可能被判为「可达」而误绿（代际校验）。
  await unlink(CONTROL_FILE).catch(() => undefined);
  const proc = spawn(process.execPath, [daemonBin, 'run', '--config', CONFIG_PATH], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // POSIX：daemon 成为独立进程组组长（killTree 用 kill(-pid) 连插件子进程一起杀，FR-301-018）；
    // Windows 不用 detached（避免新控制台窗口），taskkill /T 已覆盖进程树。
    detached: process.platform !== 'win32',
  });
  child = proc;
  expectAlive = true;
  startedAt = Date.now();
  setStatus({ state: 'starting' });

  proc.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim().length > 0) logInfo(`[sync-daemon:out] ${sanitize(line)}`);
    }
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim().length > 0) logWarn(`[sync-daemon:err] ${sanitize(line)}`);
    }
  });
  proc.on('error', (err) => {
    logWarn(`[sync-daemon] 子进程拉起失败：${describeError(err)}`);
    if (child !== proc) return; // 旧代际：不得影响新代际的轮询与状态
    child = null;
    expectAlive = false;
    stopPolling();
    setStatus({ state: 'stopped', reason: `拉起失败：${describeError(err).split('\n')[0]}` });
  });
  proc.on('exit', (code, signal) => {
    const expected = expectAlive;
    if (child !== proc) {
      // 旧代际退出（已被新一代取代）：不得清掉新一代的轮询定时器（评审 Minor-8）。
      logInfo(`[sync-daemon] 旧代际 daemon 退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`);
      return;
    }
    child = null;
    expectAlive = false;
    stopPolling();
    if (expected) {
      logWarn(`[sync-daemon] daemon 意外退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      setStatus({ state: 'stopped', reason: `进程退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）` });
    }
  });

  startPolling();
}

/** 拉起 daemon（串行）。失败不抛出：只记日志 + 置 `stopped`（FR-301-016）。 */
export function startSyncDaemon(opts: SyncRuntimeOptions): Promise<void> {
  return serialize(() => startSyncDaemonInner(opts));
}

// ---------------------------------------------------------------------------
// 对外门面（中枢服务设置分区 IPC / boot 编排）
// ---------------------------------------------------------------------------

/**
 * 「应用」按钮全链路：校验 → 原子写 → 停旧 → 按 enabled（重）启动。
 * 校验失败抛 Error（可读消息）；daemon 启动失败不抛（置红 + 日志）。
 */
export function applySyncConfig(settings: SyncDaemonSettings, opts: SyncRuntimeOptions): Promise<void> {
  return serialize(async () => {
    await saveSyncConfig(settings, opts); // 校验在这里发生
    if (childAlive() || status.state === 'starting') {
      await stopSyncDaemonInner();
    }
    if (settings.enabled) {
      await startSyncDaemonInner(opts);
    } else {
      setStatus({ state: 'disabled' });
    }
  });
}

/** boot 就绪后调用：配置 enabled=true 才启动；缺失/损坏/禁用一律静默跳过（只记日志）。 */
export async function startSyncDaemonIfEnabled(opts: SyncRuntimeOptions): Promise<void> {
  try {
    const loaded = await loadSyncConfig();
    if (!loaded) {
      logInfo('[sync-daemon] 无配置，跳过自动启动（可在「设置 → 中枢服务」中配置）');
      return;
    }
    if (!loaded.enabled) {
      logInfo('[sync-daemon] 配置 enabled=false，跳过自动启动');
      setStatus({ state: 'disabled' });
      return;
    }
    await startSyncDaemon(opts);
  } catch (err) {
    logWarn(`[sync-daemon] 自动启动失败（不阻塞主流程）：${describeError(err)}`);
    setStatus({ state: 'stopped', reason: describeError(err).split('\n')[0] });
  }
}

/** daemon 子进程当前是否存活（退出链 needCleanup 判定用）。 */
export function isSyncDaemonActive(): boolean {
  return childAlive();
}

/** 当前状态（只读快照）。 */
export function getSyncStatus(): SyncStatus {
  return status;
}

/** 状态变更订阅；返回解绑函数。 */
export function onSyncStatusChange(listener: (s: SyncStatus) => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}
