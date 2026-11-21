/* 设置窗口（module 301-sync-daemon）—— 原生 JS，无构建链。 */
'use strict';

const api = window.piDesktopSettings;

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const hubUrl = document.getElementById('hubUrl');
const hostName = document.getElementById('hostName');
const hubToken = document.getElementById('hubToken');
const toggleToken = document.getElementById('toggleToken');
const enabled = document.getElementById('enabled');
const applyBtn = document.getElementById('applyBtn');
const msg = document.getElementById('msg');

/* ---------------- tabs（多 tabs 骨架：新增 tab 只需加静态 HTML） ---------------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${tab.dataset.page}`));
  });
});

/* ---------------- 状态灯 ---------------- */
function renderStatus(status) {
  if (!status || typeof status.state !== 'string') {
    statusText.textContent = '未知';
    statusDot.classList.remove('on');
    return;
  }
  switch (status.state) {
    case 'running':
      statusDot.classList.add('on');
      // 进程级语义（spec FR-301-021a/021b）：只代表守护进程在运行且 control 可达，不代表中枢已连通。
      statusText.textContent = '运行中';
      break;
    case 'starting':
      statusDot.classList.remove('on');
      statusText.textContent = '启动中…';
      break;
    case 'disabled':
      statusDot.classList.remove('on');
      statusText.textContent = '未启用';
      break;
    case 'stopped':
      statusDot.classList.remove('on');
      statusText.textContent = status.reason ? `已停止（${status.reason}）` : '已停止';
      break;
    default:
      statusDot.classList.remove('on');
      statusText.textContent = status.state;
  }
}

/* ---------------- 表单 ---------------- */
function fillSettings(settings) {
  if (!settings) return;
  hubUrl.value = settings.hubUrl ?? '';
  hostName.value = settings.hostName ?? '';
  hubToken.value = settings.hubToken ?? '';
  enabled.checked = settings.enabled === true;
}

function collectSettings() {
  return {
    enabled: enabled.checked,
    hubUrl: hubUrl.value.trim(),
    hostName: hostName.value.trim(),
    hubToken: hubToken.value.trim(),
  };
}

let msgTimer = null;
let unsubStatus = null;
function showMsg(text, kind) {
  msg.textContent = text;
  msg.className = kind;
  if (msgTimer) clearTimeout(msgTimer);
  if (kind === 'ok') {
    msgTimer = setTimeout(() => {
      msg.textContent = '';
      msg.className = '';
    }, 4000);
  }
}

/**
 * 剥掉 Electron 给 invoke 错误包上的前缀：
 *   "Error invoking remote method 'pi-desktop:settings:sync:apply': Error: 地址不合法"
 * → "地址不合法"（主进程侧的消息本身就已可读，不应让用户看见 IPC 内部细节）。
 */
function readableError(err) {
  const raw = err && err.message ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

applyBtn.addEventListener('click', async () => {
  applyBtn.disabled = true;
  showMsg('正在应用…', '');
  try {
    await api.apply(collectSettings());
    showMsg('已应用', 'ok');
    const fresh = await api.get();
    fillSettings(fresh.settings);
    renderStatus(fresh.status);
  } catch (err) {
    showMsg(readableError(err), 'err');
  } finally {
    applyBtn.disabled = false;
  }
});

/* 令牌显示切换（FR-301-007：密码形态 + 显示切换） */
toggleToken.addEventListener('click', () => {
  const show = hubToken.type === 'password';
  hubToken.type = show ? 'text' : 'password';
  toggleToken.textContent = show ? '隐藏' : '显示';
});

/* ---------------- 初始化：回填 + 状态订阅 ---------------- */
window.addEventListener('load', async () => {
  // preload 未生效（非 file: 来源或加载失败）时 api 为 undefined：直接提示，不让异常冒到未捕获。
  if (!api) {
    showMsg('设置桥不可用（preload 未加载）', 'err');
    return;
  }
  try {
    const data = await api.get();
    fillSettings(data.settings);
    renderStatus(data.status);
  } catch (err) {
    showMsg(`读取配置失败：${readableError(err)}`, 'err');
  }
  // 状态订阅：页面卸载时解绑（FR-301-022：不泄漏句柄）
  unsubStatus = api.onStatus((status) => renderStatus(status));
});

window.addEventListener('beforeunload', () => {
  if (typeof unsubStatus === 'function') unsubStatus();
});
