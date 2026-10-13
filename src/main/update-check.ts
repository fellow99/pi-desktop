import { app } from 'electron';
import { shell } from 'electron';

import { DEFAULT_UPDATE_FEED, UPDATE_CHECK_TIMEOUT_MS } from './constants';
import { describeError, logInfo, logWarn } from './logger';

/**
 * 检查更新（module 011-release-update，已决策 Q5 = 半自动）。
 *
 * 行为：查询更新源 → 比较语义化版本 → 有新版则**打开下载页**（不自动下载、不静默安装）。
 * 数据源可用 `PI_DESKTOP_UPDATE_FEED` 覆盖（⬜ 待定：GitHub Releases API 还是
 * pi-desktop-website 的静态 feed，见 docs/工程规划.md §11.3）。
 */

export type UpdateCheckResult = {
  status: 'update-available' | 'up-to-date' | 'error';
  current: string;
  latest?: string;
  url?: string;
  message?: string;
};

function parseVersion(raw: string): number[] {
  return raw
    .trim()
    .replace(/^v/i, '')
    .split(/[.\-+]/)
    .map((part) => Number.parseInt(part, 10))
    .map((num) => (Number.isFinite(num) ? num : 0));
}

function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  const current = app.getVersion();
  const feed = process.env.PI_DESKTOP_UPDATE_FEED || DEFAULT_UPDATE_FEED;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);

  try {
    logInfo(`检查更新：feed=${feed}｜当前版本=${current}`);
    const res = await fetch(feed, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': `pi-desktop/${current}` },
    });
    if (!res.ok) {
      const message = `更新源返回 HTTP ${res.status}`;
      logWarn(message);
      return { status: 'error', current, message };
    }
    const payload = (await res.json()) as {
      tag_name?: string;
      name?: string;
      html_url?: string;
      url?: string;
      version?: string;
    };
    const latest = payload.tag_name ?? payload.version ?? payload.name ?? '';
    const url = payload.html_url ?? payload.url ?? '';
    if (!latest) {
      const message = '更新源响应缺少版本字段';
      logWarn(message);
      return { status: 'error', current, message };
    }
    if (isNewer(latest, current)) {
      logInfo(`发现新版本：${latest}（当前 ${current}）`);
      return { status: 'update-available', current, latest, url };
    }
    logInfo(`已是最新版本（${current}）`);
    return { status: 'up-to-date', current, latest, url };
  } catch (err) {
    const message = describeError(err).split('\n')[0];
    logWarn(`检查更新失败（不阻塞）：${message}`);
    return { status: 'error', current, message };
  } finally {
    clearTimeout(timer);
  }
}

export async function openDownloadPage(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) {
    logWarn(`非 http(s) 下载地址，忽略：${url}`);
    return;
  }
  await shell.openExternal(url);
}
