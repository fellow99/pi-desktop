/**
 * 中枢服务设置 IPC（module 301-sync-daemon）。
 *
 * 设置 UI 位于 pi-web 设置对话框的 `sync` 分区（构建期补丁）。本模块只做两件事：
 *   - `pi-desktop:sync:get`   → 读取 `~/.pi-desktop/sync-daemon.json` + 当前状态；
 *   - `pi-desktop:sync:apply` → 校验并写回配置、按新配置（重）启动 daemon（复用 sync-daemon.ts）。
 *
 * 安全边界（module 104 纪律的延伸）：
 *   - preload 只在应用 http 源暴露 `window.piDesktopSync`，但**不信任** preload 判断；
 *     每次 IPC 都校验 `senderFrame` 的 origin 等于当前内嵌 pi-web 源，且是顶层 frame。
 *   - 非本应用源一律拒绝并记 WARN（不返回任何配置内容）。
 */

import { ipcMain } from 'electron';
import { hostname } from 'node:os';

import { describeError, logInfo, logWarn } from './logger';
import {
  applySyncConfig,
  getSyncStatus,
  loadSyncConfig,
  type SyncDaemonSettings,
  type SyncRuntimeOptions,
  type SyncStatus,
} from './sync-daemon';

const CHANNEL_GET = 'pi-desktop:sync:get';
const CHANNEL_APPLY = 'pi-desktop:sync:apply';

const DEFAULT_HOST_NAME = hostname() || 'pi-desktop';

let ipcRegistered = false;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * 只接受内嵌 pi-web 顶层 frame。origin 由入口的 getAppOrigin 提供（未就绪时为 null → 拒绝），
 * 不信任页面自报的任何来源。
 */
function assertAppFrame(event: Electron.IpcMainInvokeEvent, getOrigin: () => string | null): void {
  const origin = getOrigin();
  const frame = event.senderFrame;
  const frameOrigin = frame ? originOf(frame.url) : null;
  if (!origin || !frame || frameOrigin !== origin || frame.parent !== null) {
    logWarn(`[sync-settings] 已拒绝来源不明的 IPC 调用：${frame?.url || '(unknown)'}`);
    throw new Error('拒绝：非法调用来源');
  }
}

/**
 * 注册中枢服务设置 IPC（app ready 后调用一次）。
 * `getRuntime` / `getOrigin` 由入口注入（内嵌 pi-web 就绪后才非 null），避免反向 import index.ts。
 */
export function registerSyncSettingsIpc(
  getRuntime: () => SyncRuntimeOptions | null,
  getOrigin: () => string | null,
): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle(CHANNEL_GET, async (event): Promise<{ settings: SyncDaemonSettings; status: SyncStatus }> => {
    assertAppFrame(event, getOrigin);
    const loaded = await loadSyncConfig();
    const settings: SyncDaemonSettings = loaded
      ? loaded.settings
      : { enabled: false, hubUrl: '', hostName: DEFAULT_HOST_NAME, hubToken: '' };
    return { settings, status: getSyncStatus() };
  });

  ipcMain.handle(CHANNEL_APPLY, async (event, payload: unknown): Promise<{ ok: true }> => {
    assertAppFrame(event, getOrigin);
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
    try {
      await applySyncConfig(settings, runtime);
    } catch (error) {
      logWarn(`[sync-settings] 应用失败：${describeError(error).split('\n')[0]}`);
      throw error;
    }
    return { ok: true };
  });

  logInfo('[sync-settings] 中枢服务设置 IPC 已注册');
}
