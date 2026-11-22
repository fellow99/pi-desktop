#!/usr/bin/env node
/**
 * patches.mjs — 上游补丁的应用 / 回退 / 状态查询（module 012-building-workflow）。
 *
 * 用法：
 *   node scripts/patches.mjs status  [--source <pi-web 目录>] [--tag <vX.Y.Z>]
 *   node scripts/patches.mjs apply   [--source <pi-web 目录>] [--tag <vX.Y.Z>]
 *   node scripts/patches.mjs revert  [--source <pi-web 目录>] [--tag <vX.Y.Z>]
 *
 * 纪律（与 pi-desktop-hos/patches/README.md 同口径）：
 *   - 幂等：应用前先 `git apply --reverse --check`，成功即视为已应用 → 跳过；
 *   - 冲突即终止：绝不 `--3way`，绝不覆盖用户改动；
 *   - 应用前记录受影响文件的 SHA-256，应用 → 反向 → 断言逐文件还原，再正式应用；
 *   - `prepare-next` 在 `next build` 前调用 `applyAll()`，构建后 `revertAll()`，
 *     使 `../pi-web` 在构建窗口期之外始终 pristine。
 *
 * 默认流程由 prepare-next 自动执行；本脚本主要用于 dev 态手工迭代：
 *   node scripts/patches.mjs apply   → 改补丁版 pi-web 后用 `npm run dev` 快速看 UI
 *   node scripts/patches.mjs revert  → 还原上游树后再提交
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_PARENT = resolve(ROOT, '..');

function log(message) {
  console.log(`[pi-desktop][patches] ${message}`);
}

function git(source, args) {
  const result = spawnSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    error: result.error,
  };
}

/** 由 pi-web 的 package.json 版本推导补丁目录名（`v0.18.0`）。 */
export function patchTag(source) {
  const pkgPath = join(source, 'package.json');
  if (!existsSync(pkgPath)) throw new Error(`未找到 pi-web（${pkgPath}）`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(`${pkgPath} 缺少 version，无法定位 patches/<tag>/`);
  }
  return `v${pkg.version}`;
}

export function findPatches(source, tag = patchTag(source)) {
  const dir = join(ROOT, 'patches', tag);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.patch'))
    .sort()
    .map((name) => join(dir, name));
}

function isApplied(source, patch) {
  return git(source, ['apply', '--reverse', '--check', patch]).ok;
}

function canApply(source, patch) {
  return git(source, ['apply', '--check', patch]).ok;
}

function apply(source, patch, reverse = false) {
  const result = git(source, ['apply', ...(reverse ? ['--reverse'] : []), patch]);
  if (!result.ok) {
    throw new Error(`git apply ${reverse ? '--reverse ' : ''}失败：${patch}\n${result.stderr || result.error?.message || ''}`);
  }
}

/** 补丁触及的文件（`+++ b/<path>` 行；新增文件同样适用）。 */
function touchedFiles(patch) {
  const text = readFileSync(patch, 'utf8');
  const files = new Set();
  for (const line of text.split('\n')) {
    const match = /^\+\+\+ b\/(.+)$/.exec(line.trim());
    if (match) files.add(match[1].trim());
  }
  return [...files];
}

function hashFile(file) {
  if (!existsSync(file)) return null;
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function snapshot(source, files) {
  return new Map(files.map((file) => [file, hashFile(join(source, file))]));
}

function assertRestored(source, before, patch) {
  for (const [file, hash] of before) {
    const current = hashFile(join(source, file));
    if (current !== hash) {
      throw new Error(`补丁往返校验失败（${patch}）：${file} 未还原为原始内容`);
    }
  }
}

/**
 * 幂等应用补丁目录中的全部补丁，返回**本次**实际应用的补丁列表。
 * 已应用的补丁会被跳过（可能是 dev 态手工 apply 的），不会计入返回值。
 */
export function applyAll(source, tag = patchTag(source)) {
  const patches = findPatches(source, tag);
  if (patches.length === 0) {
    log(`无补丁（patches/${tag}/）`);
    return [];
  }
  const applied = [];
  for (const patch of patches) {
    const name = patch.split(/[\\/]/).pop();
    if (isApplied(source, patch)) {
      log(`${name}：已应用，跳过`);
      continue;
    }
    if (!canApply(source, patch)) {
      throw new Error(
        `补丁与当前 pi-web 上下文不匹配：${name}（tag ${tag}）\n`
          + '  → 按 patches/README.md 的纪律，在 detached worktree 以当前 pi-web tag 重新生成补丁；\n'
          + '  → 本脚本绝不使用 --3way，也绝不覆盖 ../pi-web 中的用户改动。',
      );
    }
    const files = touchedFiles(patch);
    const before = snapshot(source, files);
    apply(source, patch);
    try {
      apply(source, patch, true);
      assertRestored(source, before, name);
      apply(source, patch);
    } catch (error) {
      // 尽力回退，避免把源码树留在半应用状态。
      try {
        apply(source, patch, true);
      } catch {
        /* 已回退或从未应用 */
      }
      throw error;
    }
    log(`${name}：已应用（${files.length} 个文件，往返校验通过）`);
    applied.push(patch);
  }
  return applied;
}

/** 反向应用给定补丁（逆序）；仅回退当前确实已应用的补丁。 */
export function revertAll(source, patches = findPatches(source)) {
  for (const patch of [...patches].reverse()) {
    const name = patch.split(/[\\/]/).pop();
    if (!isApplied(source, patch)) {
      continue;
    }
    apply(source, patch, true);
    log(`${name}：已回退`);
  }
}

export function patchStatus(source, tag = patchTag(source)) {
  return findPatches(source, tag).map((patch) => {
    const name = patch.split(/[\\/]/).pop();
    const applied = isApplied(source, patch);
    const appliable = canApply(source, patch);
    return {
      name,
      state: applied ? 'applied' : appliable ? 'clean' : 'conflict',
    };
  });
}

function parseArgs(argv) {
  const args = { command: 'status', source: join(REPO_PARENT, 'pi-web'), tag: null };
  const rest = [...argv];
  args.command = rest.shift() ?? 'status';
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--source') args.source = resolve(rest[++i]);
    else if (rest[i] === '--tag') args.tag = rest[++i];
    else if (rest[i] === '--help' || rest[i] === '-h') args.command = 'help';
    else throw new Error(`未知参数：${rest[i]}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    console.log('用法：node scripts/patches.mjs <status|apply|revert> [--source <pi-web 目录>] [--tag <vX.Y.Z>]');
    return;
  }
  const tag = args.tag ?? patchTag(args.source);
  log(`pi-web = ${args.source}｜tag = ${tag}`);
  if (args.command === 'status') {
    const rows = patchStatus(args.source, tag);
    if (rows.length === 0) {
      log(`无补丁（patches/${tag}/）`);
      return;
    }
    for (const row of rows) log(`${row.name}: ${row.state}`);
    return;
  }
  if (args.command === 'apply') {
    const applied = applyAll(args.source, tag);
    log(`完成：本次应用 ${applied.length} 条补丁`);
    return;
  }
  if (args.command === 'revert') {
    revertAll(args.source, findPatches(args.source, tag));
    log('完成：已回退所有已应用补丁');
    return;
  }
  throw new Error(`未知命令：${args.command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[pi-desktop][patches] 失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
