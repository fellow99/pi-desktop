/**
 * 设置窗口独立 preload（module 301-sync-daemon，FR-301-004）。
 *
 * 与主窗口 preload 完全隔离的最小桥：只暴露「中枢服务」三通道。
 * 与主窗口同样的来源纪律：只对本地文档（file:）暴露，绝不向其它来源暴露壳能力。
 */

import { contextBridge, ipcRenderer } from 'electron';

type SyncStatus =
  | { state: 'disabled' }
  | { state: 'starting' }
  | { state: 'running' }
  | { state: 'stopped'; reason?: string };

type SyncSettings = {
  enabled: boolean;
  hubUrl: string;
  hostName: string;
  hubToken: string;
};

function isLocalDocument(): boolean {
  try {
    return window.location.protocol === 'file:';
  } catch {
    return false;
  }
}

if (isLocalDocument()) {
  contextBridge.exposeInMainWorld('piDesktopSettings', {
    /** 读当前配置 + daemon 状态（表单回填）。 */
    get: (): Promise<{ settings: SyncSettings; status: SyncStatus }> => ipcRenderer.invoke('pi-desktop:settings:sync:get'),
    /** 「应用」：校验 + 原子写 + （重）启动 daemon；失败抛可读 Error。 */
    apply: (settings: SyncSettings): Promise<{ ok: true }> => ipcRenderer.invoke('pi-desktop:settings:sync:apply', settings),
    /** 订阅状态推送；返回解绑函数（页面 unload 时调用，避免句柄泄漏）。 */
    onStatus: (callback: (status: SyncStatus) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { status: SyncStatus }): void => {
        callback(payload?.status);
      };
      ipcRenderer.on('pi-desktop:settings:sync:status', listener);
      return () => {
        ipcRenderer.removeListener('pi-desktop:settings:sync:status', listener);
      };
    },
  });
} else {
  // 非本地文档：不暴露任何壳能力（与主窗口 preload 同一纪律）。
}
