/**
 * preload（module 006-preload）—— 只承载**壳层动作**的最小桥。
 *
 * 关键约束：
 *   1. **数据面永不过 IPC**：Pi Web UI 的一切经同源 HTTP（`/api/*` + SSE）直达内嵌服务端；
 *   2. **只对本地文档暴露**：同一个 BrowserWindow 先加载本地 loading 页（`file://`），
 *      随后导航到 `http://127.0.0.1:<port>/`（Pi Web UI）。preload 在两者中都会执行，
 *      因此这里用 `location.protocol === 'file:'` 把桥**限制在壳层自有页面**，
 *      绝不向远端页面暴露任何壳能力。
 */

import { contextBridge, ipcRenderer } from 'electron';

function isLocalDocument(): boolean {
  try {
    return window.location.protocol === 'file:';
  } catch {
    return false;
  }
}

if (isLocalDocument()) {
  contextBridge.exposeInMainWorld('piDesktop', {
    getInfo: () => ipcRenderer.invoke('pi-desktop:info'),
    openLog: () => ipcRenderer.invoke('pi-desktop:open-log'),
    openSessionDir: () => ipcRenderer.invoke('pi-desktop:open-session-dir'),
    checkForUpdates: () => ipcRenderer.invoke('pi-desktop:check-updates'),
    retry: () => ipcRenderer.invoke('pi-desktop:retry'),
    quit: () => ipcRenderer.invoke('pi-desktop:quit'),
  });
} else {
  // 远端（内嵌 Pi Web UI）：不暴露任何壳能力。
  // 这里不打印日志，避免污染 Pi Web UI 的控制台。
}
