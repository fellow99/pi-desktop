/**
 * 壳层自有渲染脚本（loading / 启动失败页）。
 *
 * 与主进程的联动：主进程用 `webContents.executeJavaScript` 调用本文件暴露的
 * `window.__piDesktopSetStage(stage, detail, state)` —— 没有任何数据面 IPC。
 * 反过来，页面上的三个按钮经 preload 暴露的 `window.piDesktop`（仅 `file://` 文档可见）
 * 请求壳层动作：打开日志 / 重试启动 / 退出。
 */

type LoadingState = 'running' | 'done' | 'failed';

type ShellInfo = {
  productName: string;
  appVersion: string;
  electron: string;
  node: string;
  chrome: string;
  stage: string;
  serverUrl: string | null;
  agentDir: string | null;
  piDistRoot: string | null;
  logFile: string | null;
};

declare global {
  interface Window {
    __piDesktopSetStage?: (stage: string, detail: string, state: LoadingState) => void;
    piDesktop?: {
      getInfo(): Promise<ShellInfo>;
      openLog(): Promise<void>;
      openSessionDir(): Promise<void>;
      checkForUpdates(): Promise<{ status: string; latest?: string; url?: string; message?: string }>;
      retry(): Promise<void>;
      quit(): Promise<void>;
    };
  }
}

const root = document.getElementById('root');
const stageValue = document.getElementById('stage-value');
const detailValue = document.getElementById('detail');
const meta = document.getElementById('meta');

function apply(stage: string, detail: string, state: LoadingState): void {
  if (stageValue) stageValue.textContent = stage;
  if (detailValue) detailValue.textContent = detail;
  if (root) {
    root.classList.remove('running', 'done', 'failed');
    root.classList.add(state);
  }
}

window.__piDesktopSetStage = apply;

document.getElementById('action-open-log')?.addEventListener('click', () => {
  void window.piDesktop?.openLog();
});

document.getElementById('action-retry')?.addEventListener('click', () => {
  apply('正在重试…', '重新执行启动链', 'running');
  void window.piDesktop?.retry();
});

document.getElementById('action-quit')?.addEventListener('click', () => {
  void window.piDesktop?.quit();
});

void (async () => {
  if (!window.piDesktop) {
    apply('壳层桥不可用', '当前文档未获得壳层桥（preload 只对本地页面暴露）。', 'failed');
    return;
  }
  try {
    const info = await window.piDesktop.getInfo();
    if (meta) {
      meta.textContent = `${info.productName} v${info.appVersion}｜Electron ${info.electron}｜Node ${info.node}｜Chromium ${info.chrome}`;
    }
    if (detailValue && info.stage) {
      detailValue.textContent = `阶段：${info.stage}${info.logFile ? `｜日志：${info.logFile}` : ''}`;
    }
  } catch (err) {
    if (meta) meta.textContent = `无法读取运行信息：${String(err)}`;
  }
})();

export {};
