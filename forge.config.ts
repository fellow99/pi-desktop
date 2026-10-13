import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import type { ForgeConfig } from '@electron-forge/shared-types';

/**
 * Pi Desktop 打包配置。
 *
 * 与 dsh-desktop 的关键差异（见 docs/工程规划.md §8）：
 *   - 额外资源是 **pi-dist.tar.gz**（首启解压到 <userData>/pi-dist），不是原始目录树：
 *     安装包只增约 116 MB，且解压目标可写 → pi-web 的预览密钥可轮换（只读目录会保留
 *     构建期固化的密钥，留下 `x-prerender-revalidate` 绕过 proxy 的口子）。
 *   - `prune: false` 无需保留（本工程不依赖 pnpm 部署产物），但显式写出以免 Forge 默认裁剪
 *     我们的 scripts/ 与 config/ 目录（它们是构建期产物来源，运行时不需要）。
 *   - `executableName: 'pi-desktop'`：Linux maker 用 package.json 的 name，productName 带空格会
 *     导致 `.deb`/`.rpm` 内可执行名与 maker 期望不一致（dsh 的 501 文档踩坑记录）。
 */
const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // prune: true（Forge 默认）= 打包前移除 devDependencies。本工程运行时依赖只有
    // electron-squirrel-startup，业务产物全部由 extraResource（pi-dist.tar.gz）提供，
    // 因此**必须**裁剪；否则 app.asar 会把 vite/typescript/forge 等开发依赖一起打进去
    // （🔶 本机实测：未裁剪时 app.asar = 566 MB，裁剪后应为数 MB）。
    prune: true,
    derefSymlinks: true,
    icon: 'resources/icon',
    executableName: 'pi-desktop',
    ignore: [
      /^\/out(\/|$)/,
      /^\/logs(\/|$)/,
      /^\/pi-dist(\/|$)/,
      /^\/pi-dist\.tar\.gz$/,
      /^\/pi-dist\.version$/,
      /^\/docs(\/|$)/,
      /^\/specs(\/|$)/,
      /^\/scripts(\/|$)/,
      /^\/upstream\.lock\.json$/,
      // 注意：**不能**把 `/.vite` 排掉 —— `.vite/build/main.js` 就是应用入口（见 package.json 的 main）。
    ],
    // `pi-dist.version`（归档 SHA-256）必须随包分发 → 收敛 specs/009 §3.3 的待定项（采用推荐方案 1）：
    // artifact.ts 优先读它作为「期望哈希」，缺失时退化为「当前 tar 实算哈希」并打 WARN。
    // 两者语义等价（tar 变化都会触发重解压），但随包分发可消掉打包态的退化告警，并与
    // docs/发布与更新.md §6.1「包内期望值」、docs/构建验证记录.md §4 的判据一致。
    extraResource: ['pi-dist.tar.gz', 'pi-dist.version', 'resources/icon.png', 'resources/tray.png', 'resources/trayTemplate.png'],
    appBundleId: 'com.fellow99.pi.desktop',
    appCategoryType: 'public.app-category.developer-tools',
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-squirrel', config: { setupIcon: 'resources/icon.ico' } },
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'linux', 'win32'], config: {} },
    { name: '@electron-forge/maker-dmg', config: {} },
    { name: '@electron-forge/maker-rpm', config: {} },
    { name: '@electron-forge/maker-deb', config: {} },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
          { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
        ],
        renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }],
      },
    } as VitePlugin,
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
