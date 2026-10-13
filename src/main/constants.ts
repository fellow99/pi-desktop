/**
 * 全局常量（壳层与「上游契约」的接缝都集中在这里，改一处即可全局同步）。
 *
 * 约定：凡是镜像上游（pi / pi-web）的常量，注释里必须写明上游文件路径，
 * 上游升级时逐一复核（docs/工程规划.md §11.1 R10）。
 */
export const LOG_PREFIX = '[pi-desktop]';

/** 应用标识（Windows 通知归组、macOS bundle id、窗口状态目录归属）。 */
export const APP_ID = 'com.fellow99.pi.desktop';
export const PRODUCT_NAME = 'Pi Desktop';

/** pi-dist 产物归档（构建期由 scripts/collect-pi.mjs 生成，随包分发）。 */
export const ARCHIVE_NAME = 'pi-dist.tar.gz';
/** 归档 SHA-256（构建期写入；内容不是 SHA-256 时退化为「当前归档哈希」模式）。 */
export const VERSION_NAME = 'pi-dist.version';
/** 幂等 marker：内容 = 已解压归档的 SHA-256，写在 <userData>/ 下（不污染 pi-dist）。 */
export const MARKER_NAME = 'pi-dist.sha256';

/** 就绪探测：HTTP 轮询，**不**监听 stdout 的 "Ready"（那是 CLI 启动器的做法）。 */
export const READY_TIMEOUT_MS = 30_000;
export const READY_INTERVAL_MS = 400;
/** pi-web 的免认证探活端点（镜像 pi-web/app/api/web-auth/route.ts）。 */
export const READY_PROBE_PATH = '/api/web-auth';

/** 首屏标记：Pi Web UI 的 title 与品牌名（命中其一即可判定加载到了 UI 而非登录页）。 */
export const UI_HTML_MARKERS = ['Pi Desktop', 'Pi Web'];

/** 镜像 pi-web/lib/web-auth.ts（cookie 名、Basic 用户名、会话有效期）。改动需同步。 */
export const PI_WEB_SESSION_COOKIE = 'pi_web_session';
export const PI_WEB_AUTH_USERNAME = 'pi';
export const PI_WEB_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** 应用内日志（fail-visible：每个启动阶段都要落盘）。 */
export const LOG_DIR_NAME = 'logs';

/** 壳层设置与窗口状态文件名。 */
export const SETTINGS_FILE_NAME = 'pi-desktop-settings.json';
export const WINDOW_STATE_FILE_NAME = 'window-state.json';

/** 主窗口默认尺寸（🔶 沿用 dsh-desktop）。 */
export const DEFAULT_WINDOW_WIDTH = 1200;
export const DEFAULT_WINDOW_HEIGHT = 800;
export const MIN_WINDOW_WIDTH = 800;
export const MIN_WINDOW_HEIGHT = 600;

/** 通知策略：窗口在前台不弹、同会话冷却窗口内去重（避免 noisy）。 */
export const NOTIFICATION_COOLDOWN_MS = 10_000;
export const SESSION_WATCH_INTERVAL_MS = 2_000;

/** 退出链：关闭服务端的最长等待（对齐 pi-web 的 PI_WEB_SHUTDOWN_DEADLINE_MS 默认值）。 */
export const SHUTDOWN_DEADLINE_MS = 5_000;

/** 检查更新数据源（⬜ 待定，见 docs/工程规划.md §11.3；可用 env 覆盖以接官网 feed）。 */
export const DEFAULT_UPDATE_FEED = 'https://api.github.com/repos/fellow99/pi-desktop/releases/latest';
export const UPDATE_CHECK_TIMEOUT_MS = 8_000;
