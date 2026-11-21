/**
 * preload（module 104-preload）—— 只承载**壳层动作**的最小桥。
 *
 * 关键约束：
 *   1. **数据面永不过 IPC**：Pi Web UI 的一切经同源 HTTP（`/api/*` + SSE）直达内嵌服务端；
 *   2. **只对本地文档暴露**：同一个 BrowserWindow 先加载本地 loading 页（`file://`），
 *      随后导航到 `http://127.0.0.1:<port>/`（Pi Web UI）。preload 在两者中都会执行，
 *      因此这里用 `location.protocol === 'file:'` 把壳动作桥**限制在壳层自有页面**。
 *   3. **中枢服务设置是唯一例外**（301）：pi-web 设置对话框里的 `sync` 分区需要读写壳侧
 *      配置，故对**应用本机 http 源**额外暴露独立的 `piDesktopSync`（只 get/apply）。
 *      主进程仍会对每次调用校验 `senderFrame` 的 origin 与顶层 frame，preload 的判断只是第一道。
 */

import { contextBridge, ipcRenderer } from 'electron';

function isLocalDocument(): boolean {
  try {
    return window.location.protocol === 'file:';
  } catch {
    return false;
  }
}

function isLoopbackAppOrigin(): boolean {
  try {
    if (window.location.protocol !== 'http:') return false;
    const host = window.location.hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
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
} else if (isLoopbackAppOrigin()) {
  // 301：中枢服务设置分区（pi-web 补丁）使用的窄桥。仅两个同步动作，无其它壳能力。
  contextBridge.exposeInMainWorld('piDesktopSync', {
    get: () => ipcRenderer.invoke('pi-desktop:sync:get'),
    apply: (settings: { enabled: boolean; hubUrl: string; hostName: string; hubToken: string }) =>
      ipcRenderer.invoke('pi-desktop:sync:apply', settings),
  });
} else {
  // 其它来源：不暴露任何壳能力；这里不打印日志，避免污染 Pi Web UI 的控制台。
}
