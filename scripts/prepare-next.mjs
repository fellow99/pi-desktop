#!/usr/bin/env node
/**
 * ① prepare-next.mjs — 构建 pi-web 生产产物（module 010-build-pipeline）
 *
 * 用法：
 *   node scripts/prepare-next.mjs [--source <pi-web 目录>] [--no-install] [--force-install] [--skip-build]
 *
 * 纪律：
 *   - **只读源码、只写构建产物**：不修改 `../pi-web` 的任何源码文件；
 *     `npm ci` 与 `next build` 是上游既有的两个步骤，本脚本只负责调用与校验。
 *   - 裁剪（删除非目标平台的 prebuilds / `.next/cache`）**不在这里做**：
 *     必须在 `collect-pi.mjs` 产出的**副本**上做（🔶 沿用 pi-desktop-hos 的修正结论：
 *     直接删源目录会让 Next 在启动时尝试联网补下载）。
 *   - 预览密钥轮换同样在副本上做（见 collect-pi.mjs），避免污染源码目录。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_PARENT = resolve(ROOT, '..');

function parseArgs(argv) {
  const args = { source: join(REPO_PARENT, 'pi-web'), install: true, forceInstall: false, build: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') args.source = resolve(argv[++i]);
    else if (arg === '--no-install') args.install = false;
    else if (arg === '--force-install') args.forceInstall = true;
    else if (arg === '--skip-build') args.build = false;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/prepare-next.mjs [--source <pi-web 目录>] [--no-install] [--force-install] [--skip-build]');
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return args;
}

/** Windows 上 .cmd 需要 shell；其它平台直接 spawn（并对含空格的参数加引号）。 */
function run(command, commandArgs, options = {}) {
  const useShell = process.platform === 'win32';
  const quoted = useShell
    ? commandArgs.map((value) => (/[\s"]/.test(value) ? `"${String(value).replace(/"/g, '\\"')}"` : value))
    : commandArgs;
  console.log(`\n$ ${command} ${quoted.join(' ')}${options.cwd ? `   (cwd=${options.cwd})` : ''}`);
  const result = spawnSync(command, quoted, { stdio: 'inherit', shell: useShell, ...options, cwd: options.cwd });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`命令失败（exit=${result.status}）：${command} ${quoted.join(' ')}`);
  }
}

function dirSizeBytes(dir) {
  let bytes = 0;
  let files = 0;
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
          /* 忽略瞬时消失的文件 */
        }
      }
    }
  }
  return { bytes, files };
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function verifyArtifacts(source) {
  const required = [
    join(source, '.next', 'BUILD_ID'),
    join(source, '.next', 'required-server-files.json'),
    join(source, '.next', 'server'),
    join(source, 'node_modules', 'next', 'dist', 'server', 'lib', 'start-server.js'),
    join(source, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'index.js'),
    join(source, 'bin', 'rotate-preview-secrets.js'),
  ];
  const missing = required.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(`pi-web 产物不完整，缺少：\n  - ${missing.join('\n  - ')}`);
  }
  const buildId = readFileSync(join(source, '.next', 'BUILD_ID'), 'utf8').trim();
  console.log(`产物校验通过：BUILD_ID = ${buildId}`);
  return buildId;
}

/**
 * 原生依赖完整性校验（FR-010-027，fail-visible）。
 *
 * 为什么必须有：`node-pty` 的 install 脚本是 `node scripts/prebuild.js || node-gyp rebuild`，
 * 而它只看 `prebuilds/<platform>-<arch>/` **目录是否存在** —— 目录存在但没有 `.node`（本机 2026-10-13
 * 实测到的形态）时它会 `exit 0`，于是 npm 跳过 `node-gyp rebuild`，运行期才在终端上炸：
 * `Failed to load native module: conpty.node … Cannot find module './prebuilds/win32-x64/conpty.node'`（HTTP 500）。
 * 构建期硬失败，把它变成一条能照做的报错。
 */
function verifyNativeDeps(source) {
  const triple = `${process.platform}-${process.arch}`;
  const pkg = 'node-pty';
  const pkgRoot = join(source, 'node_modules', pkg);
  if (!existsSync(pkgRoot)) {
    throw new Error(`原生依赖缺失：${pkgRoot} 不存在（先跑 npm ci）`);
  }
  const releaseDir = join(pkgRoot, 'build', 'Release');
  const releaseNodes = existsSync(releaseDir) ? readdirSync(releaseDir).filter((f) => f.endsWith('.node')) : [];
  const prebuildDir = join(pkgRoot, 'prebuilds', triple);
  const prebuildNodes = existsSync(prebuildDir) ? readdirSync(prebuildDir).filter((f) => f.endsWith('.node')) : [];
  if (releaseNodes.length === 0 && prebuildNodes.length === 0) {
    throw new Error(
      `原生依赖不完整：${pkg} 在 ${triple} 上既没有 build/Release/*.node，也没有 prebuilds/${triple}/*.node`
        + '（上游的 prebuild.js 只看目录是否存在，空目录会被误判为「已预构建」而跳过 node-gyp）。'
        + `修法：删除 ${prebuildDir} 后重跑 \`npm ci\`（上游发布包内含本平台的预构建）；`
        + `或 \`npm_config_build_from_source=true npm rebuild ${pkg}\` 从源码重建（需 C++ 工具链）。`,
    );
  }
  const where = releaseNodes.length > 0
    ? `build/Release（${releaseNodes.join(', ')}）`
    : `prebuilds/${triple}（${prebuildNodes.join(', ')}）`;
  console.log(`[pi-desktop][prepare-next] 原生依赖校验通过：${pkg} ${triple} → ${where}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const source = args.source;
  console.log('[pi-desktop][prepare-next] 源目录 =', source);

  const pkgPath = join(source, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(`未找到 pi-web（${pkgPath}）。请确认 sibling 布局：<workspace>/pi-web 与本工程平级。`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  console.log(`[pi-desktop][prepare-next] pi-web ${pkg.name}@${pkg.version}｜next=${pkg.dependencies?.next ?? '?'}`);

  const nodeModules = join(source, 'node_modules');
  const needInstall = args.forceInstall || !existsSync(nodeModules) || !existsSync(join(nodeModules, 'next'));
  if (args.install && needInstall) {
    run('npm', ['ci'], { cwd: source });
  } else if (args.install) {
    console.log('[pi-desktop][prepare-next] node_modules 已存在，跳过 npm ci（--force-install 可强制重装）');
  } else {
    console.log('[pi-desktop][prepare-next] --no-install：跳过依赖安装');
  }

  // 原生依赖完整性：放在 npm ci 之后、next build 之前 —— 坏安装立刻失败，不浪费一次构建（FR-010-027）。
  verifyNativeDeps(source);

  if (args.build) {
    run('node', [join('node_modules', 'next', 'dist', 'bin', 'next'), 'build', '--webpack'], { cwd: source });
  } else {
    console.log('[pi-desktop][prepare-next] --skip-build：跳过 next build');
  }

  const buildId = verifyArtifacts(source);
  const nextStats = dirSizeBytes(join(source, '.next'));
  const nmStats = dirSizeBytes(nodeModules);
  console.log(
    `[pi-desktop][prepare-next] 完成：.next = ${mb(nextStats.bytes)} / ${nextStats.files} 文件｜` +
      `node_modules = ${mb(nmStats.bytes)} / ${nmStats.files} 文件｜BUILD_ID = ${buildId}`,
  );
}

try {
  main();
} catch (error) {
  console.error(`[pi-desktop][prepare-next] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
