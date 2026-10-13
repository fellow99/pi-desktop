import { app, Menu, Tray, nativeImage } from 'electron';
import { join } from 'node:path';

import { PRODUCT_NAME } from './constants';
import { describeError, logError, logInfo } from './logger';

/**
 * 系统托盘（module 003-tray）。
 *
 * 形态（🔶 沿用 dsh-desktop + 平台惯例补充）：
 *   - 单例 `Tray`，图标 `resources/tray.png`；macOS 用模板图 `trayTemplate.png`（深浅色自适应）；
 *   - 单击：Windows/Linux 唤起窗口；macOS 按惯例弹出菜单（macOS 下 click 与菜单天然合并）；
 *   - 菜单项按宿主就绪态**禁用**而不是消失（用户能看到「为什么现在不能用」）；
 *   - 退出入口必须走优雅关闭链（由 index.ts 提供）。
 */

export type TrayActions = {
  showWindow(): void;
  openSessionDir(): Promise<void>;
  openLog(): Promise<void>;
  checkForUpdates(): Promise<void>;
  quit(): void;
  isReady(): boolean;
  hasAgentDir(): boolean;
};

let tray: Tray | null = null;

function iconPath(): string {
  const name = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'resources', name);
}

function buildMenu(actions: TrayActions): Menu {
  const agentDirItem = {
    label: '会话目录',
    enabled: actions.hasAgentDir(),
    click: () => {
      void actions.openSessionDir().catch((err) => logError(`打开会话目录失败：${describeError(err)}`));
    },
  };
  return Menu.buildFromTemplate([
    { label: `${PRODUCT_NAME}${actions.isReady() ? '' : '（启动中…）'}`, enabled: false },
    { type: 'separator' },
    { label: '显示主窗口', click: () => actions.showWindow() },
    { label: '打开日志', click: () => void actions.openLog().catch((err) => logError(`打开日志失败：${describeError(err)}`)) },
    { label: '检查更新…', click: () => void actions.checkForUpdates().catch((err) => logError(`检查更新失败：${describeError(err)}`)) },
    agentDirItem,
    { type: 'separator' },
    { label: '退出', click: () => actions.quit() },
  ]);
}

export function createTray(actions: TrayActions): Tray {
  if (tray) return tray;

  const file = iconPath();
  let image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    logError(`托盘图标缺失或不可读：${file}（将退化为空图标，功能不受影响）`);
    image = nativeImage.createEmpty();
  }
  if (process.platform === 'darwin') image.setTemplateImage(true);

  tray = new Tray(image);
  tray.setToolTip(PRODUCT_NAME);
  tray.setContextMenu(buildMenu(actions));
  tray.on('click', () => {
    if (process.platform === 'darwin') tray?.popUpContextMenu();
    else actions.showWindow();
  });
  logInfo(`托盘已创建（icon=${file}）`);
  return tray;
}

/** 就绪态变化后刷新菜单（禁用/启用项）。 */
export function refreshTrayMenu(actions: TrayActions): void {
  if (!tray) return;
  tray.setContextMenu(buildMenu(actions));
}

export function destroyTray(): void {
  if (!tray) return;
  tray.destroy();
  tray = null;
  logInfo('托盘已销毁');
}
