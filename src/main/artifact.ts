import { app } from 'electron';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ARCHIVE_NAME, MARKER_NAME, VERSION_NAME } from './constants';
import { describeError, logInfo, logWarn } from './logger';
import { extractTarGz } from './tar-extract';

/**
 * 产物引导（module 009-artifact-bootstrap）：
 *   `pi-dist.tar.gz`（构建期打包的 pi-web 运行产物）→ 首启流式解压到 `<userData>/pi-dist`。
 *
 * 幂等判据：`<userData>/pi-dist.sha256` 的内容 === `pi-dist.version`（归档 SHA-256）。
 * ⚠️ 不要退化成「目录存在即跳过」——那会让**就地升级不生效**（参考工程真机踩坑）。
 */

export type ArtifactState = {
  /** 归档路径（打包态在 process.resourcesPath，开发态在仓库根）。 */
  archivePath: string;
  /** 解压根目录。 */
  piDistRoot: string;
  /** marker 文件路径。 */
  markerPath: string;
  /** 已确认可用的 Next 入口（startServer 所在文件）。 */
  nextEntry: string | null;
};

export function resolveArchivePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, ARCHIVE_NAME)
    : join(app.getAppPath(), ARCHIVE_NAME);
}

/** 开发调试出口：直接指定已解压的 pi-dist 目录（跳过解压）。 */
export function resolveEnvPiDist(): string | null {
  const raw = process.env.PI_DESKTOP_PI_DIST;
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  // 立刻解析成**绝对路径**：调用链后面 `startHost()` 会 `process.chdir(<产物根>)`（见 host.ts），
  // 若这里保留相对值，重试路径（boot → ensureArtifact → 本函数）会把它按**新的** cwd 解析而误报「目录不存在」。
  const dir = resolve(value);
  if (!existsSync(dir)) {
    throw new Error(`PI_DESKTOP_PI_DIST 指向的目录不存在：${dir}（已按启动时的 cwd 解析为绝对路径）`);
  }
  logInfo(`使用 PI_DESKTOP_PI_DIST 指定的产物目录：${dir}（跳过解压与 marker 校验）`);
  return dir;
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function readExpectedHash(versionPath: string): string | null {
  try {
    const raw = readFileSync(versionPath, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
    logWarn(`${VERSION_NAME} 内容不是 SHA-256，忽略：${raw.slice(0, 120)}`);
  } catch (err) {
    logWarn(`读取 ${VERSION_NAME} 失败：${describeError(err)}`);
  }
  return null;
}

function readMarker(markerPath: string): string | null {
  try {
    const raw = readFileSync(markerPath, 'utf8').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

function payloadEntryCandidates(piDistRoot: string): string[] {
  return [
    join(piDistRoot, 'node_modules', 'next', 'dist', 'server', 'lib', 'start-server.js'),
    join(piDistRoot, 'node_modules', 'next', 'dist', 'server', 'next.js'),
    join(piDistRoot, 'node_modules', 'next', 'dist', 'bin', 'next'),
  ];
}

/** 解压完整性的关键断言：marker 命中也要查（解压中途被杀会留下「看似完整」的树）。 */
export function assertPayloadComplete(piDistRoot: string, where: string): string {
  const candidates = payloadEntryCandidates(piDistRoot);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`${where}：pi-dist 缺少 Next 服务入口（已探测 ${candidates.length} 处）`);
  }
  const piPkg = join(piDistRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js');
  if (!existsSync(piPkg)) throw new Error(`${where}：缺少 ${piPkg}`);
  return found;
}

/**
 * 确保产物就位。返回的 `nextEntry` 供 host.ts 起服务。
 * 失败必须抛出（调用方 failVisible，绝不静默）。
 */
export async function ensureArtifact(userData: string): Promise<ArtifactState> {
  const state: ArtifactState = {
    archivePath: resolveArchivePath(),
    piDistRoot: join(userData, 'pi-dist'),
    markerPath: join(userData, MARKER_NAME),
    nextEntry: null,
  };

  const envDir = resolveEnvPiDist();
  if (envDir) {
    state.piDistRoot = envDir;
    state.nextEntry = assertPayloadComplete(envDir, 'PI_DESKTOP_PI_DIST 校验');
    return state;
  }

  const versionPath = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), VERSION_NAME);
  if (!existsSync(state.archivePath)) {
    throw new Error(
      `产物归档缺失：${state.archivePath}\n` +
        '请先执行 `node scripts/prepare-next.mjs && node scripts/collect-pi.mjs`（或设置 PI_DESKTOP_PI_DIST 指向已解压目录）。',
    );
  }

  const actual = await sha256File(state.archivePath);
  const declared = readExpectedHash(versionPath);
  const expected = declared ?? actual;
  if (!declared) {
    logWarn(`未读到 ${VERSION_NAME}，marker 退化为「当前 tar 哈希」模式（tar 变化仍会触发重解压）：${expected}`);
  }
  const marker = readMarker(state.markerPath);
  logInfo(`归档 SHA-256 = ${actual}`);
  logInfo(`期望 SHA-256 = ${expected}｜marker = ${marker ?? '(无)'}`);

  if (marker === expected && existsSync(state.piDistRoot)) {
    try {
      state.nextEntry = assertPayloadComplete(state.piDistRoot, 'marker 命中');
      logInfo(`产物已就位（marker 一致），跳过解压；Next 入口 = ${state.nextEntry}`);
      return state;
    } catch (err) {
      logWarn(`marker 一致但产物不完整，强制重解压：${describeError(err)}`);
    }
  } else if (marker === expected) {
    logWarn(`marker 一致但目标目录不存在，重新解压：${state.piDistRoot}`);
  } else if (marker && marker !== expected) {
    logInfo('marker 与当前归档不一致（升级或换包），重新解压');
  }

  if (existsSync(state.piDistRoot)) {
    logInfo(`清理旧产物目录：${state.piDistRoot}`);
    rmSync(state.piDistRoot, { recursive: true, force: true });
  }
  mkdirSync(state.piDistRoot, { recursive: true });

  logInfo(`首次/升级解压 ${state.archivePath} → ${state.piDistRoot}（数万文件，请稍候）`);
  const startedAt = Date.now();
  const count = await extractTarGz(state.archivePath, state.piDistRoot);
  state.nextEntry = assertPayloadComplete(state.piDistRoot, '解压后校验');
  writeFileSync(state.markerPath, actual, 'utf8');
  logInfo(`解压完成：${count} 个文件，用时 ${Date.now() - startedAt} ms；marker 已写入 ${state.markerPath}`);
  logInfo(`Next 入口 = ${state.nextEntry}`);
  return state;
}
