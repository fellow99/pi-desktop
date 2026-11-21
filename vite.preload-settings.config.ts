import { defineConfig } from 'vite';

/**
 * 设置窗口 preload 构建（module 301-sync-daemon）。
 * 与主窗口 preload 同为独立入口：产物 `preload-settings.js`（不与 `preload.js` 冲突，
 * settings-window.ts 里以 `join(__dirname, 'preload-settings.js')` 引用）。
 */
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['electron'],
      output: { entryFileNames: 'preload-settings.js' },
    },
    emptyOutDir: false,
  },
});
