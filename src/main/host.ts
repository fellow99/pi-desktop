import { session as electronSession, type Session } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createNetServer } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  PI_WEB_AUTH_USERNAME,
  PI_WEB_SESSION_COOKIE,
  PI_WEB_SESSION_MAX_AGE_SECONDS,
  PRODUCT_NAME,
  READY_INTERVAL_MS,
  READY_PROBE_PATH,
  READY_TIMEOUT_MS,
} from './constants';
import { describeError, logError, logInfo, logWarn } from './logger';
import { ensureAgentDirTree, materializePresetTemplates, resolveAgentDir, type ShellSettings } from './settings';

/**
 * host.ts — 服务端宿主（module 001-host）。
 *
 * 选定形态（已决策 Q2）：**Electron 主进程进程内**启动 pi-web 的 Next 服务器。
 *   - 入口：`node_modules/next/dist/server/lib/start-server.js` 的 `startServer` 导出
 *     （✅ 本工程已于 pi-web 0.11.1 的 node_modules 中核实；🔶 pi-desktop-hos 真机实测宿主不退出）。
 *   - **禁止**使用 `next/dist/bin/next`：它是命令行程序，会注册信号处理并 `process.exit()`，
 *     在 Electron 主进程里会连带杀掉整个桌面壳。
 *   - 就绪判定：HTTP 轮询（**不**解析 stdout 的 "Ready" —— 那是 CLI 启动器的做法）。
 *
 * 回退（触发条件见 docs/工程规划.md §4.2）：
 *   A′ `next/dist/server/next.js` 的 NextServer 自定义服务器 API（仍为进程内）；
 *   B  `PI_DESKTOP_HOST_MODE=spawn` 显式开启的 sidecar（`ELECTRON_RUN_AS_NODE=1` + `next start`）。
 *   B 不自动启用：让上游内部入口的漂移**看得见**（fail-visible），而不是被静默兜住。
 */

export type HostMode = 'in-process' | 'in-process-next-server-api' | 'spawn';

export type PiWebServer = {
  mode: HostMode;
  hostname: string;
  port: number;
  /** 渲染层加载地址（同源，形如 http://127.0.0.1:<port>/）。 */
  url: string;
  password: string;
  close(): Promise<void>;
};

const requireCjs = createRequire(__filename);

/** 空闲高位端口：`listen(0)` 探测后释放。 */
export function resolveFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('未能取得空闲端口'))));
    });
  });
}

/**
 * 环境装配：必须在**任何 pi 代码被加载之前**完成（宿主启动早期调用一次）。
 * 桌面与鸿蒙版的关键差异：不改 HOME/USERPROFILE/TMPDIR（桌面无沙箱），默认共享 `~/.pi/agent`。
 */
export function assembleEnv(userData: string, settings: ShellSettings): string {
  const agentDir = resolveAgentDir(settings);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_WEB_APP_NAME = PRODUCT_NAME;
  // 上游 /api/app-update 的运行时开关：置位后直接返回 updateAvailable:false。
  // 本工程自己实现「检查更新 → 引导下载」（module 011），不叠加两套升级提示。
  process.env.PI_WEB_SKIP_VERSION_CHECK = '1';

  const bypass = new Set(
    (process.env.NO_PROXY || process.env.no_proxy || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const host of ['127.0.0.1', 'localhost', '::1']) bypass.add(host);
  process.env.NO_PROXY = [...bypass].join(',');
  process.env.no_proxy = process.env.NO_PROXY;

  ensureAgentDirTree(agentDir);
  materializePresetTemplates(agentDir, join(userData, '..', 'config'));

  logInfo(`userData = ${userData}`);
  logInfo(`PI_CODING_AGENT_DIR = ${agentDir}（agentDirMode=${settings.agentDirMode}）`);
  logInfo(`NO_PROXY = ${process.env.NO_PROXY}`);
  logInfo(`PI_WEB_APP_NAME = ${process.env.PI_WEB_APP_NAME}｜PI_WEB_SKIP_VERSION_CHECK = 1`);
  return agentDir;
}

/** 随机强密码；可用环境变量固定（CI/无人值守测试用）。 */
export function resolvePassword(): string {
  const fromEnv = process.env.PI_WEB_PASSWORD;
  if (fromEnv && fromEnv.trim().length > 0) {
    logWarn('检测到环境变量 PI_WEB_PASSWORD：使用它而非随机密码（仅用于受控环境）');
    return fromEnv;
  }
  return randomBytes(24).toString('base64url');
}

/** CJS require，必要时退 ESM 动态 import（Next 的 dist 形态随版本变化，不做假设）。 */
async function loadModule(absPath: string): Promise<Record<string, unknown>> {
  try {
    return requireCjs(absPath) as Record<string, unknown>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ERR_REQUIRE_ESM' || code === 'ERR_REQUIRE_ASYNC_MODULE' || code === 'ERR_REQUIRE_CYCLE_MODULE') {
      return (await import(pathToFileURL(absPath).href)) as Record<string, unknown>;
    }
    throw err;
  }
}

/**
 * 预览密钥轮换：复用上游 `bin/rotate-preview-secrets.js`（**不重新实现**）。
 * 它把 `.next/prerender-manifest.json` 里构建期固化的 previewModeId / 签名密钥 / 加密密钥
 * 换成随机值；否则任何拿到发布包的人都能用 `x-prerender-revalidate` 头跳过 proxy.ts 的
 * 密码与 Host/Origin 围栏。**必须在起服务之前**执行。
 */
export function rotatePreviewSecrets(piDistRoot: string): void {
  const rotatePath = join(piDistRoot, 'bin', 'rotate-preview-secrets.js');
  if (!existsSync(rotatePath)) {
    throw new Error(`pi-web 密钥轮换脚本缺失：${rotatePath}`);
  }
  const mod = requireCjs(rotatePath) as {
    rotatePreviewSecrets?: (nextDir: string) => { ok?: boolean; reason?: string } | undefined;
    getRotationWarning?: (reason?: string) => string;
  };
  if (typeof mod.rotatePreviewSecrets !== 'function') {
    throw new Error(`${rotatePath} 未导出 rotatePreviewSecrets（上游接口变化？）`);
  }
  const result = mod.rotatePreviewSecrets(join(piDistRoot, '.next'));
  if (result && result.ok) {
    logInfo('预览密钥已轮换（.next/prerender-manifest.json）');
    return;
  }
  const warning =
    typeof mod.getRotationWarning === 'function'
      ? mod.getRotationWarning(result?.reason)
      : `原因：${result?.reason ?? '未知'}`;
  logWarn(`预览密钥轮换失败：\n${warning}`);
}

function httpGetOnce(
  url: string,
  timeoutMs = 5_000,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res: IncomingMessage) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (body.length < 4_000) body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时（${timeoutMs} ms）`));
    });
    req.on('error', reject);
  });
}

/** 就绪探测：轮询免认证探活端点，直到 200 或超时。 */
export async function waitForReady(port: number): Promise<void> {
  const url = `http://127.0.0.1:${port}${READY_PROBE_PATH}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let attempt = 0;
  let last = '(尚未探测)';

  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const res = await httpGetOnce(url);
      if (res.status === 200) {
        logInfo(`[ready] 第 ${attempt} 次探测通过：GET ${READY_PROBE_PATH} → 200 ${res.body.slice(0, 120)}`);
        return;
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = describeError(err).split('\n')[0];
    }
    logInfo(`[ready] 第 ${attempt} 次探测未就绪（${last}），${READY_INTERVAL_MS} ms 后重试`);
    await new Promise((r) => setTimeout(r, READY_INTERVAL_MS));
  }
  throw new Error(`就绪探测超时（${READY_TIMEOUT_MS} ms / ${attempt} 次），最后结果：${last}`);
}

/** 镜像 pi-web/lib/web-auth.ts 的 createWebSessionToken（载荷格式与 HMAC 完全一致）。 */
export function createSessionToken(password: string, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + PI_WEB_SESSION_MAX_AGE_SECONDS;
  const payload = `v1.${exp}.${randomBytes(16).toString('hex')}`;
  const signature = createHmac('sha256', password).update(`pi-web-session:${payload}`, 'utf8').digest('hex');
  return `${payload}.${signature}`;
}

export function basicAuthorizationHeader(password: string): string {
  return `Basic ${Buffer.from(`${PI_WEB_AUTH_USERNAME}:${password}`, 'utf8').toString('base64')}`;
}

/**
 * 鉴权注入：用户永远看不到登录页。
 *   pi-web 的 proxy.ts 对**页面导航**只认会话 cookie（Basic 头仅对 `/api/*` 生效），因此两条都要：
 *     ① `session.cookies.set` 写入 `pi_web_session`（主进程知道密码，可自行签名）；
 *     ② `webRequest.onBeforeSendHeaders` 给发往本服务 host:port 的请求补 `Authorization: Basic`（API/SSE 全通）。
 * 两者都**只对本服务的 host:port** 生效，不影响其它出栈请求。
 */
export async function installAuthInjection(
  session: Session,
  target: { hostname: string; port: number; password: string },
): Promise<void> {
  const origin = `http://${target.hostname}:${target.port}/`;
  try {
    await session.cookies.set({
      url: origin,
      name: PI_WEB_SESSION_COOKIE,
      value: createSessionToken(target.password),
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
    });
    logInfo(`已注入 ${PI_WEB_SESSION_COOKIE} 会话 cookie（origin=${origin}）`);
  } catch (err) {
    logWarn(`会话 cookie 注入失败（将回退到登录页）：${describeError(err)}`);
  }

  try {
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders ?? {};
      let parsed: URL | null = null;
      try {
        parsed = new URL(details.url);
      } catch {
        parsed = null; // data: / blob: 等非标准 URL：原样放行
      }
      if (
        parsed &&
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.hostname === target.hostname &&
        parsed.port === String(target.port)
      ) {
        headers.Authorization = basicAuthorizationHeader(target.password);
      }
      callback({ requestHeaders: headers });
    });
    logInfo(`已安装 Basic 鉴权注入（${target.hostname}:${target.port}）`);
  } catch (err) {
    logError(`webRequest 鉴权注入安装失败：${describeError(err)}`);
  }
}

type StartParams = { dir: string; hostname: string; port: number };

const START_SERVER_ENTRIES = [
  join('node_modules', 'next', 'dist', 'server', 'lib', 'start-server.js'),
  join('node_modules', 'next', 'dist', 'server', 'lib', 'start-server', 'index.js'),
];

function pickStartServerFn(mod: Record<string, unknown> | null): ((options: Record<string, unknown>) => unknown) | null {
  if (!mod) return null;
  const direct = mod.startServer;
  if (typeof direct === 'function') return direct as (options: Record<string, unknown>) => unknown;
  const dflt = mod.default as Record<string, unknown> | ((...args: unknown[]) => unknown) | undefined;
  if (dflt && typeof dflt === 'object' && typeof (dflt as Record<string, unknown>).startServer === 'function') {
    return (dflt as Record<string, unknown>).startServer as (options: Record<string, unknown>) => unknown;
  }
  if (typeof dflt === 'function') return dflt as (options: Record<string, unknown>) => unknown;
  if (typeof mod === 'function') return mod as unknown as (options: Record<string, unknown>) => unknown;
  return null;
}

/** 从 startServer 的返回值里挖出一个可关闭对象（不同版本返回 http.Server / { app } / undefined）。 */
function makeCloser(result: unknown): (() => Promise<void>) | null {
  const candidates: unknown[] = [
    result,
    (result as { server?: unknown } | undefined)?.server,
    (result as { httpServer?: unknown } | undefined)?.httpServer,
    (result as { app?: unknown } | undefined)?.app,
  ];
  for (const candidate of candidates) {
    const close = (candidate as { close?: unknown } | undefined)?.close;
    if (typeof close === 'function') {
      return () =>
        new Promise<void>((resolve) => {
          try {
            (close as (cb: () => void) => void).call(candidate, () => resolve());
          } catch {
            resolve();
          }
        });
    }
  }
  return null;
}

/** 候选 A：`start-server.js` 的 startServer 导出（进程内）。 */
async function startViaStartServerExport(params: StartParams): Promise<{ closer: (() => Promise<void>) | null }> {
  const tried: string[] = [];
  for (const rel of START_SERVER_ENTRIES) {
    const abs = join(params.dir, rel);
    if (!existsSync(abs)) {
      tried.push(`${rel}（不存在）`);
      continue;
    }
    const mod = await loadModule(abs);
    const startServer = pickStartServerFn(mod);
    if (!startServer) {
      tried.push(`${rel}（无 startServer 导出：${Object.keys(mod).slice(0, 12).join(',')}）`);
      continue;
    }
    // isDev / dev 两种键名都传：不同版本读其中之一，多余的键被忽略。
    const result = await startServer({
      dir: params.dir,
      hostname: params.hostname,
      port: params.port,
      isDev: false,
      dev: false,
      allowRetry: false,
      keepAliveTimeout: 61_000,
    });
    logInfo(`startServer 返回：${result === undefined ? '(undefined)' : Object.prototype.toString.call(result)}`);
    return { closer: makeCloser(result) };
  }
  throw new Error(`next/dist/server/lib/start-server 不可用：${tried.join('；')}`);
}

/** 候选 A′：NextServer 自定义服务器 API（仍为进程内，不经 CLI 的 process.exit()）。 */
async function startViaNextServerApi(params: StartParams): Promise<{ closer: () => Promise<void> }> {
  const abs = join(params.dir, 'node_modules', 'next', 'dist', 'server', 'next.js');
  if (!existsSync(abs)) throw new Error(`NextServer 入口不存在：${abs}`);
  const mod = await loadModule(abs);
  const NextServerCtor = (mod.default ?? mod) as (opts: Record<string, unknown>) => {
    prepare(): Promise<void>;
    getRequestHandler(): (req: unknown, res: unknown) => Promise<void>;
  };
  if (typeof NextServerCtor !== 'function') throw new Error(`${abs} 未导出 NextServer 构造函数`);

  const nodeHttp = requireCjs('node:http') as typeof import('node:http');
  const serverApp = NextServerCtor({ dir: params.dir, dev: false, hostname: params.hostname, port: params.port });
  await serverApp.prepare();
  const handler = serverApp.getRequestHandler();
  const httpServer = nodeHttp.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      logError(`请求处理失败：${describeError(err)}`);
      try {
        res.statusCode = 500;
        res.end('Internal Server Error');
      } catch {
        /* ignore */
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(params.port, params.hostname, () => resolve());
  });
  return {
    closer: () =>
      new Promise<void>((resolve) => {
        try {
          httpServer.close(() => resolve());
        } catch {
          resolve();
        }
      }),
  };
}

/** 候选 B（显式开启）：sidecar `next start`（`ELECTRON_RUN_AS_NODE=1`）。 */
async function startViaSpawn(params: StartParams, password: string): Promise<{ closer: () => Promise<void> }> {
  const nextBin = join(params.dir, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBin)) throw new Error(`next CLI 入口不存在：${nextBin}`);
  const child: ChildProcess = spawn(
    process.execPath,
    [nextBin, 'start', '-H', params.hostname, '-p', String(params.port)],
    {
      cwd: params.dir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PI_WEB_HOSTNAME: params.hostname,
        PI_WEB_PASSWORD: password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child.stdout?.on('data', (chunk: Buffer) => logInfo(`[sidecar:out] ${chunk.toString('utf8').trimEnd()}`));
  child.stderr?.on('data', (chunk: Buffer) => logWarn(`[sidecar:err] ${chunk.toString('utf8').trimEnd()}`));
  child.on('exit', (code, signal) => logWarn(`sidecar 退出：code=${code ?? 'null'} signal=${signal ?? 'null'}`));
  return {
    closer: () =>
      new Promise<void>((resolve) => {
        if (!child.pid || child.killed) {
          resolve();
          return;
        }
        const pid = child.pid;
        const done = (): void => resolve();
        child.once('exit', done);
        setTimeout(() => {
          try {
            if (process.platform === 'win32') {
              spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
            } else {
              process.kill(pid, 'SIGKILL');
            }
          } catch {
            /* 进程可能已退出 */
          }
          done();
        }, 2_000);
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
          } else {
            process.kill(pid, 'SIGTERM');
          }
        } catch {
          done();
        }
      }),
  };
}

export type StartHostOptions = {
  /** 已解压的 pi-dist 根目录（含 .next / node_modules / bin）。 */
  piDistRoot: string;
  /** 渲染层可访问的宿主名（桌面固定 127.0.0.1；如将来需要局域网访问再放开）。 */
  hostname?: string;
};

/**
 * 启动宿主：轮换预览密钥 → 启动 Next（进程内优先）→ 返回句柄。
 * 任何失败都抛出，由入口 index.ts 转为 fail-visible 的界面与日志。
 */
export async function startHost(options: StartHostOptions): Promise<PiWebServer> {
  const hostname = options.hostname ?? '127.0.0.1';
  const password = resolvePassword();
  const port = await resolveFreePort();

  // PI_WEB_HOSTNAME / PI_WEB_PASSWORD 必须在**起服务之前**设置：pi-web 的 proxy.ts 与
  // lib/web-auth.ts 在模块初始化时读取它们。
  process.env.PI_WEB_HOSTNAME = hostname;
  process.env.PI_WEB_PASSWORD = password;
  logInfo(`PI_WEB_HOSTNAME = ${hostname}｜PI_WEB_PASSWORD = ${password.length} 字符（不回显）`);

  rotatePreviewSecrets(options.piDistRoot);

  const forcedMode = process.env.PI_DESKTOP_HOST_MODE;
  // ⚠️ Windows 上 **cwd 与产物根跨盘符** 会让 Next 的清单路径拼坏（现象是每个请求 500 → 就绪探测 30 s 超时，很难定位）：
  //    Next 用「cwd 与 dir 的相对关系」还原项目根并用它拼 `.next` 下的清单：
  //      `next/dist/server/route-modules/route-module.js`：`join(process.cwd(), path.relative(process.cwd(), dir))`
  //      → `load-manifest.external.js`: `loadManifestFromRelativePath({ projectDir, distDir, manifest })` → `path.join(...)`。
  //    Windows 的 `path.relative()` **无法跨盘符表达相对路径**，只能返回绝对路径；`join()` 会把它当相对段再拼一次。
  //    实测（Node v24.7.0 + pi-web 0.11.1 产物，cwd=`C:\…\scratch\c-cwd`、dir=`D:\…\pi-desktop\pi-dist`）：
  //      ENOENT … open 'C:\…\c-cwd\D:\…\pi-desktop\pi-dist\D:\…\pi-desktop\pi-dist\.next\routes-manifest.json'
  //    evidence：logs/20261013-0/evidence/TC13-probe-A-crossdrive-no-chdir.log（同一探针去掉跨盘符、或 chdir 后即 200：
  //    TC13-probe-B-crossdrive-chdir.log）；打包态同一形态见 logs/20261013-0/04-packaged-run.log。
  //    修法与上游 `next start`（约定在项目根目录下执行）一致：**把进程工作目录切到产物根**，让该相对关系退化为 ''。
  //    下面的守卫把这条不变式做成 fail-visible：跨盘符立刻报错，而不是静默等 30 s 就绪超时。
  const distRootPath = resolve(options.piDistRoot);
  if (resolve(process.cwd()) !== distRootPath) {
    process.chdir(distRootPath);
    logInfo(`进程工作目录已切换到产物根（Next 项目根基准）：${process.cwd()}`);
  }
  const relativeProjectDir = relative(process.cwd(), distRootPath);
  if (isAbsolute(relativeProjectDir)) {
    throw new Error(
      `Next 项目根基准不可用：cwd=${process.cwd()} 与产物根 ${distRootPath} 跨盘符，`
        + 'path.relative() 只能返回绝对路径，Next 的 join(cwd, 该值) 必然拼错清单路径。'
        + '请让应用工作目录与产物根同盘（默认布局下由本函数 chdir 保证）。',
    );
  }
  // 目录串统一用正斜杠（与已实测通过的组合 exp-t1/t2c/t3b 一致）；原始路径只用于日志，便于对照。
  const posixDistRoot = distRootPath.split(sep).join('/');
  if (posixDistRoot !== distRootPath) {
    logInfo(`Next dir 规范化（Windows 路径兼容）：${posixDistRoot}｜原始：${distRootPath}`);
  }
  const params: StartParams = { dir: posixDistRoot, hostname, port };

  let mode: HostMode = 'in-process';
  let closer: (() => Promise<void>) | null = null;

  if (forcedMode === 'spawn') {
    logWarn('PI_DESKTOP_HOST_MODE=spawn：显式使用 sidecar 模式（候选 B，含进程树清理成本）');
    mode = 'spawn';
    closer = (await startViaSpawn(params, password)).closer;
  } else {
    try {
      closer = (await startViaStartServerExport(params)).closer;
    } catch (err) {
      logWarn(`候选 A（start-server 导出）不可用：${describeError(err)}`);
      logWarn('尝试候选 A′（NextServer 自定义服务器 API，仍为进程内）');
      closer = (await startViaNextServerApi(params)).closer;
      mode = 'in-process-next-server-api';
    }
  }

  if (!closer) {
    logWarn('未能从 startServer 返回值中取得可关闭对象；退出时仅能强退进程');
  }

  logInfo(`服务端已启动：mode=${mode}｜${hostname}:${port}`);
  return {
    mode,
    hostname,
    port,
    url: `http://${hostname}:${port}/`,
    password,
    close: async () => {
      if (!closer) return;
      await closer();
    },
  };
}

/** 安装渲染会话的鉴权注入（窗口创建后调用；与 startHost 分离，便于候选切换时复用）。 */
export async function installAuthForWindow(
  window: { webContents: { session: Session } },
  server: PiWebServer,
): Promise<void> {
  await installAuthInjection(window.webContents.session, {
    hostname: server.hostname,
    port: server.port,
    password: server.password,
  });
}

/** 供 index.ts 在退出链里使用的辅助：带 deadline 的关闭。 */
export async function closeWithDeadline(server: PiWebServer | null, deadlineMs: number): Promise<void> {
  if (!server) return;
  await Promise.race([
    server.close().catch((err) => logWarn(`关闭服务端失败：${describeError(err)}`)),
    new Promise<void>((resolve) => setTimeout(resolve, deadlineMs)),
  ]);
}

export { electronSession };
