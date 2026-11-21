/**
 * 设置窗口（module 301-sync-daemon）。
 *
 * 形态（plan §3.1 D5 / FR-301-004~005）：
 *   - 原生 HTML/CSS/JS（`resources/settings/**`，随包 extraResource 分发，`loadFile` 加载），
 *     不引入构建链/框架；多 tabs 骨架 + 「中枢服务」tab；
 *   - 安全参数与主窗口同级：`sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`，
 *     独立最小 preload（`preload-settings.js`，只对 file: 来源暴露桥）；
 *   - 单例：已打开则聚焦（FR-301-002）；
 *   - IPC 三条（见 preload `window.piDesktopSettings`）：
 *       `pi-desktop:settings:sync:get`     invoke  → { settings, status }
 *       `pi-desktop:settings:sync:apply`   invoke  → { ok: true } / throw Error(可读消息)
 *       `pi-desktop:settings:sync:status`  send    → { status }
 *   - 窗口打开期间每 ≤3s 推送一次当前状态（FR-301-022），关闭即停（不泄漏句柄）。
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeError, logInfo, logWarn } from './logger';
import {
  applySyncConfig,
  getSyncStatus,
  loadSyncConfig,
  onSyncStatusChange,
  type SyncDaemonSettings,
  type SyncRuntimeOptions,
  type SyncStatus,
} from './sync-daemon';

const CHANNEL_GET = 'pi-desktop:settings:sync:get';
const CHANNEL_APPLY = 'pi-desktop:settings:sync:apply';
const CHANNEL_STATUS = 'pi-desktop:settings:sync:status';
/** 窗口打开期间的状态推送周期（FR-301-022：≤3s）。 */
const PUSH_INTERVAL_MS = 3_000;

const DEFAULT_HOST_NAME = `${process.platform === 'win32' ? 'win' : process.platform}-pi-desktop`;

let settingsWindow: BrowserWindow | null = null;
let pushTimer: NodeJS.Timeout | null = null;
let statusUnsub: (() => void) | null = null;
let ipcRegistered = false;

function settingsRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, 'settings') : join(app.getAppPath(), 'resources', 'settings');
}

/** 导航白名单：仅允许 file:// 且落在设置页目录内（含其下静态资源）。 */
function isAllowedNavigation(url: string, root: string): boolean {
  if (!/^file:\/\//i.test(url)) return false;
  try {
    const filePath = fileURLToPath(url);
    if (!isAbsolute(filePath)) return false;
    const rel = relative(root, filePath);
    // path.relative 结果：'' = 目录本身；'..' 开头 = 越出根目录；不同盘符 = 绝对路径。三者均拒绝。
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  } catch {
    return false;
  }
}

function pushStatus(): void {
  const win = settingsWindow;
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(CHANNEL_STATUS, { status: getSyncStatus() });
  } catch {
    /* webContents 正在销毁：忽略 */
  }
}

function startPushing(): void {
  stopPushing();
  pushTimer = setInterval(pushStatus, PUSH_INTERVAL_MS);
  statusUnsub = onSyncStatusChange(() => pushStatus());
}

function stopPushing(): void {
  if (pushTimer) {
    clearInterval(pushTimer);
    pushTimer = null;
  }
  statusUnsub?.();
  statusUnsub = null;
}

function settingsHtmlPath(): string {
  const file = join(settingsRoot(), 'index.html');
  if (!existsSync(file)) {
    logWarn(`[settings] 设置页缺失：${file}（extraResource 未带 resources/settings/**？）`);
  }
  return file;
}

function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    height: 520,
    minWidth: 440,
    minHeight: 420,
    show: false,
    title: '设置',
    autoHideMenuBar: true,
    frame: true,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // 导航收口：设置窗口只允许加载设置页目录内的本地文件，其余一律拦截。
  win.webContents.setWindowOpenHandler(({ url }) => {
    logWarn(`[settings] 已拦截新窗口请求：${url}`);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url, settingsRoot())) return;
    event.preventDefault();
    logWarn(`[settings] 已拦截导航：${url}`);
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', pushStatus);
  win.on('closed', () => {
    stopPushing();
    settingsWindow = null;
    logInfo('[settings] 设置窗口已关闭');
  });

  void win.loadFile(settingsHtmlPath()).catch((err) => logWarn(`[settings] 设置页加载失败：${describeError(err)}`));
  return win;
}

/** 打开设置窗口（幂等：已打开则聚焦/显示，FR-301-002）。托盘「设置」项调用。 */
export function openSettingsWindow(): void {
  const existing = settingsWindow;
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  } else {
    settingsWindow = createSettingsWindow();
    logInfo('[settings] 设置窗口已打开');
  }
  // 幂等：startPushing 先停后启，重复调用不泄漏定时器/订阅（FR-301-022）。
  startPushing();
}

/**
 * 注册设置窗口 IPC（app ready 后调用一次）。
 * `getRuntime` 由入口提供（内嵌 pi-web 就绪后才非 null）——依赖注入，避免反向 import index.ts。
 */
export function registerSettingsIpc(getRuntime: () => SyncRuntimeOptions | null): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle(CHANNEL_GET, async (): Promise<{ settings: SyncDaemonSettings; status: SyncStatus }> => {
    const loaded = await loadSyncConfig();
    const settings: SyncDaemonSettings = loaded
      ? loaded.settings
      : { enabled: false, hubUrl: '', hostName: DEFAULT_HOST_NAME, hubToken: '' };
    return { settings, status: getSyncStatus() };
  });

  ipcMain.handle(CHANNEL_APPLY, async (_event, payload: unknown): Promise<{ ok: true }> => {
    const p = payload as Partial<SyncDaemonSettings> | undefined;
    if (!p || typeof p.enabled !== 'boolean' || typeof p.hubUrl !== 'string' || typeof p.hostName !== 'string' || typeof p.hubToken !== 'string') {
      throw new Error('设置数据格式不正确，请重试');
    }
    const settings: SyncDaemonSettings = {
      enabled: p.enabled,
      hubUrl: p.hubUrl.trim(),
      hostName: p.hostName.trim(),
      hubToken: p.hubToken.trim(),
    };
    const runtime = getRuntime();
    if (!runtime) {
      throw new Error('内嵌服务尚未就绪，请稍后再试');
    }
    // 校验失败（FR-301-011）在这里抛可读错误；daemon 启动失败不抛（置红 + 日志）。
    await applySyncConfig(settings, runtime);
    return { ok: true };
  });

  logInfo('[settings] 设置窗口 IPC 已注册');
}
