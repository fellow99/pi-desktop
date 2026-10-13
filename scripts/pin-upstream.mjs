#!/usr/bin/env node
/**
 * 上游版本钉住（module 010-build-pipeline）
 *
 * 用法：node scripts/pin-upstream.mjs [--out upstream.lock.json] [--check]
 *
 * 写什么：sibling 工程（`../pi`、`../pi-web`）当前的 **commit SHA / describe / 分支**。
 * 为什么：文档与 specs 里所有「上游机制」结论都带文件路径；升级是**需要复核的事件**，
 *        因此每次构建都把实际用到的上游 commit 记下来（可复现性证据）。
 *
 * `--check`：只校验 lock 与当前 sibling 是否一致（CI 可选门禁），不一致以退出码 3 结束。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_PARENT = resolve(ROOT, '..');

function parseArgs(argv) {
  const args = { out: join(ROOT, 'upstream.lock.json'), check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') args.out = resolve(argv[++i]);
    else if (arg === '--check') args.check = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/pin-upstream.mjs [--out <file>] [--check]');
      process.exit(0);
    }
  }
  return args;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

function describeRepo(name, dir) {
  if (!existsSync(dir)) {
    return { name, dir, present: false, note: 'sibling 目录不存在（CI 中需先 git clone）' };
  }
  const version = (() => {
    try {
      return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
    } catch {
      return null;
    }
  })();
  return {
    name,
    dir,
    present: true,
    version,
    commit: git(dir, ['rev-parse', 'HEAD']),
    describe: git(dir, ['describe', '--tags', '--always']),
    branch: git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: Boolean(git(dir, ['status', '--porcelain'])),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = {
    generatedAt: new Date().toISOString(),
    runtime: {
      electron: '43.7.9',
      node: '24.21.0',
      chromium: '150.0.7871.250',
      abi: 148,
    },
    upstream: [describeRepo('pi', join(REPO_PARENT, 'pi')), describeRepo('pi-web', join(REPO_PARENT, 'pi-web'))],
    // 本工程基线（docs/工程规划.md 文档头）——与 sibling 的实际 commit 一起记录，便于复核漂移。
    baseline: { pi: 'v1.1.0 (Branch_v1.1.0)', piWeb: 'v0.11.1 (Branch_v0.11.1)' },
  };

  for (const repo of payload.upstream) {
    console.log(
      `${repo.name.padEnd(6)} ${repo.present ? `${repo.version ?? '?'}｜${repo.describe ?? '?'}｜${repo.branch ?? '?'}${repo.dirty ? '｜⚠️ 有未提交改动' : ''}` : '缺失'}`,
    );
  }

  if (args.check) {
    if (!existsSync(args.out)) {
      console.error(`[pi-desktop][pin-upstream] --check 失败：lock 文件不存在（${args.out}）`);
      process.exit(3);
    }
    const previous = JSON.parse(readFileSync(args.out, 'utf8'));
    const changed = payload.upstream.filter((repo, index) => {
      const before = previous.upstream?.[index];
      return !before || before.commit !== repo.commit;
    });
    if (changed.length > 0) {
      console.error(
        `[pi-desktop][pin-upstream] 上游已漂移（需复核 docs 与 specs 中的上游结论）：\n  - ${changed
          .map((r) => `${r.name}: ${r.commit ?? '(未知)'}`)
          .join('\n  - ')}`,
      );
      process.exit(3);
    }
    console.log('[pi-desktop][pin-upstream] --check 通过：上游 commit 与 lock 一致');
    return;
  }

  writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`[pi-desktop][pin-upstream] 已写入 ${args.out}`);
}

try {
  main();
} catch (error) {
  console.error(`[pi-desktop][pin-upstream] 失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
