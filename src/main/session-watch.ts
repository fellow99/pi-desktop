import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { SESSION_WATCH_INTERVAL_MS } from './constants';
import { describeError, logInfo, logWarn } from './logger';

/**
 * 会话文件尾随（module 004-notification 的事件源）。
 *
 * 为什么不用渲染层/上游钩子（docs/工程规划.md §5.4）：
 *   `pi-web` 的事件只经 SSE 暴露给**渲染层**，主进程没有现成钩子；而 dsh 那种
 *   「宿主进程内事件流」在本工程对应的是「会话 JSONL 落盘」。
 *   尾随文件的好处：**零上游补丁**、不耦合 pi-web 内部模块、与窗口可见性/渲染进程状态无关。
 *
 * 基线语义：启动时先记录每个会话文件的**当前大小**，只对之后的增量触发事件 →
 * 应用启动不会为历史消息补弹通知。
 */

export type AssistantMessageEvent = {
  sessionFile: string;
  sessionId: string;
  projectDir: string;
  text: string;
};

type FileCursor = { offset: number; remainder: string };

const cursors = new Map<string, FileCursor>();
let timer: ReturnType<typeof setInterval> | null = null;

function listSessionFiles(sessionsDir: string): string[] {
  const files: string[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(sessionsDir, entry.name));
  } catch {
    return files;
  }
  for (const dir of projectDirs) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(join(dir, entry.name));
      }
    } catch {
      /* 目录可能在扫描期间被删除：忽略 */
    }
  }
  return files;
}

function parseAssistantLine(line: string): { text: string } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as { type?: unknown; message?: { role?: unknown; content?: unknown } };
  if (record.type !== 'message') return null;
  const message = record.message;
  if (!message || message.role !== 'assistant') return null;

  // content 可能是字符串或分块数组（text / tool_use 等）；只取文本块用于通知摘要。
  let text = '';
  const content = message.content;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return { text };
}

function consumeAppended(appFile: string, cursor: FileCursor, onMessage: (event: AssistantMessageEvent) => void): void {
  let content: string;
  let size: number;
  try {
    size = statSync(appFile).size;
  } catch {
    return;
  }
  if (size < cursor.offset) {
    // 文件被截断/重建（改会话）：重置游标，不解析旧内容。
    cursor.offset = size;
    cursor.remainder = '';
    return;
  }
  if (size === cursor.offset) return;

  try {
    const fdContent = readFileSync(appFile);
    content = fdContent.subarray(cursor.offset, size).toString('utf8');
  } catch (err) {
    logWarn(`读取会话增量失败：${appFile} — ${describeError(err)}`);
    return;
  }
  cursor.offset = size;

  const combined = cursor.remainder + content;
  const lines = combined.split('\n');
  cursor.remainder = lines.pop() ?? '';

  const parts = appFile.split(/[\\/]/);
  const sessionFile = parts[parts.length - 1] ?? 'session.jsonl';
  const projectDir = parts[parts.length - 2] ?? '';
  const sessionId = sessionFile.replace(/\.jsonl$/, '');

  for (const line of lines) {
    const parsed = parseAssistantLine(line);
    if (!parsed) continue;
    onMessage({
      sessionFile: appFile,
      sessionId,
      projectDir,
      text: parsed.text.replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }
}

/**
 * 开始尾随。返回停止函数。
 * ⬜ 待验证（探针 P0-5）：JSONL 的落盘时机（turn 结束 vs 流式增量）与通知延迟。
 */
export function startSessionWatch(options: {
  sessionsDir: string;
  onAssistantMessage: (event: AssistantMessageEvent) => void;
}): () => void {
  stopSessionWatch();

  // 建立基线：记录现有文件大小，不解析历史内容。
  for (const file of listSessionFiles(options.sessionsDir)) {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      size = 0;
    }
    cursors.set(file, { offset: size, remainder: '' });
  }
  logInfo(`会话尾随已启动：${options.sessionsDir}（基线 ${cursors.size} 个会话文件）`);

  timer = setInterval(() => {
    for (const file of listSessionFiles(options.sessionsDir)) {
      let cursor = cursors.get(file);
      if (!cursor) {
        cursor = { offset: 0, remainder: '' };
        cursors.set(file, cursor);
      }
      consumeAppended(file, cursor, options.onAssistantMessage);
    }
  }, SESSION_WATCH_INTERVAL_MS);

  return stopSessionWatch;
}

export function stopSessionWatch(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  cursors.clear();
  logInfo('会话尾随已停止');
}

/** 最近 `withinMs` 内是否有会话写入（用于关窗前的「会话可能仍在运行」确认）。 */
export function hasRecentActivity(sessionsDir: string, withinMs: number): boolean {
  const threshold = Date.now() - withinMs;
  for (const file of listSessionFiles(sessionsDir)) {
    try {
      if (statSync(file).mtimeMs >= threshold) return true;
    } catch {
      /* 忽略 */
    }
  }
  return false;
}
