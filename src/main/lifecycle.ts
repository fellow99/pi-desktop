import { app } from 'electron';

import { describeError, logError, logInfo, logWarn } from './logger';

/**
 * 生命周期与安全横切（module 005-lifecycle）。
 * 三件事都是 🔶 沿用 dsh-desktop 的既有范式（opencode 系桌面的共同做法）：
 *   1. loopback 并入 NO_PROXY/no_proxy + Chromium 的 `proxy-bypass-list <-loopback>`；
 *   2. 系统 CA 合并（企业代理/自签场景），能力缺失时**安全降级不抛错**；
 *   3. 崩溃兜底：uncaughtException / unhandledRejection 必须留痕（fail-visible）。
 */

/** 本机请求必须直连：避免被用户/企业代理拦截（服务端绑 127.0.0.1）。 */
export function ensureLoopbackNoProxy(): void {
  const bypass = new Set(
    (process.env.NO_PROXY || process.env.no_proxy || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const host of ['127.0.0.1', 'localhost', '::1']) bypass.add(host);
  process.env.NO_PROXY = [...bypass].join(',');
  process.env.no_proxy = process.env.NO_PROXY;

  app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');
  logInfo(`NO_PROXY = ${process.env.NO_PROXY}｜已追加 proxy-bypass-list <-loopback>`);
}

/**
 * 系统 CA 合并：把操作系统信任的根证书并入 Node 默认 CA 列表。
 * 动态 require + 类型守卫：不同 Electron/Node 版本的 tls 能力不同，缺能力时必须静默降级
 * （这里的失败不应该阻塞应用启动）。
 */
export function setupSystemCertificates(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tls = require('node:tls') as {
      getCACertificates?: (kind: 'default' | 'system') => string[];
      setDefaultCACertificates?: (certs: string[]) => void;
    };
    if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') {
      logWarn('node:tls 不支持 getCACertificates/setDefaultCACertificates，跳过系统 CA 合并（安全降级）');
      return;
    }
    const defaults = tls.getCACertificates('default');
    const system = tls.getCACertificates('system');
    const merged = [...new Set([...defaults, ...system])];
    tls.setDefaultCACertificates(merged);
    logInfo(`系统 CA 已合并：default=${defaults.length} + system=${system.length} → ${merged.length} 条`);
  } catch (err) {
    logWarn(`系统 CA 合并失败（安全降级，不阻塞启动）：${describeError(err)}`);
  }
}

/** 崩溃兜底：进程级异常必须留痕，避免「窗口莫名其妙没了但没有任何线索」。 */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (err) => {
    globalThis.__piDesktopHostError = describeError(err);
    logError(`uncaughtException: ${describeError(err)}`);
  });
  process.on('unhandledRejection', (reason) => {
    globalThis.__piDesktopRenderError = describeError(reason);
    logError(`unhandledRejection: ${describeError(reason)}`);
  });
}

declare global {
  // eslint-disable-next-line no-var
  var __piDesktopHostError: string | undefined;
  // eslint-disable-next-line no-var
  var __piDesktopRenderError: string | undefined;
  // eslint-disable-next-line no-var
  var __piDesktopExtractError: string | undefined;
}

/** 退出前的进程状态快照（便于用户报障时一眼看出卡在哪）。 */
export function logShutdownSnapshot(beginAt: number): void {
  logInfo(`退出耗时 ${Date.now() - beginAt} ms`);
}
