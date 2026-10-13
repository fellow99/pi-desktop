#!/usr/bin/env node
/**
 * ②′ smoke-desktop.mjs — 宿主机门禁（module 010-build-pipeline）
 *
 * 用法：
 *   node scripts/smoke-desktop.mjs [--source <pi-web 或 pi-dist>] [--port <n>] [--timeout <ms>]
 *                                  [--skip-session] [--keep-running]
 *
 * 断言（全部可证伪，任一 FAIL 即整体 FAIL，禁止把不确定产物推出去）：
 *   1) Node 版本满足上游 engines（>= 22.19.0）；
 *   2) `GET /api/web-auth` → 200（免认证探活端点，服务端已就绪）；
 *   3) `GET /` → 200 且 HTML 命中 Pi Web UI 标记；
 *   4) 鉴权围栏：未带凭据访问受保护 API → 401/403；带 `Authorization: Basic pi:<pw>` → 200；
 *   5) SSE 通道：创建会话（`POST /api/agent/new` `{type:"ensure_session"}`）后
 *      `GET /api/agent/<id>/events` 返回 `text/event-stream`。
 *
 * 目标目录优先级：显式 `--source` > `<repo>/pi-dist`（collect-pi 的产物，即生产形态）> `../pi-web`。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_PARENT = resolve(ROOT, '..');
const MIN_NODE = [22, 19, 0];
const UI_MARKERS = ['Pi Web', 'Pi Desktop'];
const AUTH_USERNAME = 'pi';

const results = [];

function parseArgs(argv) {
  const args = { source: null, port: 0, timeout: 30_000, session: true, keepRunning: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') args.source = resolve(argv[++i]);
    else if (arg === '--port') args.port = Number(argv[++i]);
    else if (arg === '--timeout') args.timeout = Number(argv[++i]);
    else if (arg === '--skip-session') args.session = false;
    else if (arg === '--keep-running') args.keepRunning = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/smoke-desktop.mjs [--source <pi-web|pi-dist>] [--port <n>] [--timeout <ms>] [--skip-session] [--keep-running]');
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveSource(explicit) {
  if (explicit) return explicit;
  const staged = join(ROOT, 'pi-dist');
  if (existsSync(join(staged, '.next', 'BUILD_ID'))) return staged;
  return join(REPO_PARENT, 'pi-web');
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolvePort(port) : reject(new Error('未能取得空闲端口'))));
    });
  });
}

function basicHeader(password) {
  return `Basic ${Buffer.from(`${AUTH_USERNAME}:${password}`, 'utf8').toString('base64')}`;
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${ms} ms）`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '(未探测)';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/web-auth`);
      if (res.status === 200) return last === '(未探测)' ? 'HTTP 200' : last;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(400);
  }
  throw new Error(`就绪超时：${last}`);
}

async function checkRoot(port) {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  const body = await res.text();
  const marker = UI_MARKERS.find((m) => body.includes(m));
  record(
    'GET / 返回 Pi Web UI（HTML 标记命中）',
    res.status === 200 && Boolean(marker),
    `status=${res.status}｜bytes=${body.length}｜marker=${marker ?? '未命中'}`,
  );
}

async function checkAuthFence(port, password) {
  const url = `http://127.0.0.1:${port}/api/sessions`;
  const anonymous = await fetch(url);
  record(
    '受保护 API 在无凭据时应拒绝（401/403）',
    anonymous.status === 401 || anonymous.status === 403,
    `status=${anonymous.status}`,
  );
  const authorized = await fetch(url, { headers: { authorization: basicHeader(password) } });
  record('受保护 API 在带 Basic 凭据时应通过（200）', authorized.status === 200, `status=${authorized.status}`);
  return authorized.status === 200;
}

async function checkSessionAndSse(port, password, workdir) {
  const headers = { authorization: basicHeader(password), 'content-type': 'application/json' };
  const created = await fetch(`http://127.0.0.1:${port}/api/agent/new`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ cwd: workdir, type: 'ensure_session' }),
  });
  const payload = await created.json().catch(() => ({}));
  const sessionId = payload.sessionId;
  record(
    'POST /api/agent/new（ensure_session）可创建会话',
    created.status === 200 && typeof sessionId === 'string' && sessionId.length > 0,
    `status=${created.status}｜sessionId=${sessionId ?? '(无)'}${payload.error ? `｜error=${payload.error}` : ''}`,
  );
  if (typeof sessionId !== 'string' || sessionId.length === 0) return;

  const controller = new AbortController();
  const eventsRes = await fetch(`http://127.0.0.1:${port}/api/agent/${encodeURIComponent(sessionId)}/events`, {
    headers: { authorization: basicHeader(password), accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const contentType = eventsRes.headers.get('content-type') ?? '';
  record(
    'SSE /api/agent/<id>/events 返回 text/event-stream',
    eventsRes.status === 200 && contentType.includes('text/event-stream'),
    `status=${eventsRes.status}｜content-type=${contentType}`,
  );
  // 读取首块（证明长连接真的在推数据），随后主动断开。
  try {
    const reader = eventsRes.body?.getReader();
    if (reader) {
      const first = await withTimeout(reader.read(), 8_000, 'SSE 首块');
      record('SSE 首块可在 8s 内到达', Boolean(first && first.value), `bytes=${first?.value?.length ?? 0}`);
      await reader.cancel().catch(() => {});
    } else {
      record('SSE 首块可在 8s 内到达', false, '响应没有 body 流');
    }
  } catch (error) {
    record('SSE 首块可在 8s 内到达', false, error instanceof Error ? error.message : String(error));
  } finally {
    controller.abort();
  }
}

function stopChild(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const nodeVersion = process.versions.node.split('.').map(Number);
  const nodeOk =
    nodeVersion[0] > MIN_NODE[0] ||
    (nodeVersion[0] === MIN_NODE[0] &&
      (nodeVersion[1] > MIN_NODE[1] || (nodeVersion[1] === MIN_NODE[1] && nodeVersion[2] >= MIN_NODE[2])));
  record(
    `Node 版本满足上游 engines（>= ${MIN_NODE.join('.')}）`,
    nodeOk,
    `当前 ${process.versions.node}${process.versions.node === '24.21.0' ? '（与 Electron 43.7.9 内置版本一致）' : '（与 Electron 43.7.9 内置的 24.21.0 不一致，仅提示）'}`,
  );

  const source = resolveSource(args.source);
  console.log(`[pi-desktop][smoke] 目标目录 = ${source}`);
  if (!existsSync(join(source, '.next', 'BUILD_ID'))) {
    record('目标目录含 pi-web 生产产物（.next/BUILD_ID）', false, `缺失：${join(source, '.next', 'BUILD_ID')}（先跑 prepare-next）`);
    return;
  }
  const buildId = readFileSync(join(source, '.next', 'BUILD_ID'), 'utf8').trim();
  record('目标目录含 pi-web 生产产物（.next/BUILD_ID）', true, `BUILD_ID=${buildId}`);

  const nextBin = join(source, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBin)) {
    record('node_modules/next 可用', false, `缺失：${nextBin}`);
    return;
  }
  record('node_modules/next 可用', true, nextBin);

  const port = args.port > 0 ? args.port : await freePort();
  const password = `smoke-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'pi-desktop-smoke-'));
  const agentDir = join(fixtureRoot, 'pi-agent');
  const workdir = join(fixtureRoot, 'workspace');
  // pi-web 的 /api/agent/new 要求 cwd **必须存在**（否则 400 Directory does not exist）→ 先建夹具目录。
  mkdirSync(workdir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  console.log(`[pi-desktop][smoke] port=${port}｜agentDir=${agentDir}｜workdir=${workdir}`);

  const child = spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: source,
    env: {
      ...process.env,
      PI_WEB_HOSTNAME: '127.0.0.1',
      PI_WEB_PASSWORD: password,
      PI_WEB_SKIP_VERSION_CHECK: '1',
      PI_OFFLINE: '1',
      PI_CODING_AGENT_DIR: agentDir,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[next] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[next] ${chunk}`));

  try {
    await withTimeout(waitForReady(port, args.timeout), args.timeout + 5_000, '服务就绪');
    record('服务端就绪（GET /api/web-auth → 200）', true, `port=${port}`);
  } catch (error) {
    record('服务端就绪（GET /api/web-auth → 200）', false, error instanceof Error ? error.message : String(error));
    return;
  }

  try {
    await checkRoot(port);
    const authorized = await checkAuthFence(port, password);
    if (args.session && authorized) await checkSessionAndSse(port, password, workdir);
    else if (!args.session) console.log('SKIP  SSE 通道（--skip-session）');
  } catch (error) {
    record('冒烟检查执行', false, error instanceof Error ? error.message : String(error));
  } finally {
    if (!args.keepRunning) stopChild(child);
    try {
      rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* 夹具清理失败不影响结论 */
    }
  }
}

try {
  await main();
} catch (error) {
  record('冒烟脚本执行', false, error instanceof Error ? error.message : String(error));
}

const failed = results.filter((r) => !r.ok);
const skipped = results.length === 0 ? 1 : 0;
console.log(`\n[pi-desktop][smoke] 结论：${results.length - failed.length} PASS / ${failed.length} FAIL`);
if (failed.length > 0) {
  console.error(`[pi-desktop][smoke] 失败项：\n  - ${failed.map((r) => `${r.name}（${r.detail}）`).join('\n  - ')}`);
  process.exit(1);
}
if (skipped) {
  console.error('[pi-desktop][smoke] 没有执行任何断言（前置条件不满足）');
  process.exit(1);
}
