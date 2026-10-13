import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { LOG_DIR_NAME, LOG_PREFIX } from './constants';

/**
 * 统一日志（fail-visible 纪律的实现面）：
 *   - 控制台：带 `[pi-desktop]` 前缀，dev 直接可见；
 *   - 文件：`<userData>/logs/pi-desktop-<YYYY-MM-DD>.log`（用户可经托盘「打开日志」查看）；
 *   - 阶段：`setStage()` 记录当前启动阶段，供窗口标题与 loading 页显示。
 *
 * 纪律：**任何密钥都不入日志**（pi-web 的随机密码只打印长度）。
 */

type Level = 'info' | 'warn' | 'error';

let logFile: string | null = null;
let currentStage = '准备启动';

function ensureLogFile(): string | null {
  if (logFile) return logFile;
  try {
    const dir = join(app.getPath('userData'), LOG_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    logFile = join(dir, `pi-desktop-${day}.log`);
    return logFile;
  } catch {
    return null;
  }
}

export function getLogFilePath(): string | null {
  return ensureLogFile();
}

function write(level: Level, message: string): void {
  const line = `${new Date().toISOString()} ${LOG_PREFIX}[${level}] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  const file = ensureLogFile();
  if (!file) return;
  try {
    appendFileSync(file, line + '\n', 'utf8');
  } catch {
    /* 日志写失败不得影响主流程 */
  }
}

export function logInfo(message: string): void {
  write('info', message);
}

export function logWarn(message: string): void {
  write('warn', message);
}

export function logError(message: string): void {
  write('error', message);
}

/** 错误 → 可读文本（带栈，最多 12 行；未知值也能安全字符串化）。 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const stack = (err.stack ?? '').split('\n').slice(0, 12).join('\n');
    return `${err.name}: ${err.message}${stack ? `\n${stack}` : ''}`;
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function setStage(stage: string): void {
  currentStage = stage;
  logInfo(`[stage] ${stage}`);
}

export function getStage(): string {
  return currentStage;
}
