import { app, screen, type BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  WINDOW_STATE_FILE_NAME,
} from './constants';
import { describeError, logError, logInfo } from './logger';

/**
 * 窗口状态记忆与全屏快捷键（module 002-window 的一部分）。
 * 🔶 沿用 dsh-desktop 的范式：防抖 400 ms、`getNormalBounds()`、多显示器可见性校验、
 * 异常状态一律回退默认值（绝不把窗口恢复到看不见的地方）。
 */

export type WindowState = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
};

function statePath(): string {
  return join(app.getPath('userData'), WINDOW_STATE_FILE_NAME);
}

function isVisibleOnSomeDisplay(bounds: { x: number; y: number; width: number; height: number }): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapX = Math.max(
      0,
      Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x),
    );
    const overlapY = Math.max(
      0,
      Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y),
    );
    return overlapX > 0 && overlapY > 0;
  });
}

export function loadWindowState(): WindowState {
  const fallback: WindowState = {
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    isMaximized: false,
  };
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<WindowState>;
    const width = typeof raw.width === 'number' && raw.width >= MIN_WINDOW_WIDTH ? raw.width : fallback.width;
    const height = typeof raw.height === 'number' && raw.height >= MIN_WINDOW_HEIGHT ? raw.height : fallback.height;
    const state: WindowState = { width, height, isMaximized: raw.isMaximized === true };
    if (
      typeof raw.x === 'number' &&
      typeof raw.y === 'number' &&
      isVisibleOnSomeDisplay({ x: raw.x, y: raw.y, width, height })
    ) {
      state.x = raw.x;
      state.y = raw.y;
    }
    return state;
  } catch {
    return fallback;
  }
}

function saveWindowState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try {
    const bounds = win.getNormalBounds();
    const file = statePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          isMaximized: win.isMaximized(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch (err) {
    logError(`保存窗口状态失败：${describeError(err)}`);
  }
}

/** 防抖登记窗口状态（resize/move/maximize/unmaximize 共用一个 400 ms 计时器）。 */
export function trackWindowState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => saveWindowState(win), 400);
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', () => {
    if (timer) clearTimeout(timer);
    saveWindowState(win);
    logInfo(`窗口状态已保存：${statePath()}`);
  });
}

/** F11 全屏切换（🔶 dsh 范式：拦 before-input-event，避免与页面快捷键冲突）。 */
export function installFullscreenShortcut(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.code === 'F11' || input.key === 'F11')) {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });
}
