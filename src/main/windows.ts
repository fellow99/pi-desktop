import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { APP_ID, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, PRODUCT_NAME, UI_HTML_MARKERS } from './constants';
import { describeError, getStage, logError, logInfo, logWarn } from './logger';
import { loadWindowState, installFullscreenShortcut, trackWindowState } from './window-state';

/**
 * 窗口管理（module 002-window）。
 *
 * 形态（🔶 沿用 dsh-desktop）：常规标题栏 `frame: true`、`sandbox: true` + `contextIsolation: true`
 * + **无 nodeIntegration**；加载走「先 loading 页 → 就绪后 loadURL(内嵌服务端)」两段式。
 *
 * 安全收口（三处，全部校验来源）：
 *   1. `setWindowOpenHandler`：新窗口一律 deny，http(s) 交给系统浏览器；
 *   2. `will-navigate`：只允许本应用来源（内嵌服务端 origin 或本地 loading 页），其余一律外链；
 *   3. `setPermissionRequestHandler`：只放行白名单权限，且校验请求来源与 webContents.id。
 */

export type LoadingState = 'running' | 'done' | 'failed';

export type ShellIpcContext = {
  getInfo(): {
    productName: string;
    appVersion: string;
    electron: string;
    node: string;
    chrome: string;
    stage: string;
    serverUrl: string | null;
    agentDir: string | null;
    piDistRoot: string | null;
    logFile: string | null;
  };
  getAppOrigin(): string | null;
  openLog(): Promise<void>;
  openSessionDir(): Promise<void>;
  checkForUpdates(): Promise<{ status: string; latest?: string; url?: string; message?: string }>;
  retry(): Promise<void>;
  quit(): void;
};

/** 权限白名单（其余一律拒绝）。 */
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write']);

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * 窗口图标（module 012-branding 的 FR-012-008）：走父工程物料，不依赖可执行文件图标。
 * 打包态在 `process.resourcesPath`（forge `extraResource`），开发态在仓库 `resources/`。
 */
function resolveWindowIcon(): string | undefined {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'icon.png')]
    : [join(app.getAppPath(), 'resources', 'icon.png')];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    logWarn(`窗口图标物料缺失（${candidates.join(' / ')}），回退到可执行文件图标`);
    return undefined;
  }
  return found;
}

function loadingPageUrl(): { devUrl?: string } {
  return { devUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL };
}

function isTrustedUrl(target: string, appOrigin: string | null): boolean {
  try {
    const parsed = new URL(target);
    if (parsed.protocol === 'file:') return true;
    if (appOrigin && parsed.origin === appOrigin) return true;
    return false;
  } catch {
    return false;
  }
}

function installNavigationGuards(win: BrowserWindow, getAppOrigin: () => string | null): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      logInfo(`新窗口请求转交系统浏览器：${url}`);
      void shell.openExternal(url);
    } else {
      logWarn(`已拦截非 http(s) 的新窗口请求：${url}`);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url, getAppOrigin())) return;
    event.preventDefault();
    logInfo(`已拦截应用内导航（转交系统浏览器）：${url}`);
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl ?? webContents.getURL();
    const trusted = isTrustedUrl(requestingUrl, getAppOrigin());
    const sameContents = webContents.id === win.webContents.id;
    const allowed = ALLOWED_PERMISSIONS.has(permission) && trusted && sameContents;
    if (!allowed) {
      logWarn(`拒绝权限请求：permission=${permission}｜from=${requestingUrl}｜sameContents=${sameContents}`);
    }
    callback(allowed);
  });
}

export function createMainWindow(deps: { getAppOrigin: () => string | null }): BrowserWindow {
  const state = loadWindowState();
  const options: Electron.BrowserWindowConstructorOptions = {
    width: state.width,
    height: state.height,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    title: PRODUCT_NAME,
    autoHideMenuBar: true,
    frame: true,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  };
  if (typeof state.x === 'number' && typeof state.y === 'number') {
    options.x = state.x;
    options.y = state.y;
  }

  // macOS 的窗口与程序坞图标来自 bundle（.icns），显式设置无意义；Windows/Linux 必须显式给物料图标。
  if (process.platform !== 'darwin') {
    const iconPath = resolveWindowIcon();
    if (iconPath) {
      options.icon = iconPath;
      logInfo(`窗口图标 = ${iconPath}`);
    }
  }

  const win = new BrowserWindow(options);
  mainWindow = win;
  trackWindowState(win);
  installFullscreenShortcut(win);
  installNavigationGuards(win, deps.getAppOrigin);

  win.once('ready-to-show', () => {
    if (state.isMaximized) win.maximize();
    win.show();
    logInfo('主窗口已显示（ready-to-show）');
  });

  win.webContents.on('did-fail-load', (_event, code, description, failedUrl) => {
    const detail = `${code} ${description}（${failedUrl}）`;
    globalThis.__piDesktopRenderError = detail;
    logError(`页面加载失败：${detail}`);
    if (/^https?:\/\//i.test(failedUrl || '')) {
      setStageOnWindow(win, getStage(), `页面加载失败：${detail}`, 'failed');
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    const detail = `渲染进程退出：reason=${details.reason} exitCode=${details.exitCode}`;
    globalThis.__piDesktopRenderError = detail;
    logError(detail);
  });

  const { devUrl } = loadingPageUrl();
  const load = devUrl
    ? win.loadURL(devUrl)
    : win.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  void Promise.resolve(load).catch((err) => logError(`loading 页加载失败：${describeError(err)}`));
  logInfo(`loading 页已加载（mode=${devUrl ? 'vite-dev' : 'built'}）`);
  return win;
}

/** 把启动阶段推给 loading 页（页面脚本未就绪时静默失败，标题始终同步）。 */
export function setStageOnWindow(win: BrowserWindow, stage: string, detail: string, state: LoadingState): void {
  if (win.isDestroyed()) return;
  try {
    win.setTitle(state === 'failed' ? `${PRODUCT_NAME} — 启动失败` : `${PRODUCT_NAME} — ${stage}`);
  } catch {
    /* 标题设置失败不影响主流程 */
  }
  void win.webContents
    .executeJavaScript(
      `window.__piDesktopSetStage && window.__piDesktopSetStage(${JSON.stringify(stage)}, ${JSON.stringify(
        detail,
      )}, ${JSON.stringify(state)})`,
      true,
    )
    .catch(() => {
      /* loading 页脚本尚未加载：忽略 */
    });
}

/** 就绪后加载 Pi Web UI，并做首屏标记断言（命中失败多半被重定向到登录页）。 */
export async function loadPiWebUi(win: BrowserWindow, url: string): Promise<void> {
  logInfo(`加载 Pi Web UI：${url}`);
  await win.loadURL(url);
  try {
    const html = (await win.webContents.executeJavaScript('document.documentElement.outerHTML.slice(0, 4000)', true)) as string;
    const marker = UI_HTML_MARKERS.find((m) => typeof html === 'string' && html.includes(m));
    if (marker) logInfo(`首屏完成，UI 标记命中：${marker}`);
    else logWarn(`首屏 HTML 未命中预期 UI 标记（${UI_HTML_MARKERS.join(' / ')}），请检查是否被重定向到登录页`);
  } catch (err) {
    logWarn(`首屏标记断言失败（不阻塞）：${describeError(err)}`);
  }
}

/** 壳层 IPC（只承载壳层动作；**数据面永不过 IPC**）。 */
export function registerShellIpc(ctx: ShellIpcContext): void {
  ipcMain.handle('pi-desktop:info', () => ctx.getInfo());
  ipcMain.handle('pi-desktop:open-log', () => ctx.openLog());
  ipcMain.handle('pi-desktop:open-session-dir', () => ctx.openSessionDir());
  ipcMain.handle('pi-desktop:check-updates', () => ctx.checkForUpdates());
  ipcMain.handle('pi-desktop:retry', () => ctx.retry());
  ipcMain.handle('pi-desktop:quit', () => ctx.quit());
  logInfo(`壳层 IPC 已注册（appId=${APP_ID}）`);
}

