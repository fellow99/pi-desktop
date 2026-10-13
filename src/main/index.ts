import started from 'electron-squirrel-startup';
import { app, BrowserWindow, Menu, dialog } from 'electron';
import { join } from 'node:path';

import { ensureArtifact, type ArtifactState } from './artifact';
import { APP_ID, PRODUCT_NAME, READY_TIMEOUT_MS, SHUTDOWN_DEADLINE_MS } from './constants';
import { assembleEnv, closeWithDeadline, installAuthForWindow, startHost, waitForReady, type PiWebServer } from './host';
import { ensureLoopbackNoProxy, installCrashHandlers, logShutdownSnapshot, setupSystemCertificates } from './lifecycle';
import { describeError, getLogFilePath, getStage, logError, logInfo, logWarn, setStage } from './logger';
import { setupNotifications } from './notifications';
import { hasRecentActivity } from './session-watch';
import { loadSettings } from './settings';
import { createTray, destroyTray, refreshTrayMenu } from './tray';
import { checkForUpdates, openDownloadPage } from './update-check';
import { createMainWindow, getMainWindow, loadPiWebUi, registerShellIpc, setStageOnWindow } from './windows';

/**
 * 应用入口编排（module 007-app-entry）。
 *
 * 顺序（docs/工程规划.md §4.7 的启动时序）：
 *   Squirrel 短路 → 单实例锁 → whenReady 前安全准备（NO_PROXY / 系统 CA / 崩溃兜底）
 *   → whenReady：AppUserModelId / 去默认菜单 / 注册壳层 IPC / 建窗（loading 页）/ 托盘
 *   → boot()：[env] → [artifact] → [server] → [ready] → [auth] → [load] → [done]
 *
 * 纪律（fail-visible）：每个阶段都必须可观测；失败时把「阶段 + 原因」写进窗口标题、
 * loading 页文本与日志，绝不留下一个没有任何线索的空白窗口。
 */

type Runtime = {
  userData: string;
  agentDir: string | null;
  artifact: ArtifactState | null;
  server: PiWebServer | null;
  stopNotifications: (() => void) | null;
  booting: boolean;
  quitConfirmed: boolean;
  quitting: boolean;
};

const runtime: Runtime = {
  userData: '',
  agentDir: null,
  artifact: null,
  server: null,
  stopNotifications: null,
  booting: false,
  quitConfirmed: false,
  quitting: false,
};

function showMainWindow(): void {
  const win = getMainWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function failVisible(detail: string, err: unknown): void {
  const win = getMainWindow();
  const message = `${detail}\n${describeError(err)}`;
  globalThis.__piDesktopHostError = message;
  logError(`启动失败（阶段：${getStage()}）：${message}`);
  if (win) setStageOnWindow(win, getStage(), message, 'failed');
}

function trayActions(): Parameters<typeof createTray>[0] {
  return {
    showWindow: showMainWindow,
    openSessionDir: async () => {
      const { shell } = await import('electron');
      if (!runtime.agentDir) return;
      await shell.openPath(runtime.agentDir);
    },
    openLog: async () => {
      const { shell } = await import('electron');
      const file = getLogFilePath();
      if (!file) return;
      const error = await shell.openPath(file);
      if (error) logWarn(`打开日志失败：${error}`);
    },
    checkForUpdates: async () => {
      const result = await checkForUpdates();
      const win = getMainWindow();
      const text =
        result.status === 'update-available'
          ? `发现新版本 ${result.latest}（当前 ${result.current}）。是否打开下载页？`
          : result.status === 'up-to-date'
            ? `已是最新版本（${result.current}）。`
            : `无法检查更新：${result.message ?? '未知原因'}`;
      if (result.status === 'update-available' && result.url && win) {
        const choice = await dialog.showMessageBox(win, {
          type: 'info',
          title: '检查更新',
          message: text,
          buttons: ['打开下载页', '稍后'],
          defaultId: 0,
          cancelId: 1,
        });
        if (choice.response === 0) await openDownloadPage(result.url);
        return;
      }
      if (win) {
        await dialog.showMessageBox(win, { type: 'info', title: '检查更新', message: text, buttons: ['好'] });
      }
    },
    quit: () => app.quit(),
    isReady: () => runtime.server !== null,
    hasAgentDir: () => runtime.agentDir !== null,
  };
}

/**
 * 启动链。可被「重试」按钮重复调用（幂等：先关掉上一轮的 server）。
 * ⬜ 待验证（探针 P0-1/P0-2/P0-3）：进程内 Next 的导出形态、Node 24.21 兼容性、
 *    渲染层与 node-pty 的可用性。
 */
async function boot(): Promise<void> {
  const win = getMainWindow();
  if (!win) {
    logError('boot 被调用时没有主窗口，放弃启动链');
    return;
  }
  if (runtime.booting) {
    logWarn('启动链正在执行，忽略重复请求');
    return;
  }
  runtime.booting = true;

  try {
    // 开发出口：直连已运行的 pi-web（npm run dev / next start），跳过解压与内嵌服务器。
    const devServer = process.env.PI_DESKTOP_DEV_SERVER;
    if (devServer) {
      setStage('开发模式：直连 PI_DESKTOP_DEV_SERVER（跳过解压与内嵌服务端）');
      setStageOnWindow(win, getStage(), devServer, 'running');
      await loadPiWebUi(win, devServer);
      setStage('就绪（开发模式）');
      setStageOnWindow(win, getStage(), devServer, 'done');
      return;
    }

    if (runtime.server) {
      logInfo('检测到上一轮的服务端实例，先关闭（重试路径）');
      await closeWithDeadline(runtime.server, SHUTDOWN_DEADLINE_MS);
      runtime.server = null;
    }

    setStage('环境装配（PI_CODING_AGENT_DIR / PI_WEB_* / NO_PROXY）');
    setStageOnWindow(win, getStage(), `userData = ${runtime.userData}`, 'running');
    const settings = loadSettings();
    runtime.agentDir = assembleEnv(runtime.userData, settings);

    setStage('产物就位（pi-dist.tar.gz → <userData>/pi-dist，SHA-256 marker 幂等）');
    setStageOnWindow(win, getStage(), '首次启动需要解压数万文件，请稍候…', 'running');
    runtime.artifact = await ensureArtifact(runtime.userData);

    setStage('启动内嵌服务端（进程内 Next，127.0.0.1 随机端口）');
    setStageOnWindow(win, getStage(), `pi-dist = ${runtime.artifact.piDistRoot}`, 'running');
    runtime.server = await startHost({ piDistRoot: runtime.artifact.piDistRoot });

    setStage(`等待服务就绪（HTTP 轮询 127.0.0.1:${runtime.server.port}，上限 ${READY_TIMEOUT_MS / 1000}s）`);
    setStageOnWindow(win, getStage(), `mode=${runtime.server.mode}｜port=${runtime.server.port}`, 'running');
    await waitForReady(runtime.server.port);

    setStage('注入鉴权（会话 cookie + Basic 头），用户无需手动登录');
    await installAuthForWindow(win, runtime.server);

    setStage('加载 Pi Web UI');
    setStageOnWindow(win, getStage(), runtime.server.url, 'running');
    await loadPiWebUi(win, runtime.server.url);

    setStage('就绪');
    setStageOnWindow(win, '就绪', `服务端 ${runtime.server.url}｜agentDir = ${runtime.agentDir}`, 'done');
    refreshTrayMenu(trayActions());

    if (!runtime.stopNotifications && runtime.agentDir) {
      runtime.stopNotifications = setupNotifications({
        sessionsDir: join(runtime.agentDir, 'sessions'),
        isWindowBackgrounded: () => {
          const current = getMainWindow();
          if (!current) return true;
          return !current.isVisible() || !current.isFocused();
        },
        focusWindow: showMainWindow,
      });
    }
  } catch (err) {
    failVisible('启动链失败', err);
    refreshTrayMenu(trayActions());
  } finally {
    runtime.booting = false;
  }
}

// Squirrel 的安装/更新/卸载会以短生命周期拉起本应用：必须尽早退出。
// ⚠️ 必须静态 import：Forge 的 Vite 插件会把 node_modules 排除在打包外，动态 require 会失败。
if (started) {
  app.quit();
} else {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      logInfo('检测到第二个实例，唤起主窗口');
      showMainWindow();
    });

    // whenReady 之前：安全准备必须在窗口/网络栈初始化前完成。
    ensureLoopbackNoProxy();
    setupSystemCertificates();
    installCrashHandlers();
    Menu.setApplicationMenu(null);

    void app.whenReady().then(async () => {
      app.setAppUserModelId(APP_ID); // Windows 通知归组必需
      runtime.userData = app.getPath('userData');
      logInfo(`${PRODUCT_NAME} 启动：version=${app.getVersion()}｜userData=${runtime.userData}`);
      logInfo(`Electron=${process.versions.electron}｜Node=${process.versions.node}｜Chromium=${process.versions.chrome}`);

      registerShellIpc({
        getInfo: () => ({
          productName: PRODUCT_NAME,
          appVersion: app.getVersion(),
          electron: process.versions.electron,
          node: process.versions.node,
          chrome: process.versions.chrome,
          stage: getStage(),
          serverUrl: runtime.server?.url ?? null,
          agentDir: runtime.agentDir,
          piDistRoot: runtime.artifact?.piDistRoot ?? null,
          logFile: getLogFilePath(),
        }),
        getAppOrigin: () => (runtime.server ? new URL(runtime.server.url).origin : null),
        openLog: async () => {
          const { shell } = await import('electron');
          const file = getLogFilePath();
          if (file) await shell.openPath(file);
        },
        openSessionDir: async () => {
          const { shell } = await import('electron');
          if (runtime.agentDir) await shell.openPath(runtime.agentDir);
        },
        checkForUpdates,
        retry: boot,
        quit: () => app.quit(),
      });

      const win = createMainWindow({
        getAppOrigin: () => (runtime.server ? new URL(runtime.server.url).origin : null),
      });

      // 关窗前：若最近 60 s 内有会话写入，给一次确认（agent 可能仍在跑）。
      win.on('close', (event) => {
        if (runtime.quitConfirmed || runtime.quitting) return;
        if (!runtime.agentDir) return;
        const active = hasRecentActivity(join(runtime.agentDir, 'sessions'), 60_000);
        if (!active) return;
        event.preventDefault();
        void dialog
          .showMessageBox(win, {
            type: 'warning',
            title: '会话可能仍在运行',
            message: '检测到最近 1 分钟内有会话活动，关闭应用会中断正在执行的 agent 回合。',
            buttons: ['仍然关闭', '取消'],
            defaultId: 1,
            cancelId: 1,
          })
          .then((choice) => {
            if (choice.response === 0) {
              runtime.quitConfirmed = true;
              win.close();
            }
          });
      });

      createTray(trayActions());
      await boot();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length > 0) {
        showMainWindow();
        return;
      }
      const revived = createMainWindow({
        getAppOrigin: () => (runtime.server ? new URL(runtime.server.url).origin : null),
      });
      if (runtime.server) {
        void installAuthForWindow(revived, runtime.server)
          .then(() => loadPiWebUi(revived, runtime.server?.url ?? ''))
          .catch((err) => failVisible('重建窗口后加载失败', err));
      } else {
        void boot();
      }
    });

    app.on('window-all-closed', () => {
      app.quit();
    });

    app.on('before-quit', (event) => {
      const beginAt = Date.now();
      if (runtime.quitting) return;

      const needCleanup = runtime.server !== null || runtime.stopNotifications !== null;
      if (!needCleanup) return;

      runtime.quitting = true;
      event.preventDefault();
      logInfo('开始优雅退出（关闭服务端 → 停止会话尾随 → 退出）');
      Promise.resolve()
        .then(async () => {
          runtime.stopNotifications?.();
          runtime.stopNotifications = null;
          await closeWithDeadline(runtime.server, SHUTDOWN_DEADLINE_MS);
          runtime.server = null;
        })
        .catch((err) => logWarn(`退出清理失败（继续退出）：${describeError(err)}`))
        .finally(() => {
          destroyTray();
          logShutdownSnapshot(beginAt);
          app.quit();
        });
    });
  }
}
