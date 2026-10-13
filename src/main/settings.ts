import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SETTINGS_FILE_NAME } from './constants';
import { describeError, logInfo, logWarn } from './logger';

/**
 * 运行时配置（module 008-runtime-config）。
 *
 * 数据目录策略（已决策 Q6）：
 *   - `shared`（默认）：`~/.pi/agent` —— 与 `pi` CLI 共用凭据、会话、扩展、MCP 配置，桌面版
 *     因此「开箱就是你已经配好的 pi」；
 *   - `app`：`<userData>/pi-agent` —— 应用私有，隔离/企业场景的退路。
 *
 * ⚠️ 切换模式**必须重启应用**：宿主启动早期就要把该变量交给 pi-web，进程内热切换会让
 * 「配置文件来自 A、会话写到 B」这种半状态出现（宁可不支持，也不做半吊子）。
 */

export type AgentDirMode = 'shared' | 'app';

export type ShellSettings = {
  version: 1;
  agentDirMode: AgentDirMode;
};

const DEFAULTS: ShellSettings = { version: 1, agentDirMode: 'shared' };

function settingsPath(): string {
  return join(app.getPath('userData'), SETTINGS_FILE_NAME);
}

export function loadSettings(): ShellSettings {
  const file = settingsPath();
  if (!existsSync(file)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ShellSettings>;
    const mode: AgentDirMode = raw.agentDirMode === 'app' ? 'app' : 'shared';
    return { version: 1, agentDirMode: mode };
  } catch (err) {
    logWarn(`读取壳层设置失败，回退默认值：${describeError(err)}`);
    return { ...DEFAULTS };
  }
}

export function saveSettings(next: ShellSettings): void {
  const file = settingsPath();
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    logInfo(`壳层设置已写入：${file}（agentDirMode=${next.agentDirMode}）`);
  } catch (err) {
    logWarn(`写入壳层设置失败：${describeError(err)}`);
  }
}

/** 解析 pi 数据目录（`PI_CODING_AGENT_DIR` 的取值）。 */
export function resolveAgentDir(settings: ShellSettings): string {
  if (settings.agentDirMode === 'app') return join(app.getPath('userData'), 'pi-agent');
  return join(homedir(), '.pi', 'agent');
}

/**
 * 预置模板：**只在文件不存在时写入**（壳预置绝不覆盖用户改动）。
 * 键名与 pi 的 Settings 接口一致（pi/packages/coding-agent/src/core/settings-manager.ts）；
 * `defaultProjectTrust` 保持 "ask"，绝不改成 always（项目级扩展/MCP 需要用户显式信任）。
 */
export function materializePresetTemplates(agentDir: string, presetDir: string): void {
  const files: Array<{ name: string; content: string }> = [
    { name: 'settings.json', content: `${JSON.stringify({ packages: [], defaultProjectTrust: 'ask' }, null, 2)}\n` },
    { name: 'mcp.json', content: `${JSON.stringify({ mcpServers: {} }, null, 2)}\n` },
  ];

  for (const file of files) {
    const target = join(agentDir, file.name);
    if (existsSync(target)) {
      logInfo(`保留已有文件：${target}`);
      continue;
    }
    try {
      writeFileSync(target, file.content, 'utf8');
      logInfo(`已写入预置文件：${target}`);
    } catch (err) {
      logWarn(`写入预置文件失败（不阻塞启动）：${describeError(err)}`);
    }
  }

  logInfo(`预置模板源目录：${presetDir}（模板仅用于开发期对照与打包期投放，运行时以上述写入为准）`);
}

/** pi 数据目录必需的子目录（缺目录会让扩展/技能/session 相关功能静默失效）。 */
export function ensureAgentDirTree(agentDir: string): void {
  const dirs = [
    agentDir,
    join(agentDir, 'extensions'),
    join(agentDir, 'skills'),
    join(agentDir, 'prompts'),
    join(agentDir, 'themes'),
    join(agentDir, 'agents'),
    join(agentDir, 'sessions'),
  ];
  for (const dir of dirs) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      logWarn(`创建目录失败（不阻塞启动）：${dir} — ${describeError(err)}`);
    }
  }
}
