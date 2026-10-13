import { defineConfig } from 'vite';

/** preload 构建：默认只暴露壳层动作（见 src/preload/index.ts 的协议守卫）。 */
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['electron'],
      output: { entryFileNames: 'preload.js' },
    },
    emptyOutDir: false,
  },
});
