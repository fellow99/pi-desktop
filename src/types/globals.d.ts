/**
 * electron-squirrel-startup 没有自带类型声明（🔶 沿用 dsh-desktop 的做法）。
 * 它在 Squirrel 的安装/更新/卸载短生命周期里返回 true，此时应用应立即退出。
 */
declare module 'electron-squirrel-startup' {
  const started: boolean;
  export default started;
}

/** 平台注入的 Vite 常量（与 forge.env.d.ts 对应，这里只为 main 构建提供类型）。 */
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
