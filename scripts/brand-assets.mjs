#!/usr/bin/env node
/**
 * brand-assets.mjs — 品牌化（module **012-branding**：UI 文案 / 页面 Logo / 应用图标 / 禁用版本检测）
 *
 * ## 为什么需要它
 *
 * 交付物里有两处「别人的品牌」必须换成我们自己的（`specs/012-branding/spec.md`）：
 *
 * 1. **Web UI**（`collect-pi` 组装出来的 `pi-dist/` 副本）：`Pi Web` 文案、页面 Logo、
 *    web 位图图标（favicon / PWA 图标）都来自上游 `pi-web`；
 * 2. **壳自己的图标位**（`resources/`）：应用图标、托盘图标曾经是**手工拷贝**的 ——
 *    换物料不生效、丢物料不报错、不透明/透明用法会漂移（参考工程 `pi-desktop-hos` 踩过）。
 *
 * 上游三仓（`../pi`、`../pi-web`、`../harmonypc-electron`）**一个字节都不能改**（`docs/工程规划.md` §7），
 * 所以品牌化只施加在**本工程自己的产物**上：`pi-dist/`（副本）与 `resources/`（自有图标位）。
 *
 * ## 物料（唯一来源 = 父工程 `../assets/`）
 *
 * | 文件 | 属性（**硬校验**） | 用途 |
 * |---|---|---|
 * | `logo-1024-with-bg.png` | 1024²、**真不透明**（minAlpha = 255） | 应用图标 PNG；web `icon-512.png`（rgb24） |
 * | `logo.png` | 200²、**真的含透明像素**（minAlpha < 255） | macOS 托盘模板；web `icon-192`/`apple-touch-icon`/favicon |
 * | `logo-200-with-bg.png` | 200²、不透明 | 托盘图标（带底，浅色/深色任务栏都看得见） |
 * | `logo.ico` / `logo.icns` | ICO / ICNS 魔数 | Windows / macOS 应用图标（安装器同用） |
 * | `logo.svg` | 可解析矢量（`<svg` + `viewBox`） | 页面 Logo（任意尺寸清晰） |
 *
 * 物料缺失/尺寸不足/透明度不符/`ffmpeg` 不可用 → **一律硬失败**（绝不静默产出无品牌包）。
 *
 * 物料同时**镜像**到本仓 `resources/brand/`（入库）：父工程在场时以其为准并刷新镜像；
 * 父工程不存在（CI 只 checkout 本仓）时使用镜像并 WARN —— 保证 CI 也能打出同样的品牌产物。
 *
 * ## 三个入口（幂等）
 *
 * - `applyRepoBranding({material})`：写 `resources/{icon.png,icon.ico,icon.icns,tray.png,trayTemplate.png}`
 *   （物料**逐字节**固化 + 回读比对）；
 * - `applyWebBranding(piDistDir, {material})`：写 `pi-dist/` 副本的 `public/icons/*` + favicon 路由体 +
 *   `logo.svg`，做文案/Logo 路径替换，最后**后置断言**（状态式，可重跑）；
 * - `assertNoBrandLeftovers(piDistDir)`：全树终检（排除 `node_modules`）—— `Pi Web` 必须 0 处。
 *
 * CLI：`node scripts/brand-assets.mjs [--assets <dir>]`
 * （`resources/` 恒做；`pi-dist/` 存在时一并做 + 终检）。
 *
 * 前置：`ffmpeg` 在 PATH（web 位图图标缩放）；物料目录默认 `../assets`，可用 `--assets`/`PI_ASSETS_DIR` 覆盖。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const LOG = '[brand]';

/** 文案：pi-web 的显示名 → 本工程显示名。**只替换带空格的字面量**（技术标识符是 `pi-web`/`PiWeb*`/`PI_WEB_*`）。 */
const BRAND_FROM = 'Pi Web';
const BRAND_TO = 'Pi Desktop';

/**
 * 页面 Logo 的路径替换：只改**真正渲染 Logo 的 `src`**（登录页 hero / 空会话 hero / preload），
 * **不动**元数据里的 `rel="apple-touch-icon" href=…`（该 PNG 仍被声明、也仍然生成 —— 已由物料重建）
 * 与 `public/sw.js` 的预缓存列表。
 *
 * 三种编译形态都要覆盖（实测上游 v0.11.1 产物）：
 * - 服务端/客户端 chunk（JSX 编译）：`src:"/icons/apple-touch-icon.png"`
 * - SSR 预渲染 HTML：`src="/icons/apple-touch-icon.png"`
 * - RSC/JSON 负载：`"src":"/icons/apple-touch-icon.png"`
 * 另有 Next 为 `priority` 图插入的 preload：`as="image" href="/icons/apple-touch-icon.png"`
 * （必须带 `as="image"` 前缀 —— 裸 `href=` 会误伤元数据）。
 */
const LOGO_SRC_REPLACEMENTS = [
  ['"src":"/icons/apple-touch-icon.png"', '"src":"/icons/logo.svg"'],
  ['src:"/icons/apple-touch-icon.png"', 'src:"/icons/logo.svg"'],
  ['src="/icons/apple-touch-icon.png"', 'src="/icons/logo.svg"'],
  ['as="image" href="/icons/apple-touch-icon.png"', 'as="image" href="/icons/logo.svg"'],
];

/**
 * 必须**逐字不变**的技术标识符（spec FR-012-002）：替换后逐项比对总出现次数。
 *
 * 为什么需要：`BRAND_FROM`（带空格）与这些标识符（连字符/下划线/驼峰）本不可能互相包含，
 * 但一旦有人把 `BRAND_FROM` 改成 `pi-web`、或把替换做成大小写不敏感，这里会立刻失败 ——
 * 它是**给未来改动准备的回归断言**，而不是「当前这次替换」的证明。
 */
const TECH_IDENTIFIERS = ['pi-web', '@agegr/pi-web', 'pi_web_session', 'PI_WEB_', 'PiWeb'];

/** 替换上限（防御：单个文本文件超过此大小不处理，避免把巨型 sourcemap 读进内存）。 */
const MAX_TEXT_BYTES = 32 * 1024 * 1024;

/** 本工程自有的图标位（相对 `projectRoot`）。 */
const REPO_ICONS = {
  'resources/icon.png': { from: 'logo-1024-with-bg.png', width: 1024, height: 1024, opaque: true },
  'resources/tray.png': { from: 'logo-200-with-bg.png', width: 200, height: 200, opaque: true },
  'resources/trayTemplate.png': { from: 'logo.png', width: 200, height: 200, opaque: false },
  'resources/icon.ico': { from: 'logo.ico' },
  'resources/icon.icns': { from: 'logo.icns' },
};

/** 物料镜像目录（入库；CI 无父工程时使用）。 */
const MIRROR_DIR = join(projectRoot, 'resources', 'brand');
/** 物料清单（顺序即日志顺序）。 */
const MATERIAL_FILES = [
  'logo.png',
  'logo-1024-with-bg.png',
  'logo-200-with-bg.png',
  'logo.ico',
  'logo.icns',
  'logo.svg',
];

// ---------------------------------------------------------------- 工具

function fail(message) {
  console.error(`\n${LOG} ✖ ${message}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`${LOG} ⚠ ${message}`);
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function* walkFiles(dir, { skipDirs = new Set() } = {}) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full, { skipDirs });
    else if (entry.isFile()) yield full;
  }
}

/** 读 PNG 头（IHDR）。返回 null 表示不是 PNG。 */
function pngInfo(file) {
  const buf = readFileSync(file);
  if (buf.length < 26 || buf.slice(1, 4).toString('latin1') !== 'PNG') return null;
  const colorType = buf[25];
  return {
    bytes: buf.length,
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType,
    // colorType: 0=灰度 2=RGB 3=调色板 4=灰度+alpha 6=RGBA。
    // 只有 4/6 一定带 alpha；3 可能带 tRNS（因此「不透明」的判定不看这里，而是要求 colorType === 2）。
    hasAlphaChannel: colorType === 4 || colorType === 6,
  };
}

function ensureFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    fail('未找到 ffmpeg（web 位图图标缩放必需）。安装：Windows `scoop install ffmpeg` / `choco install ffmpeg`，或把 ffmpeg 加入 PATH。');
  }
}

/**
 * 用 ffmpeg 把图解码成 rawvideo，扫描真正的最小 alpha。
 *
 * 走**临时文件**而不是 stdout 管道：1024² RGBA = 4 MB，实测经 `execFileSync` 的 stdout 管道传输会
 * 偶发失败（子进程异常退出、父进程拿到 `E06D7363`）；写文件再读稳得多。
 */
function minAlpha(file) {
  ensureFfmpeg();
  const raw = join(tmpdir(), `pi-brand-alpha-${process.pid}-${Date.now()}.raw`);
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', raw], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const buf = readFileSync(raw);
    let min = 255;
    for (let i = 3; i < buf.length; i += 4) {
      if (buf[i] < min) {
        min = buf[i];
        if (min === 0) break;
      }
    }
    return min;
  } catch (error) {
    fail(`无法解析 PNG 的 alpha 通道：${file}\n  ${String(error.stderr ?? error.message).trim()}`);
  } finally {
    rmSync(raw, { force: true });
  }
}

/**
 * 缩放并落盘。`alpha:false` 时输出 `rgb24` → PNG `colorType=2`（无 alpha 通道且**不是**带 tRNS 的调色板图）。
 * 参数固定 → 同物料得同字节（幂等，重建不产生 git diff）。
 *
 * 两个「必须显式」的坑（参考工程实测踩过）：
 * - `-f image2`：favicon 的目标文件名是 `.body`（Next 的路由体），能推断出的容器格式不确定；
 * - `-c:v png`：编解码器也要显式指定 —— 否则面对 `.body` 这种未知扩展名，ffmpeg 会默认落成 **JPEG**，
 *   浏览器把它当图片仍能显示，但「图标是 PNG」的前提就悄悄破了。
 *
 * 写完**回读 IHDR** 复核（不看命令退出码）：必须是 PNG、尺寸一致、不透明时必须是 `colorType=2`。
 */
function scaleTo(src, dst, { width, height, alpha }) {
  mkdirSync(dirname(dst), { recursive: true });
  try {
    execFileSync('ffmpeg', [
      '-y', '-v', 'error', '-i', src,
      '-vf', `scale=${width}:${height}:flags=lanczos,format=${alpha ? 'rgba' : 'rgb24'}`,
      '-frames:v', '1', '-c:v', 'png', '-f', 'image2', dst,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    fail(`ffmpeg 生成失败：${dst}\n  源：${src}（${width}×${height}，${alpha ? 'rgba' : 'rgb24'}）\n  ${String(error.stderr ?? error.message).trim()}`);
  }
  const info = pngInfo(dst);
  if (!info) fail(`生成结果不是 PNG：${dst}`);
  if (info.width !== width || info.height !== height) fail(`生成尺寸不符：${dst} → ${info.width}×${info.height}（期望 ${width}×${height}）`);
  if (alpha && !info.hasAlphaChannel) fail(`该位图必须带 alpha 通道（colorType=4/6）：${dst} → colorType=${info.colorType}`);
  if (!alpha && info.colorType !== 2) {
    fail(`不透明位图必须是不带 alpha 的 RGB PNG（colorType=2）：${dst} → colorType=${info.colorType}（调色板 3 也可能带 tRNS 透明，同样不接受）`);
  }
  return dst;
}

/** 逐字节复制 + 回读校验（比 `cp` 更硬：复制错了当场炸）。 */
function copyExact(src, dst, { log = true } = {}) {
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { force: true });
  const a = sha256File(src);
  const b = sha256File(dst);
  if (a !== b) fail(`物料复制后不一致：${dst}\n  源 ${src} = ${a}\n  目标 = ${b}`);
  if (log) console.log(`${LOG}   ${relative(projectRoot, dst).replaceAll('\\', '/')}  ←  ${relative(projectRoot, src).replaceAll('\\', '/')}  sha256=${a.slice(0, 12)}…`);
  return dst;
}

// ---------------------------------------------------------------- 物料校验

/** PNG 魔数之外的容器校验：ICO / ICNS。 */
function assertIco(file) {
  const buf = readFileSync(file);
  if (buf.length < 6 || buf[0] !== 0 || buf[1] !== 0 || buf[2] !== 1 || buf[3] !== 0) {
    fail(`物料不是合法 ICO（ICONDIR 魔数应为 00 00 01 00）：${file}`);
  }
  return buf.readUInt16LE(4); // 图像数
}

function assertIcns(file) {
  const buf = readFileSync(file);
  if (buf.length < 8 || buf.slice(0, 4).toString('latin1') !== 'icns') {
    fail(`物料不是合法 ICNS（魔数应为 'icns'）：${file}`);
  }
  return buf.readUInt32BE(4); // 总长度
}

/**
 * 解析并校验物料目录，必要时把物料镜像到 `resources/brand/`（入库）。
 *
 * 优先级：`--assets <dir>` > `$PI_ASSETS_DIR` > `../assets`（父工程）> `resources/brand/`（镜像，CI 用）。
 */
export function loadMaterial(argv = []) {
  ensureFfmpeg();
  const flagIndex = argv.indexOf('--assets');
  const explicit = flagIndex >= 0 && argv[flagIndex + 1]
    ? resolve(argv[flagIndex + 1])
    : process.env.PI_ASSETS_DIR
      ? resolve(process.env.PI_ASSETS_DIR)
      : null;
  const parentDir = resolve(projectRoot, '..', 'assets');

  let assetsDir;
  let fromMirror = false;
  if (explicit) {
    assetsDir = explicit;
  } else if (existsSync(parentDir)) {
    assetsDir = parentDir;
  } else {
    assetsDir = MIRROR_DIR;
    fromMirror = true;
  }

  if (!existsSync(assetsDir)) {
    fail(
      `物料目录不存在：${assetsDir}\n` +
        `  品牌化依赖**父工程** assets/（见 specs/012-branding/spec.md §4.1）；CI 场景依赖仓内镜像 resources/brand/。\n` +
        `  可用 --assets <dir> 或 PI_ASSETS_DIR 指定。`,
    );
  }

  const missing = MATERIAL_FILES.filter((name) => !existsSync(join(assetsDir, name)));
  if (missing.length > 0) {
    fail(
      `物料缺失（${missing.length} 项）：${missing.join('、')}\n` +
        `  目录：${assetsDir}\n` +
        `  期望物料清单见 specs/012-branding/spec.md §4.1；**不得**静默降级为无品牌产物。`,
    );
  }

  const markSrc = join(assetsDir, 'logo.png');
  const masterSrc = join(assetsDir, 'logo-1024-with-bg.png');
  const trayBgSrc = join(assetsDir, 'logo-200-with-bg.png');
  const svgSrc = join(assetsDir, 'logo.svg');
  const icoSrc = join(assetsDir, 'logo.ico');
  const icnsSrc = join(assetsDir, 'logo.icns');

  const mark = pngInfo(markSrc);
  const master = pngInfo(masterSrc);
  const trayBg = pngInfo(trayBgSrc);
  if (!mark) fail(`物料不是 PNG：${markSrc}`);
  if (!master) fail(`物料不是 PNG：${masterSrc}`);
  if (!trayBg) fail(`物料不是 PNG：${trayBgSrc}`);

  if (master.width !== 1024 || master.height !== 1024) {
    fail(`不透明母版必须是 1024×1024：${masterSrc}（实际 ${master.width}×${master.height}）`);
  }
  if (mark.width < 200 || mark.height < 200) {
    fail(`透明标记尺寸不足（至少 200×200，供 192/180² 图标下采样）：${markSrc}（实际 ${mark.width}×${mark.height}）`);
  }
  if (trayBg.width < 200 || trayBg.height < 200) {
    fail(`托盘物料尺寸不足（至少 200×200）：${trayBgSrc}（实际 ${trayBg.width}×${trayBg.height}）`);
  }
  if (!mark.hasAlphaChannel) {
    fail(`logo.png 必须带透明通道（作为透明标记/macOS 托盘模板用）：${markSrc}（colorType=${mark.colorType}）`);
  }

  // 母版/托盘底必须**真的**不透明：应用级图标要求无 alpha；若物料本身带透明，压平后透明区会变黑/白边。
  const masterMinAlpha = minAlpha(masterSrc);
  if (masterMinAlpha !== 255) {
    fail(`不透明母版含透明像素（minAlpha=${masterMinAlpha}）：${masterSrc}\n  应用级图标要求 1024×1024 且不透明；请改用不带透明的母版。`);
  }
  const trayBgMinAlpha = minAlpha(trayBgSrc);
  if (trayBgMinAlpha !== 255) {
    fail(`托盘物料含透明像素（minAlpha=${trayBgMinAlpha}）：${trayBgSrc}\n  托盘图标需要不透明底（浅色/深色任务栏都可见）；透明标记请用 logo.png。`);
  }
  // 透明标记必须**真的**有透明像素：否则托盘模板/小图标会变成一整块实心方块
  // （透明通道存在但全 255，最容易发生的误配置）。
  const markMinAlpha = minAlpha(markSrc);
  if (markMinAlpha === 255) {
    fail(`透明标记不含任何透明像素（minAlpha=255）：${markSrc}\n  小图标与 macOS 托盘模板依赖它的透明底；请提供带透明背景的 logo.png。`);
  }

  const icoCount = assertIco(icoSrc);
  const icnsBytes = assertIcns(icnsSrc);

  const svgText = readFileSync(svgSrc, 'utf8');
  if (!/<svg[\s>]/i.test(svgText) || !/viewBox\s*=/.test(svgText)) {
    fail(`矢量物料不像合法 SVG（需要 <svg …> 与 viewBox）：${svgSrc}\n  若这是被截断/错误保存的文件，请重新导出。`);
  }

  const material = {
    assetsDir,
    markSrc, masterSrc, trayBgSrc, svgSrc, icoSrc, icnsSrc,
    mark, master, trayBg, markMinAlpha, masterMinAlpha, trayBgMinAlpha,
    icoCount, icnsBytes,
  };

  console.log(`${LOG} 物料：${assetsDir}${fromMirror ? '（父工程不在，使用仓内镜像）' : ''}`);
  console.log(
    `${LOG}   透明标记 logo.png ${mark.width}×${mark.height}（含 alpha，minAlpha=${markMinAlpha}）｜` +
      `不透明母版 ${master.width}×${master.height}（minAlpha=255）｜` +
      `托盘底 ${trayBg.width}×${trayBg.height}（minAlpha=255）`,
  );
  console.log(`${LOG}   logo.ico ${icoCount} 个图像｜logo.icns ${icnsBytes} 字节｜logo.svg（viewBox 已校验）`);

  if (!fromMirror) mirrorMaterial(material);
  return material;
}

/**
 * 物料镜像：把父工程物料**逐字节**固化到本仓 `resources/brand/`（入库）。
 *
 * 为什么需要：CI 只 checkout 本仓（`ci.yml` 用 `git clone` 拉 `../pi`、`../pi-web`），拿不到父工程
 * `assets/`；若没有镜像，CI 会打不出品牌产物（或者只能静默降级）。父工程在场时**以父工程为准**并刷新镜像，
 * 因此镜像不可能腐化 —— 物料一改，`git status` 立刻显示镜像变化，必须一起提交。
 */
function mirrorMaterial(material) {
  mkdirSync(MIRROR_DIR, { recursive: true });
  console.log(`${LOG} 固化物料镜像 → ${relative(projectRoot, MIRROR_DIR).replaceAll('\\', '/')}/`);
  for (const name of MATERIAL_FILES) {
    copyExact(join(material.assetsDir, name), join(MIRROR_DIR, name));
  }
}

// ---------------------------------------------------------------- 本工程自有图标位

/**
 * 写本工程自有的图标位（应用/托盘/安装器图标）。幂等。
 *
 * 只换文件内容，不改 `forge.config.ts` 的引用名（`resources/icon`、`resources/tray*.png`），
 * 因此不存在配置漂移风险。
 */
export function applyRepoBranding({ material, log = true } = {}) {
  const m = material ?? loadMaterial();
  const results = [];
  for (const [rel, spec] of Object.entries(REPO_ICONS)) {
    const dst = join(projectRoot, rel);
    copyExact(join(m.assetsDir, spec.from), dst, { log: false });
    if (spec.width) {
      const info = pngInfo(dst);
      if (!info || info.width !== spec.width || info.height !== spec.height) {
        fail(`图标位尺寸不符：${dst}（期望 ${spec.width}×${spec.height}）`);
      }
      const min = minAlpha(dst);
      if (spec.opaque && min !== 255) fail(`该图标位必须不透明：${dst}（minAlpha=${min}）`);
      if (!spec.opaque && min === 255) fail(`该图标位必须含透明像素：${dst}（minAlpha=255）`);
    }
    results.push({ rel, from: spec.from, sha256: sha256File(dst) });
  }
  if (log) {
    console.log(`${LOG} ✔ 本工程图标 ${results.length} 项已按物料固化（逐字节一致）`);
    for (const r of results) console.log(`${LOG}   ${r.rel}  ←  ${r.from}  sha256=${r.sha256.slice(0, 12)}…`);
  }
  return results;
}

// ---------------------------------------------------------------- Web 产物（pi-dist 副本）

/** 二进制判定：前 8 KiB 有 NUL 或非 UTF-8 → 不做文本替换。 */
function isProbablyText(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  for (const byte of head) if (byte === 0) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function countOccurrences(text, needle) {
  let count = 0;
  let index = text.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * 品牌文案 + Logo `src` 路径替换（只在 `pi-dist` 副本上）。
 *
 * 同时统计**技术标识符**集合的出现次数：替换前后必须逐项不变（FR-012-002 的回归断言）。
 */
function replaceBrandInTree(roots, { skipDirs = new Set() } = {}) {
  const stats = {
    scanned: 0, changed: 0, skippedLarge: 0, skippedBinary: 0,
    brand: 0, logoPath: 0, techBefore: 0, techAfter: 0, changedFiles: [],
  };

  for (const root of roots) {
    for (const file of walkFiles(root, { skipDirs })) {
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      if (size === 0 || size > MAX_TEXT_BYTES) {
        if (size > MAX_TEXT_BYTES) stats.skippedLarge += 1;
        continue;
      }
      const buf = readFileSync(file);
      if (!isProbablyText(buf)) {
        stats.skippedBinary += 1;
        continue;
      }
      stats.scanned += 1;
      const text = buf.toString('utf8');
      for (const id of TECH_IDENTIFIERS) stats.techBefore += countOccurrences(text, id);

      let next = text;
      let brandHits = 0;
      let logoHits = 0;
      if (next.includes(BRAND_FROM)) {
        brandHits = countOccurrences(next, BRAND_FROM);
        next = next.split(BRAND_FROM).join(BRAND_TO);
      }
      for (const [from, to] of LOGO_SRC_REPLACEMENTS) {
        if (!next.includes(from)) continue;
        logoHits += countOccurrences(next, from);
        next = next.split(from).join(to);
      }

      for (const id of TECH_IDENTIFIERS) stats.techAfter += countOccurrences(next, id);
      if (brandHits === 0 && logoHits === 0) continue;

      writeFileSync(file, next, 'utf8');
      stats.brand += brandHits;
      stats.logoPath += logoHits;
      stats.changed += 1;
      stats.changedFiles.push({ file: relative(root, file).replaceAll('\\', '/'), brandHits, logoHits });
    }
  }
  return stats;
}

/** 统计全树（排除 `node_modules`）内某字面量的出现次数。 */
function countInTree(root, needle, { skipDirs = new Set(['node_modules']) } = {}) {
  const hits = [];
  let total = 0;
  for (const file of walkFiles(root, { skipDirs })) {
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      continue;
    }
    if (buf.length === 0 || buf.length > MAX_TEXT_BYTES) continue;
    if (!isProbablyText(buf)) continue;
    const count = countOccurrences(buf.toString('utf8'), needle);
    if (count > 0) {
      total += count;
      hits.push(`${relative(root, file).replaceAll('\\', '/')}（${count} 处）`);
    }
  }
  return { total, hits };
}

/**
 * 写 `pi-dist` 副本的 web 品牌：图标 + favicon 路由体 + `logo.svg` + 文案/Logo 路径替换，最后**后置断言**。
 *
 * 断言（spec FR-012-004，**状态式**，因此可重跑）：
 * ① 预渲染 HTML 内不得残留 `Pi Web`、必须出现 `Pi Desktop`；
 * ② 全树不得残留**旧 Logo 渲染路径**（`src:"/icons/apple-touch-icon.png"` 等），且必须出现 `/icons/logo.svg`；
 * ③ 技术标识符集合的出现次数不变；
 * ④ `logo.svg` 与物料**逐字节一致**。
 * 任一不满足 → 失败（构建失败比发一个无品牌包好）。
 */
export function applyWebBranding(piDistDir, { material } = {}) {
  const m = material ?? loadMaterial();
  if (!existsSync(piDistDir)) fail(`pi-dist 不存在：${piDistDir}（先跑 collect-pi 的组装阶段）`);

  const publicIcons = join(piDistDir, 'public', 'icons');
  mkdirSync(publicIcons, { recursive: true });
  // ① 页面 Logo（矢量，任意尺寸清晰）—— 与物料**逐字节一致**（`cpSync`，不经 ffmpeg）
  const logoSvg = copyExact(m.svgSrc, join(publicIcons, 'logo.svg'), { log: false });
  // ② 小位图：透明标记下采样（200 → 192/180，不放大）
  scaleTo(m.markSrc, join(publicIcons, 'icon-192.png'), { width: 192, height: 192, alpha: true });
  scaleTo(m.markSrc, join(publicIcons, 'apple-touch-icon.png'), { width: 180, height: 180, alpha: true });
  // ③ 大位图：不透明母版下采样（512²；PWA/launcher 用，带底更像应用图标；不允许把 200² 放大）
  scaleTo(m.masterSrc, join(publicIcons, 'icon-512.png'), { width: 512, height: 512, alpha: false });
  // ④ favicon：上游把它编译成路由体（内容是 PNG 字节），此处同样写 PNG 字节（文件名保持 .ico）
  const faviconBody = join(piDistDir, '.next', 'server', 'app', 'favicon.ico.body');
  if (!existsSync(faviconBody)) {
    fail(`未找到 favicon 路由体：${faviconBody}\n  pi-web 构建产物结构可能已变（favicon 现在可能走别的路径）；请更新 brand-assets.mjs 后再构建 —— 不得静默沿用上游图标。`);
  }
  scaleTo(m.markSrc, faviconBody, { width: 192, height: 192, alpha: true });

  // ⑤ 文案与 Logo `src` 路径替换（全树，排除 node_modules）
  const stats = replaceBrandInTree([piDistDir], { skipDirs: new Set(['node_modules']) });
  console.log(`${LOG} ✔ web 品牌替换：扫描 ${stats.scanned} 个文本文件，改写 ${stats.changed} 个（文案 ${stats.brand} 处、Logo 路径 ${stats.logoPath} 处）`);
  if (stats.skippedBinary > 0) console.log(`${LOG}   跳过二进制 ${stats.skippedBinary} 个${stats.skippedLarge > 0 ? `、超大文本 ${stats.skippedLarge} 个` : ''}`);
  if (stats.brand === 0) warn(`本次未改写任何 "${BRAND_FROM}"（重复运行、或 pi-web 已自行改名）`);

  // ⑥ 后置断言（状态式）
  if (stats.techBefore !== stats.techAfter) {
    fail(`品牌化断言失败：技术标识符出现次数被改变（${stats.techBefore} → ${stats.techAfter}）—— 替换规则误伤，请检查 brand-assets.mjs 的 BRAND_FROM/LOGO_SRC_REPLACEMENTS`);
  }
  for (const rel of ['.next/server/app/index.html', '.next/server/app/login.html']) {
    const file = join(piDistDir, rel);
    if (!existsSync(file)) {
      fail(`品牌化断言失败：缺少预渲染文档 ${rel}（pi-web 构建产物结构已变，请更新 brand-assets.mjs 的断言）`);
    }
    const html = readFileSync(file, 'utf8');
    const remaining = countOccurrences(html, BRAND_FROM);
    if (remaining > 0) fail(`品牌化断言失败：${rel} 仍含 ${remaining} 处 "${BRAND_FROM}"（替换规则需更新：pi-web 可能改了文案写法）`);
    if (!html.includes(BRAND_TO)) fail(`品牌化断言失败：${rel} 未出现 "${BRAND_TO}"`);
  }
  for (const [from] of LOGO_SRC_REPLACEMENTS) {
    const { total, hits } = countInTree(piDistDir, from);
    if (total > 0) {
      fail(`品牌化断言失败：仍有 ${total} 处旧 Logo 渲染路径 "${from}"\n  ${hits.slice(0, 10).join('\n  ')}`);
    }
  }
  const logoRefs = countInTree(piDistDir, '/icons/logo.svg');
  if (logoRefs.total === 0) fail(`品牌化断言失败：全树未见 "/icons/logo.svg"（页面 Logo 未替换）`);
  if (sha256File(logoSvg) !== sha256File(m.svgSrc)) fail(`品牌化断言失败：${logoSvg} 与物料 ${m.svgSrc} 不一致`);

  console.log(`${LOG} ✔ 断言通过：index.html/login.html 无 "${BRAND_FROM}"、含 "${BRAND_TO}"；旧 Logo 路径 = 0 处；"/icons/logo.svg" = ${logoRefs.total} 处；技术标识符计数未变（${stats.techAfter}）；logo.svg 与物料逐字节一致`);
  return { stats, favicon: faviconBody, logoRefs: logoRefs.total };
}

/**
 * 全树终检：`pi-dist`（排除 `node_modules`）内**不得**再出现 `Pi Web`。
 *
 * 为什么需要单独一步：`collect-pi` 在品牌化前后会投放 `resources/pi-agent/`（预置 `settings/mcp`）等目录，
 * 那些文件里的旧品牌只能靠这一步兜住；同时它也是「全树 0 处」这条规格的机器证据。
 */
export function assertNoBrandLeftovers(piDistDir) {
  const { total, hits } = countInTree(piDistDir, BRAND_FROM);
  if (total > 0) {
    fail(`品牌化终检失败：pi-dist 内仍有 ${total} 处 "${BRAND_FROM}" ——\n  ${hits.slice(0, 20).join('\n  ')}${hits.length > 20 ? `\n  …共 ${hits.length} 个文件` : ''}`);
  }
  console.log(`${LOG} ✔ 终检通过：pi-dist（排除 node_modules）内 "${BRAND_FROM}" = 0 处`);
  return { hits: 0 };
}

// ---------------------------------------------------------------- CLI

function main() {
  const argv = process.argv.slice(2);
  const material = loadMaterial(argv);
  console.log(`${LOG} ── ① 本工程自有图标位（resources/）`);
  applyRepoBranding({ material });
  const piDistDir = join(projectRoot, 'pi-dist');
  if (existsSync(piDistDir)) {
    console.log(`${LOG} ── ② pi-dist 副本（web 图标 + 文案 + Logo 路径）`);
    applyWebBranding(piDistDir, { material });
    console.log(`${LOG} ── ③ pi-dist 终检（排除 node_modules）`);
    assertNoBrandLeftovers(piDistDir);
  } else {
    console.log(`${LOG} 跳过 pi-dist（尚未生成；collect-pi 会自行调用本模块）`);
  }
  console.log(`${LOG} 完成。`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
