#!/usr/bin/env node
/**
 * probe-renderer.mjs — P0-3 渲染层与原生件探针（module 010-build-pipeline 的验证工具）
 *
 * 用途：对**正在运行**的 Pi Desktop 做渲染层断言。与 smoke-desktop.mjs 的分工：
 *   - smoke-desktop.mjs：宿主机门禁，用「与运行时同版 Node」起 `pi-dist` 的服务端做 HTTP 断言；
 *   - probe-renderer.mjs：连到 Electron 应用自身的**渲染层**（经 CDP），断言只有真实壳层才能回答的问题
 *     （可信来源、crypto.subtle / localStorage、首屏 UI 结构、window.open 拦截、node-pty 在 ABI 下的可用性）。
 *
 * 用法：
 *   # 1) 带调试端口启动应用（打包态）
 *   "out/Pi Desktop-win32-x64/pi-desktop.exe" --remote-debugging-port=9222
 *   # 2) 另开一个终端跑探针
 *   node scripts/probe-renderer.mjs --debug-port 9222 --cwd <可写目录>
 *
 * 断言（全部可证伪；任一 FAIL 即整体 FAIL，退出码非 0）：
 *   R1 渲染层来源是 http://127.0.0.1:<port>（loopback 可信来源，不是 file://）
 *   R2 crypto.subtle 可用（实算 SHA-256）
 *   R3 localStorage 可读写（首屏设置项依赖）
 *   R4 首屏 UI 结构完整（DOM 规模 + composer 可编辑元素 + 按钮 + 文本标记）
 *   R5 window.open 被壳层拦截（返回 null；对应主进程日志「已拦截非 http(s) 的新窗口请求」）
 *   R6 会话与事件流：POST /api/agent/new(ensure_session) → GET /api/agent/<id>/events 首块到达
 *   R7 终端 PTY：POST /api/terminal → 写入命令 → 回显命中 → DELETE
 *      （这是 R2「node-pty 在 ABI 148 下可加载」的唯一直接证据路径：PTY 由 pi-web 服务端创建，
 *        而服务端就跑在 Electron 主进程里）
 *
 * 说明：断言在渲染层里执行（同源 + 已注入的会话 cookie），因此无需在探针侧持有密码。
 */

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function parseArgs(argv) {
  const args = { debugPort: 9222, attachTimeout: 60_000, cwd: null, probeText: 'PI_DESKTOP_PTY_OK' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--debug-port') args.debugPort = Number(argv[++i]);
    else if (arg === '--attach-timeout') args.attachTimeout = Number(argv[++i]);
    else if (arg === '--cwd') args.cwd = resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：node scripts/probe-renderer.mjs [--debug-port 9222] [--attach-timeout 60000] [--cwd <可写目录>]');
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等待 CDP 目标出现（应用起服务 + 建窗口需要时间）。 */
async function findPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url ?? ''));
      if (page?.webSocketDebuggerUrl) return page;
      lastErr = new Error(`暂未发现应用页面目标（现有：${targets.map((t) => `${t.type}:${t.url}`).join(' , ') || '无'}）`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(500);
  }
  throw new Error(`等待 CDP 页面目标超时（${timeoutMs} ms）：${lastErr?.message ?? '未知原因'}`);
}

/** 极简 CDP 客户端（只用到 Runtime.evaluate，够 P0-3 用；避免引入依赖）。 */
class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (typeof msg.id !== 'number') return; // 事件帧（Runtime.consoleAPICalled 等）不处理
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${msg.error.message}（code=${msg.error.code}）`));
      else entry.resolve(msg.result);
    });
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`CDP ${method} 超时（${timeoutMs} ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          rejectPromise(err);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 在渲染层求值（awaitPromise：表达式可以是 async IIFE）。 */
  async evaluate(expression, timeoutMs = 60_000) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '未知异常';
      throw new Error(text.split('\n')[0]);
    }
    return result.result?.value;
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('WebSocket 连接超时')), 15_000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolvePromise();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      rejectPromise(new Error('WebSocket 连接失败'));
    });
  });
  return new CdpClient(ws);
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const cwd = args.cwd ?? process.env.TEMP ?? process.cwd();
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });

  const target = await findPageTarget(args.debugPort, args.attachTimeout);
  console.log(`[probe] CDP 目标 = ${target.url}｜title=${target.title ?? ''}`);
  const cdp = await connect(target.webSocketDebuggerUrl);
  const origin = new URL(target.url).origin;

  // ---- R1：渲染层来源（可信来源） ----
  const loc = await cdp.evaluate('({ origin: location.origin, protocol: location.protocol, host: location.hostname, secure: window.isSecureContext, title: document.title })');
  record(
    'R1 渲染层来自 loopback 可信来源（http://127.0.0.1:<port>）',
    loc.origin === origin && loc.host === '127.0.0.1' && loc.secure === true,
    `origin=${loc.origin}｜isSecureContext=${loc.secure}｜title=${loc.title}`,
  );

  // ---- R2：crypto.subtle ----
  const subtle = await cdp.evaluate(`(async () => {
    if (!(window.crypto && crypto.subtle && typeof crypto.subtle.digest === 'function')) return { ok: false, why: 'crypto.subtle 不存在' };
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pi-desktop'));
      const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
      return { ok: hex.length === 64, hex };
    } catch (err) { return { ok: false, why: String(err) }; }
  })()`);
  record('R2 crypto.subtle 可用（可信来源才有）', subtle?.ok === true, subtle?.hex ? `sha256=pi-desktop → ${subtle.hex.slice(0, 16)}…` : `why=${subtle?.why}`);

  // ---- R3：localStorage ----
  const storage = await cdp.evaluate(`(() => {
    try {
      const key = '__pi_desktop_probe__';
      localStorage.setItem(key, 'v1');
      const value = localStorage.getItem(key);
      localStorage.removeItem(key);
      return { ok: value === 'v1', count: localStorage.length };
    } catch (err) { return { ok: false, why: String(err) }; }
  })()`);
  record('R3 localStorage 可读写', storage?.ok === true, `现有键数≈${storage?.count}${storage?.why ? `｜why=${storage.why}` : ''}`);

  // ---- R4：首屏 UI 结构 ----
  const dom = await cdp.evaluate(`(() => {
    const text = (document.body?.innerText ?? '').replace(/\\s+/g, ' ').trim();
    const editable = document.querySelectorAll('textarea, [contenteditable="true"]').length;
    const buttons = document.querySelectorAll('button').length;
    const composer = document.querySelectorAll('textarea, [contenteditable="true"]').length > 0;
    return { length: text.length, editable, buttons, nodes: document.querySelectorAll('*').length, composer, sample: text.slice(0, 120) };
  })()`);
  record(
    'R4 首屏 UI 结构完整（DOM + composer 可编辑元素）',
    dom?.composer === true && dom.editable > 0 && dom.nodes > 200 && dom.length > 50,
    `节点=${dom?.nodes}｜可编辑=${dom?.editable}｜按钮=${dom?.buttons}｜文本=${dom?.length} 字符`,
  );

  // ---- R5：window.open 拦截（file:// 走 deny 分支，不会真的拉起浏览器） ----
  const winOpen = await cdp.evaluate(`(() => {
    const before = document.querySelectorAll('*').length;
    let ret = 'not-called';
    try { ret = window.open('file:///C:/pi-desktop-probe') ?? null; } catch (err) { return { ok: false, why: String(err) }; }
    return { ok: ret === null, ret: String(ret), before, after: document.querySelectorAll('*').length };
  })()`);
  record('R5 window.open 被壳层拦截（返回 null，不新开窗口）', winOpen?.ok === true, `返回=${winOpen?.ret}｜DOM 变化=${winOpen?.before}→${winOpen?.after}`);

  // ---- R6：会话 + SSE（渲染层上下文） ----
  const session = await cdp.evaluate(`(async () => {
    const cwd = ${JSON.stringify(cwd)};
    const created = await fetch('/api/agent/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd, type: 'ensure_session' }),
    });
    const body = await created.json().catch(() => ({}));
    if (!created.ok || !body.sessionId) return { ok: false, why: 'ensure_session 失败：' + created.status + ' ' + JSON.stringify(body).slice(0, 160) };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch('/api/agent/' + body.sessionId + '/events', { signal: ctrl.signal, headers: { accept: 'text/event-stream' } });
      const contentType = res.headers.get('content-type') ?? '';
      const reader = res.body.getReader();
      const first = await reader.read();
      ctrl.abort();
      return {
        ok: res.status === 200 && /text\\/event-stream/.test(contentType) && (first.value?.length ?? 0) > 0,
        sessionId: body.sessionId,
        status: res.status,
        contentType,
        bytes: first.value?.length ?? 0,
      };
    } finally { clearTimeout(timer); }
  })()`, 60_000);
  record(
    'R6 渲染层可建会话且 SSE 首块到达（text/event-stream）',
    session?.ok === true,
    `status=${session?.status}｜content-type=${session?.contentType}｜首块=${session?.bytes} B｜sessionId=${String(session?.sessionId ?? '').slice(0, 12)}…${session?.why ? `｜why=${session.why}` : ''}`,
  );

  // ---- R7：终端 PTY（node-pty 在 ABI 下可加载并能跑命令） ----
  const pty = await cdp.evaluate(`(async () => {
    const cwd = ${JSON.stringify(cwd)};
    const marker = ${JSON.stringify(args.probeText)};
    const created = await fetch('/api/terminal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd, cols: 100, rows: 30 }),
    });
    const body = await created.json().catch(() => ({}));
    if (!created.ok || !body.id) return { ok: false, why: 'createTerminal 失败：' + created.status + ' ' + JSON.stringify(body).slice(0, 200) };
    const id = body.id;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    let text = '';
    let contentLength = 0;
    try {
      const res = await fetch('/api/terminal/' + id + '/events', { signal: ctrl.signal, headers: { accept: 'text/event-stream' } });
      const contentType = res.headers.get('content-type') ?? '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // 先写命令，再从流里读回显（Windows 上是 cmd / PowerShell，命令用 echo 最稳）
      void fetch('/api/terminal/' + id, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'input', data: 'echo ' + marker + '\\r' }),
      });
      const deadline = Date.now() + 18000;
      while (Date.now() < deadline && !text.includes(marker)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        contentLength += chunk.value?.length ?? 0;
        text += decoder.decode(chunk.value ?? new Uint8Array(), { stream: true });
      }
      ctrl.abort();
      const cleaned = text.replace(/\\u001b\\[[0-9;?]*[a-zA-Z]/g, '').replace(/\\s+/g, ' ').trim();
      const cleanedCount = (cleaned.match(new RegExp(marker, 'g')) ?? []).length;
      return {
        ok: text.includes(marker) && cleanedCount >= 2,
        id,
        contentType,
        streamBytes: contentLength,
        echoes: cleanedCount,
        tail: cleaned.slice(-120),
      };
    } finally {
      clearTimeout(timer);
      void fetch('/api/terminal/' + id, { method: 'DELETE' }).catch(() => {});
    }
  })()`, 90_000);
  record(
    'R7 终端 PTY 可创建并回显命令（node-pty 在 Electron ABI 下可加载）',
    pty?.ok === true,
    `terminalId=${String(pty?.id ?? '').slice(0, 8)}…｜流字节=${pty?.streamBytes}｜回显次数=${pty?.echoes}｜尾部="${pty?.tail ?? ''}"${pty?.why ? `｜why=${pty.why}` : ''}`,
  );

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n[probe] 结论：${results.length - failed} PASS / ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error(`[probe][错误] ${err?.message ?? err}`);
  process.exit(1);
});
