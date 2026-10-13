import { defineConfig } from 'vite';

/**
 * 主进程构建配置。
 * 输出名固定为 main.js（package.json 的 "main": ".vite/build/main.js"）。
 * 壳层不依赖任何原生模块；pi-web 的运行时依赖（next / @earendil-works/* / node-pty）由
 * <userData>/pi-dist 提供，不参与本构建。
 */
export default defineConfig({
  build: {
    lib: {
      entry: 'src/main/index.ts',
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: ['electron', 'electron-squirrel-startup', 'node:*'],
    },
    emptyOutDir: false,
  },
});
