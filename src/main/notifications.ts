import { Notification } from 'electron';

import { NOTIFICATION_COOLDOWN_MS, PRODUCT_NAME } from './constants';
import { describeError, logInfo, logWarn } from './logger';
import { startSessionWatch, type AssistantMessageEvent } from './session-watch';

/**
 * 原生通知（module 004-notification）。
 *
 * 事件源 = 会话 JSONL 尾随（见 session-watch.ts 的说明）。
 * 策略（对齐 dsh 的取舍：只在**用户不在看**的时候打扰）：
 *   - 仅当主窗口**不可见或未聚焦**时弹通知；
 *   - 同一会话在冷却窗口（默认 10 s）内去重；
 *   - 启动前的历史内容不补弹（基线在 startSessionWatch 里建立）。
 *
 * 平台细节：Windows 需要 `app.setAppUserModelId(...)` 才能正确显示与归组（在 index.ts 里设置）。
 */

export type NotificationDeps = {
  sessionsDir: string;
  isWindowBackgrounded: () => boolean;
  focusWindow: () => void;
};

const lastNotifiedAt = new Map<string, number>();

function shouldNotify(sessionId: string): boolean {
  const now = Date.now();
  const last = lastNotifiedAt.get(sessionId) ?? 0;
  if (now - last < NOTIFICATION_COOLDOWN_MS) return false;
  lastNotifiedAt.set(sessionId, now);
  return true;
}

function show(event: AssistantMessageEvent, deps: NotificationDeps): void {
  const body = event.text.length > 0 ? event.text : '助手已完成本轮回复';
  try {
    const notification = new Notification({
      title: `${PRODUCT_NAME} — 有新的助手回复`,
      body,
      silent: false,
    });
    notification.on('click', () => deps.focusWindow());
    notification.show();
    logInfo(`已弹出通知（session=${event.sessionId}）：${body.slice(0, 60)}`);
  } catch (err) {
    logWarn(`通知发送失败（不阻塞）：${describeError(err)}`);
  }
}

/** 注册通知；返回停止函数（应用退出时调用）。 */
export function setupNotifications(deps: NotificationDeps): () => void {
  const stop = startSessionWatch({
    sessionsDir: deps.sessionsDir,
    onAssistantMessage: (event) => {
      if (!deps.isWindowBackgrounded()) return;
      if (!shouldNotify(event.sessionId)) return;
      show(event, deps);
    },
  });
  logInfo('原生通知已启用（事件源：会话 JSONL 尾随）');
  return stop;
}
