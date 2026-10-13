#!/usr/bin/env node
/**
 * ③ collect-pi.mjs — 组装 pi-dist 并打包为 `pi-dist.tar.gz`（module 009/010）
 *
 * 用法：
 *   node scripts/collect-pi.mjs [--source <pi-web 目录>] [--out <dir>] [--keep-staging]
 *                              [--all-platforms] [--no-rotate] [--no-tar]
 *
 * 产出（全部在 `--out`，默认本工程根）：
 *   - `pi-dist/`            组装好的运行产物（staging；--keep-staging 保留，默认保留）
 *   - `pi-dist.tar.gz`      ustar 归档，条目前缀 `pi-dist/`
 *   - `pi-dist.version`     归档 SHA-256（运行时的幂等 marker 比对基准）
 *
 * 为什么是 tar.gz 而不是原始目录（已决策 Q3，见 docs/工程规划.md §8.3）：
 *   1) 安装包只增约 116 MB（同源实测 682 MB → 115.9 MB）；
 *   2) 解压目标是 `<userData>/pi-dist`，**可写** → 预览密钥能轮换
 *      （只读的 resources 目录会保留构建期固化的密钥，留下 x-prerender-revalidate 绕过口子）；
 *   3) SHA-256 marker 语义明确：归档变了就必须重解压（不会出现「就地升级不生效」）。
 *
 * 裁剪（只作用于副本）：
 *   - 删除 `.next/cache`（构建缓存，运行不需要）；
 *   - node-pty 只保留目标平台的 prebuilds（`--all-platforms` 时全部保留；
 *     CI 每个平台各自构建自己的产物，不做交叉打包）。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRepoBranding, applyWebBranding, assertNoBrandLeftovers, loadMaterial } from './brand-assets.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_PARENT = resolve(ROOT, '..');
const STAGING_NAME = 'pi-dist';

function parseArgs(argv) {
  const args = {
    source: join(REPO_PARENT, 'pi-web'),
    out: ROOT,
    keepStaging: true,
    allPlatforms: false,
    rotate: true,
    tar: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') args.source = resolve(argv[++i]);
    else if (arg === '--out') args.out = resolve(argv[++i]);
    else if (arg === '--no-keep-staging') args.keepStaging = false;
    else if (arg === '--all-platforms') args.allPlatforms = true;
    else if (arg === '--no-rotate') args.rotate = false;
    else if (arg === '--no-tar') args.tar = false;
    else if (arg === '--assets') args.assets = resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法：node scripts/collect-pi.mjs [--source <pi-web>] [--out <dir>] [--no-keep-staging] [--all-platforms] [--no-rotate] [--no-tar] [--assets <品牌物料目录>]',
      );
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function log(message) {
  console.log(`[pi-desktop][collect-pi] ${message}`);
}

function fail(message, error) {
  console.error(`[pi-desktop][collect-pi] 失败：${message}${error ? ` — ${error.message ?? error}` : ''}`);
  process.exit(1);
}

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        files += 1;
        try {
          bytes += statSync(full).size;
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  return { files, bytes };
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function targetPlatformDirs() {
  const platform = process.platform === 'win32' ? 'win32' : process.platform;
  const arch = process.arch === 'x64' ? 'x64' : process.arch;
  return new Set([`${platform}-${arch}`]);
}

function copyTopLevel(source, staging, name) {
  const from = join(source, name);
  if (!existsSync(from)) return false;
  cpSync(from, join(staging, name), { recursive: true, dereference: false });
  return true;
}

/** 组装 staging（pi-dist） */
function assemble(source, staging, args) {
  if (existsSync(staging)) {
    log(`清理旧 staging：${staging}`);
    rmSync(staging, { recursive: true, force: true });
  }
  mkdirSync(staging, { recursive: true });

  for (const entry of ['package.json', 'next.config.ts', 'bin', 'public']) {
    const copied = copyTopLevel(source, staging, entry);
    log(`${copied ? '已复制' : '跳过（源目录不存在）'}：${entry}`);
  }
  if (!existsSync(join(source, 'package.json'))) fail('源目录缺少 package.json（不是 pi-web？）');

  // .next：排除构建缓存（cache/ 与 diagnostics/ 运行时都不需要）
  cpSync(join(source, '.next'), join(staging, '.next'), {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(join(source, '.next').length).replace(/\\/g, '/');
      return !rel.startsWith('/cache') && !rel.startsWith('/diagnostics');
    },
  });
  log('已复制：.next（已排除 cache/ 与 diagnostics/）');

  // node_modules：排除明显与运行无关的目录，并在复制后按平台裁剪 prebuilds
  cpSync(join(source, 'node_modules'), join(staging, 'node_modules'), {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(join(source, 'node_modules').length).replace(/\\/g, '/');
      if (rel.startsWith('/.cache')) return false;
      return true;
    },
  });
  log('已复制：node_modules');
}

/** 按目标平台裁剪（只作用于 staging 副本） */
function prune(staging, args) {
  const keep = targetPlatformDirs();
  const prebuildRoots = [
    join(staging, 'node_modules', 'node-pty', 'prebuilds'),
    join(staging, 'node_modules', '@earendil-works', 'pi-tui', 'prebuilds'),
  ];
  let removed = 0;
  for (const root of prebuildRoots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (args.allPlatforms || keep.has(entry.name)) continue;
      rmSync(join(root, entry.name), { recursive: true, force: true });
      removed += 1;
    }
  }
  log(`prebuilds 裁剪：删除 ${removed} 个非本平台目录（--all-platforms 可保留全部）`);
  for (const root of prebuildRoots) {
    if (!existsSync(root)) continue;
    const kept = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    log(`保留的 prebuilds（${root.replace(staging, '<staging>')}）：${kept.length > 0 ? kept.join(', ') : '(无)'}`);
  }
}

/** 预览密钥轮换：复用上游脚本，作用于 staging 副本 */
function rotate(staging) {
  const rotatePath = join(staging, 'bin', 'rotate-preview-secrets.js');
  if (!existsSync(rotatePath)) fail(`上游密钥轮换脚本缺失：${rotatePath}`);
  const script = `
    const mod = require(${JSON.stringify(rotatePath)});
    if (typeof mod.rotatePreviewSecrets !== 'function') {
      console.error('[pi-desktop][collect-pi] rotate-preview-secrets.js 未导出 rotatePreviewSecrets');
      process.exit(3);
    }
    const result = mod.rotatePreviewSecrets(${JSON.stringify(join(staging, '.next'))});
    if (result && result.ok) { console.log('[pi-desktop][collect-pi] 预览密钥已轮换'); process.exit(0); }
    const warning = typeof mod.getRotationWarning === 'function'
      ? mod.getRotationWarning(result && result.reason)
      : '原因：' + (result && result.reason);
    console.error('[pi-desktop][collect-pi] 预览密钥轮换失败：' + warning);
    process.exit(4);
  `;
  const result = spawnSync(process.execPath, ['-e', script], { stdio: 'inherit' });
  if (result.status !== 0) {
    log('⚠️ 预览密钥轮换未成功：运行时（host.ts）还会再轮换一次；若运行时目录不可写则必须修掉此问题（安全）。');
  }
}

/** 壳预置模板：随包投放（运行时由 settings.ts 只补缺失文件） */
function materializePresets(staging) {
  const presetDir = join(staging, 'resources', 'pi-agent');
  mkdirSync(presetDir, { recursive: true });
  for (const name of ['settings.json', 'mcp.json']) {
    const from = join(ROOT, 'config', name);
    if (!existsSync(from)) {
      log(`预置模板缺失（跳过）：${from}`);
      continue;
    }
    cpSync(from, join(presetDir, name));
    log(`已投放预置模板：resources/pi-agent/${name}`);
  }
}

async function tarball(args, staging) {
  const tarName = 'pi-dist.tar.gz';
  const tarPath = join(args.out, tarName);
  if (existsSync(tarPath)) rmSync(tarPath, { force: true });

  const tarBin = process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  // `--dereference`（GNU tar 与 bsdtar 都支持；`-L` 在 GNU tar 是别的含义，故用长选项）：
  //   ustar 的 linkname 字段上限 100 字节，而 npm 在 POSIX 上会为 CLI 生成**符号链接**（`node_modules/**/bin/*`），
  //   其目标字符串在深层嵌套下会超长 → GNU tar 报 `link name is too long; not dumped` 并以退出码 2 失败
  //   （2026-10-13 CI 的 ubuntu 作业实测；Windows/macOS 的 bsdtar 不报错）。
  //   解引用后存为**普通文件**，内容与权限位不变，运行期不需要这些 CLI 影子文件，因此语义无损；
  //   `pi-web` 的 lockfile 无 `link:`/`file:` 依赖 ⇒ 树里不存在目录级符号链接，解引用不会复制整棵子树。
  const tarArgs = ['-czf', tarPath, '--format=ustar', '--dereference', '-C', dirname(staging), STAGING_NAME];
  log(`打包：${tarBin} ${tarArgs.join(' ')}`);
  const result = spawnSync(tarBin, tarArgs, { stdio: 'inherit' });
  if (result.error) fail('调用 tar 失败（Windows 需 System32\\tar.exe）', result.error);
  if (result.status !== 0) fail(`tar 退出码 = ${result.status}`);
  if (!existsSync(tarPath)) fail(`tar 未产出归档：${tarPath}`);

  const digest = await new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(tarPath);
    stream.on('error', rejectHash);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
  writeFileSync(join(args.out, 'pi-dist.version'), `${digest}\n`, 'utf8');
  log(`pi-dist.version 已写入：${digest}`);
  return { tarPath, digest };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(join(args.source, '.next', 'BUILD_ID'))) {
    fail(`未找到 pi-web 生产产物（${join(args.source, '.next')}）。请先执行：node scripts/prepare-next.mjs`);
  }

  const staging = join(args.out, STAGING_NAME);
  assemble(args.source, staging, args);
  prune(staging, args);
  if (args.rotate) rotate(staging);
  materializePresets(staging);

  // 品牌化（module 012-branding，spec FR-012-001…009）：只作用在 staging 副本上，上游零改动；
  // 顺序放在预置资源投放之后，并紧跟全树终检（预置目录里的旧品牌文案也能兜住）。
  const brandingMaterial = loadMaterial(args.assets ? ['--assets', args.assets] : []);
  log('品牌化 staging（文案 / 页面 Logo / web 图标 / favicon）…');
  applyRepoBranding({ material: brandingMaterial });
  applyWebBranding(staging, { material: brandingMaterial });
  assertNoBrandLeftovers(staging);

  const stats = dirStats(staging);
  log(`staging 统计：${stats.files} 个文件 / ${mb(stats.bytes)}`);

  if (!args.tar) {
    log('--no-tar：跳过打包与 marker 写入');
    return;
  }
  const { tarPath, digest } = await tarball(args, staging);
  const tarBytes = statSync(tarPath).size;
  log(`完成：${tarPath} = ${mb(tarBytes)}｜SHA-256 = ${digest}`);
  if (!args.keepStaging) {
    rmSync(staging, { recursive: true, force: true });
    log('已删除 staging（--no-keep-staging）');
  }
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), error);
}
