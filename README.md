[中文](./README_zh.md) | English

---

# Pi Desktop

> A **first-class desktop app for Windows / macOS / Linux** that wraps
> [Pi](https://github.com/earendil-works/pi) (an extensible agent harness) and its browser UI
> [Pi Web](https://github.com/agegr/pi-web): Electron **43.7.9** hosts **`pi-web`'s Next server
> (agent + `/api/*`)** inside the main process, and the renderer loads the Pi Web UI from that same
> origin. The desktop shell adds what `pi` itself does not ship (tray, native notifications, single
> instance, window state, artifact bootstrap, update guidance) while the UI is **100% upstream** —
> no frontend fork.

**Version**: `0.11.1` (tag `v0.11.1`; **Phase 0 fully measured**, see [docs/构建验证记录.md](docs/构建验证记录.md))
· **Upstream baseline**: `pi` **v1.1.0** (`Branch_v1.1.0`) + `pi-web` **v0.11.1** (`Branch_v0.11.1`)
· **Runtime**: Electron **43.7.9** (Node **24.21.0** / Chromium **150.0.7871.250** / ABI **148**)
· **App name / executable / app ID**: `Pi Desktop` / `pi-desktop` / `com.fellow99.pi.desktop`

**Engineering plan (source of truth)**: [docs/工程规划.md](docs/工程规划.md) — what we build, how, in what order, and the risks.

---

## What is this

`Pi` is a minimal, extensible agent harness: extensions, skills, prompt templates and themes are all
replaceable, and it ships four integration entry points (CLI / RPC / JSON / SDK). `Pi Web` is its local
browser UI (a Next.js 16 App Router app) where **one Node process serves both the SPA and `/api/*`**,
and the agent is created inside that process (`lib/rpc-manager.ts` imports the
`@earendil-works/pi-coding-agent` SDK directly — **no `pi` binary on `PATH` required**).

This project puts that stack inside an Electron desktop shell: after launch the user **sees the Pi
interface directly** — no manual server start, no browser, no password prompt. It is **not** a thin
"browser pointing at localhost" shell: the server and the agent run in-process in the Electron main
process, and the shell owns environment assembly, artifact bootstrap, lifecycle and platform features.

> **Unofficial**: this project is not built by the Pi / Pi Web teams, has no affiliation with the
> upstream authors and is not endorsed by them. `Pi` (MIT,
> [earendil-works/pi](https://github.com/earendil-works/pi)) and `Pi Web` (MIT,
> [agegr/pi-web](https://github.com/agegr/pi-web)) are upstream open-source projects; this project only
> **assembles** them — no fork, no upstream source changes (**0 required patches**, see plan §7).

## Core design

```
┌─ Pi Desktop (Electron 43.7.9) ──────────────────────────────────────────────┐
│  Electron main process (Node 24.21.0)                                       │
│    ├─ env assembly: PI_CODING_AGENT_DIR / PI_WEB_* / NO_PROXY / proxy bypass│
│    ├─ artifact bootstrap: pi-dist.tar.gz → <userData>/pi-dist (SHA-256 marker)│
│    ├─ rotatePreviewSecrets(<pi-dist>/.next)   ← must run before the server  │
│    ├─ chdir(<pi-dist>)                       ← Next's project-root basis    │
│    ├─ in-process Next server: startServer({dir, hostname:'127.0.0.1', port})│
│    │     ├─ SPA (Pi Web UI) + /api/* + SSE /api/agent/[id]/events           │
│    │     └─ agent sessions (pi SDK, same process)                           │
│    ├─ readiness: HTTP polling on /api/web-auth (**no stdout parsing**)      │
│    ├─ desktop features: tray / notifications / window state / single inst.  │
│    └─ window: BrowserWindow → loadURL('http://127.0.0.1:<port>/')           │
│                              ▲ same origin (no CORS, no custom protocol,    │
│                                zero IPC on the data path)                   │
│    ┌─────────────────────────┴──────────────────────────────────────────┐   │
│    │ renderer (Chromium 150): the stock Pi Web UI                        │   │
│    │   fetch('/api/*') up · EventSource('/api/agent/[id]/events') down    │   │
│    └────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

Startup sequence (**fail-visible**: any failing stage is shown on the loading page with the exact stage
and reason, and logged to `<userData>/logs/`):

```
[lock] single-instance lock → [env] environment assembly → [artifact] artifact bootstrap (first run: extract)
  → [secret] preview-secret rotation → [cwd] chdir to the artifact root → [server] in-process Next (random port + random password)
  → [ready] HTTP readiness polling (30 s cap) → [auth] inject session credentials → [load] loadURL(http://127.0.0.1:<port>/) → first screen
```

### Differences from "`pi` CLI + a browser on `pi-web`"

| Aspect | `pi` CLI + browser on `pi-web` | **Pi Desktop** |
|---|---|---|
| Startup | start the server, open a browser, paste the URL | one chain: extract → start server → poll readiness → create window |
| Server shape | `bin/pi-web.js` spawns a **child process** (`spawn(process.execPath, [next,'start',…])`) | **in-process** in the main process (`startServer({dir,hostname,port})`); no child, no orphans, no process-tree cleanup |
| Readiness | parse the child's stdout for `Ready` | **HTTP polling** of `/api/web-auth` (unauthenticated liveness probe, expects **200**) |
| Port | fixed `30141` (`PORT`/`-p`) | **random free high port** (probed via `listen(0)`, then released) |
| Bind | `127.0.0.1` (`PI_WEB_HOSTNAME`/`-H`) | `127.0.0.1` (same; no loopback-isolation issue) |
| Auth | type the password; with no `PI_WEB_PASSWORD` there is **no auth at all** | **the host generates a random strong password** (never logged, never echoed) and injects **two credentials**: the `pi_web_session` cookie (page navigation) + `Authorization: Basic pi:<pw>` (`/api/*` and SSE) → **the user never sees the login page** |
| Artifact location | `.next` lives in the source tree; secret rotation writes back into it (read-only → keeps build-time secrets) | `pi-dist.tar.gz` ships with the app and is **extracted into `<userData>/pi-dist` on first run** (guaranteed writable → secrets can be rotated) |
| Data location | `~/.pi/agent` | **shares** `~/.pi/agent` by default (reuses your existing pi environment); switchable to `<userData>/pi-agent` in settings |
| Desktop features | none | tray, native notifications (session JSONL tailing), single-instance recall, window-state memory, F11, external links to the system browser, update check |
| Branding | upstream `Pi Web` copy and icons | **`Pi Desktop` brand + icons from the parent project's assets** (next section) |
| Shutdown | Ctrl-C in the terminal | graceful chain: set `isQuitting` → close SSE → `httpServer.close()` → hard exit after a `5 s` deadline |
| Upgrade | manual `git pull` + rebuild | ship a new `pi-dist.tar.gz`; a changed SHA-256 marker triggers a **re-extract** with no stale files |

## Branding and icons (requirement 012-branding)

Because this is an assembly project, branding is applied **only to our own artifacts** (`pi-dist/` copy
and `resources/`), leaving all three upstream repos untouched:

| Item | Approach |
|---|---|
| UI copy | at build time, the spaced literal `Pi Web` → `Pi Desktop` inside the `pi-dist` copy (measured this round: **1035 occurrences / 36 files**); technical identifiers (`pi-web`, `PI_WEB_*`, `PiWeb`, …) keep **identical counts before/after** (757 → 757) |
| Page logo | only the **rendered** `<img src>` is rewritten to the vector asset `/icons/logo.svg` (6 places); the `rel="apple-touch-icon"` metadata and the `public/sw.js` precache list are **left alone** |
| Web bitmap icons | `public/icons/{icon-512,icon-192,apple-touch-icon}.png` plus the `favicon.ico` route body are generated from the assets and verified by **reading back the IHDR** (512² rgb24 opaque; the rest carry alpha) |
| App icons | `resources/{icon.png,icon.ico,icon.icns,tray.png,trayTemplate.png}` are **byte-for-byte** copies of the assets; the window icon explicitly uses them |
| Asset source | the **parent project's `<workspace>/assets/`** (single source of truth; missing / wrong size / wrong transparency ⇒ **build failure**), mirrored into `resources/brand/` for CI |
| Version check | the runtime sets `PI_WEB_SKIP_VERSION_CHECK=1`: `/api/app-update` returns `updateAvailable=false` and `releaseUrl=""` while **still reporting `currentVersion`** (measured `0.11.1`); the shell's own "check for updates" is the only update path |
| Implementation | `scripts/brand-assets.mjs` (also runnable as `npm run brand`) wired into `scripts/collect-pi.mjs`; three layers of post-assertions plus a whole-tree final check (`Pi Web` = 0 occurrences) |

## Capabilities

Legend: **✅ measured** | **⚠️ conditional / limited** | **⬜ not yet measured** (with the probe that will produce the verdict) | **❌ explicitly out of scope**.
The full three-platform matrix, evidence column and degradation matrix live in
**[docs/桌面能力清单.md](docs/桌面能力清单.md)**; per-round evidence in
**[docs/构建验证记录.md](docs/构建验证记录.md)** (Windows rounds 1 and 2).

| Capability | Windows | Notes |
|---|---|---|
| Pi Web UI (main screen, same-origin) | ✅ | packaged first screen reached; UI marker hit; `document.title = Pi Desktop` |
| In-process Next server + agent | ✅ | `startServer({dir,…})` listens, all `/api/*` return 200, main process stays alive, preview secrets rotated (P0-1) |
| Session persistence / resume (JSONL) | ✅ | session created (200), first SSE chunk arrives, a real conversation returns a reply (P0-2 / TC-14) |
| Models and credentials (API key) | ✅ | set a DeepSeek API key in the packaged app → one real conversation succeeded (shares `~/.pi/agent/auth.json`) |
| File tools (read/write/edit/list/images) | ✅ | used by the agent; provided by the upstream SDK, no platform constraints |
| Terminal panel / PTY | ✅ | `node-pty` **loads** under ABI 148 and runs a command (`POST /api/terminal` → write → output received on the stream) |
| MCP (stdio / HTTP) | ⬜ | no subprocess constraints on desktop, expected to work; not measured item by item |
| `git` / worktree / diff | ⬜ | requires `git` on the machine; upstream degrades silently when missing |
| Content search (`rg`/`fd`) | ⚠️ | needs a system install or a permitted download; unavailable offline (`PI_OFFLINE=1`) |
| Extension / skill install | ⚠️ | needs `npm`/`git` and network; the upstream UI already manages them |
| Tray / single instance / window state | ✅ | tray created; single-instance lock + recall; window state persisted |
| Native notifications | ✅ | only when the window is hidden/unfocused; 10 s per-session cooldown dedupe; no backlog on startup; measured latency **2054 ms** |
| Browser secure context (`crypto.subtle` / `localStorage`) | ✅ | loopback counts as a trusted origin: `isSecureContext=true`, SHA-256 computed, localStorage read/write OK |
| `window.open` interception | ✅ | returns `null`; external links go to the system browser |
| Update check (semi-automatic) | ✅ | "check → open the download page"; **no auto-download, no silent install** |
| Deep links / auto-start / global shortcuts / multi-window | ❌ | explicitly out of scope (revisit in Phase 2 if needed) |
| Code signing / notarization / silent update | ❌ | not in v1; registered for Phase 3 |
| Cross-platform packaging | ❌ | each platform builds its own artifacts (native modules must match the target) |

## Target platforms and distribution

| Platform | Artifacts | Install experience (**unsigned**) | Status |
|---|---|---|---|
| Windows (primary) | Squirrel `Pi Desktop-<version> Setup.exe` + `.nupkg` + `RELEASES`, `zip` | direct install; SmartScreen shows "More info → Run anyway" | ✅ measured: `make` → install → launch to first screen → uninstall (below) |
| macOS | `.dmg` + `zip` | requires **right-click → Open**, or `xattr -dr com.apple.quarantine "/Applications/Pi Desktop.app"` | ⬜ never run on macOS |
| Linux | `.deb` + `.rpm` + `zip` | direct install (no mandatory signing gate) | ⬜ never run on Linux |

**Measured Windows numbers (round 2)**: `Pi Desktop-0.11.1 Setup.exe` = **351,521,280 B**; installed to
`%LOCALAPPDATA%\pi_desktop\app-0.11.1`; launching the **installed copy** reaches the first screen
(re-running `probe-renderer` against it still gives 7 PASS / 0 FAIL); after uninstall the registry entry
is gone and **0 orphan processes** remain.
⚠️ Squirrel's uninstall keeps the install root (`Update.exe` + a shell directory, ≈2.7 MB measured) and
`<userData>` is kept by design — see [docs/发布与更新.md](docs/发布与更新.md) §4 "uninstall behaviour and residue".

Release flow, artifact list, unsigned-install guidance and update behaviour: **[docs/发布与更新.md](docs/发布与更新.md)**.
`.github/workflows/release.yml` is triggered by a **tag `v*`** push (or manual `workflow_dispatch`),
builds the three-OS matrix and publishes the Release assets.

## Technology stack

| Layer | Component | Version | Notes |
|---|---|---|---|
| Runtime | Electron | **43.7.9** (pinned, no `^`) | Node **24.21.0** / Chromium **150.0.7871.250** / ABI **148** |
| Runtime | Node (bundled with Electron) | 24.21.0 | satisfies upstream `engines.node >= 22.19.0`; none of the HarmonyOS Node-mismatch reasoning applies |
| Build | Electron Forge | `^7.11.2` | `@electron-forge/plugin-vite` + `@electron/fuses` `^1.8.0` |
| Build | Vite | `^7.3.6` (`vite.{main,preload,renderer}.config.ts`) | main entry `src/main/index.ts` → `.vite/build/main.js` |
| Build | TypeScript | `^5.6.0` (strict, `tsc --noEmit`) | `@types/node` `^24.3.0` |
| Build | makers | 5 Forge makers | Squirrel(win) / ZIP(win,mac,linux) / DMG(mac) / RPM(linux) / DEB(linux) |
| CI | Node | **24.21.0** | same version as the runtime (the gate starts the server with the same Node) |
| Upstream (shipped inside `pi-dist`) | `pi-web` | **0.11.1** (Next **16.3.8** App Router) | SPA + `/api/*` (~90 routes) + SSE |
| Upstream (shipped inside `pi-dist`) | `pi` | **1.1.0** (`@earendil-works/pi-coding-agent`, …) | in-process SDK; `packages/*` locked at 1.1.0 |
| Upstream native module | `node-pty` | 1.2.0-beta.15 | `serverExternalPackages`; **measured loadable under ABI 148** (round 2) with a build-time completeness gate (`FR-010-027`) |

The shell's only runtime dependency is `electron-squirrel-startup`; `next` / `@earendil-works/*` /
`node-pty` all come from `pi-dist` (the shipped `pi-dist.tar.gz`) and are **not part of the shell build**.

## Development

### Prerequisites

| Item | Requirement |
|---|---|
| Node | **24.21.0** (official binary; matches the version bundled with Electron 43.7.9). The upstream gate is `>=22.19.0`, but the gate script must match the runtime to represent real behaviour |
| Sibling projects | `../pi` (submodule, `Branch_v1.1.0`), `../pi-web` (submodule, `Branch_v0.11.1`) — this project uses **sibling source references**, not npm dependencies |
| Brand assets | `../assets/` (parent project: `logo.svg`, `logo.png`, `logo-1024-with-bg.png`, `logo-200-with-bg.png`, `logo.ico`, `logo.icns`) — missing assets fail the build (override with `--assets` or `PI_ASSETS_DIR`) |
| Package manager | `npm` (`npm ci` against each lockfile) |
| git | clone submodules, `pin:upstream` records SHAs, `git/worktree` capability checks |
| Linux packaging | `fakeroot` + `rpm` (installed in CI) |
| Optional | `ELECTRON_MIRROR` (slow Electron binary downloads), `ffmpeg` (needed to generate the web bitmap icons) |

> Why `pi` / `pi-web` must be sibling sources rather than npm dependencies: `pi-web`'s `.next` has to be
> built **reproducibly on this machine** (we control `serverExternalPackages`, prune native modules per
> target platform, and rotate preview secrets before packaging), and `pi-web` pins `pi` to **exactly
> 1.1.0**, so a source reference keeps both sides in lockstep (plan §2.5).

### Four-stage build pipeline

```bash
# 1. build pi-web's production output (../pi-web: npm ci → native-dependency check → next build)
node scripts/prepare-next.mjs

# 2. gate: start the server with the same Node as Electron 43.7.9 (24.21.0); assert SPA / API / SSE / SDK
node scripts/smoke-desktop.mjs

# 3. assemble pi-dist (pi-web output + @earendil-works/* + preset templates) → brand → final check → tar.gz(ustar) + SHA-256 marker
node scripts/collect-pi.mjs

# 4. package (premake runs 1→3 automatically so one command reproduces everything)
npm run make            # installers, output in out/make/
npm run package         # packaged directory only, no installers
```

Equivalent npm scripts:

```bash
npm run prepare:next    # = node scripts/prepare-next.mjs
npm run smoke           # = node scripts/smoke-desktop.mjs
npm run collect:pi      # = node scripts/collect-pi.mjs
npm run brand           # = node scripts/brand-assets.mjs (asset validation + icon freeze + pi-dist branding)
npm run pin:upstream    # record ../pi and ../pi-web commit SHAs → upstream.lock.json
npm run probe:renderer  # renderer/terminal assertions against a **running** app (needs --debug-port)
```

> ⚠️ Native-module pruning happens only on the **copy** (`pi-dist`), never inside the `../pi-web` source
> tree; each platform builds its own artifacts (cross-packaging would ship the wrong native modules for
> `node-pty` / SWC).
>
> ⚠️ Native-dependency completeness is part of the build gate (`FR-010-027`): `prepare-next` verifies that
> `node-pty` actually has `build/Release/*.node` or `prebuilds/<platform>-<arch>/*.node`; **an empty shell
> directory fails the build** with a fix recipe. Reason: upstream `scripts/prebuild.js` only checks whether
> the directory exists, so an empty one is mistaken for "prebuilt" and `node-gyp` is skipped — the symptom
> only surfaces at runtime as a terminal HTTP 500 (hit on this machine).

### Running

```bash
npm ci && npm start     # Electron Forge + Vite; main-process hot reload, renderer is a remote URL (debug via DevTools)
```

`npm start` needs an extracted `pi-dist`: run pipeline stages 1–3 first, or point `PI_DESKTOP_PI_DIST`
at an existing directory. The packaged app extracts `<resources>/pi-dist.tar.gz` into
`<userData>/pi-dist` on first launch (~2 minutes for tens of thousands of files; skipped when the marker matches).

### Debugging

```bash
# Direct server/UI debugging (skips extraction and the embedded server): first run a server in ../pi-web
cd ../pi-web && npm ci && npm run build && npm start   # http://127.0.0.1:30141

# Back in this project, point the shell at it
PI_DESKTOP_DEV_SERVER=http://127.0.0.1:30141 npm start   # Git Bash
# PowerShell: $env:PI_DESKTOP_DEV_SERVER='http://127.0.0.1:30141'; npm start
```

**Environment switches (development only; never used in production)**

| Variable | Purpose | Status |
|---|---|---|
| `PI_DESKTOP_DEV_SERVER` | attach to an already-running pi-web (skips extraction and the embedded server) for fast UI/server iteration | implemented: `src/main/index.ts` |
| `PI_DESKTOP_PI_DIST` | point at an **extracted** `pi-dist` directory (skips extraction and the marker check); the value is resolved to an absolute path so it survives `chdir` | implemented: `src/main/artifact.ts` |
| `PI_DESKTOP_HOST_MODE=spawn` | explicitly use the sidecar (`next start` child) instead of the in-process host, for A/B diagnosis | implemented: `src/main/host.ts` |

Other diagnostics:

- **Logs**: `<userData>/logs/pi-desktop-<YYYYMMDD>.log`, uniformly prefixed `[pi-desktop]`; every startup
  stage is logged, and credentials are only reported by length — `PI_WEB_PASSWORD` is **never echoed**.
- **Loading / fallback page**: `index.html` + `src/renderer/renderer.ts` show the current stage and elapsed
  time, and offer "open logs" / "retry" / "quit"; failures display the **exact stage and reason**.
- **Main-process debugging**: `--inspect` is development-only (production builds must drop it; the Fuse
  `EnableNodeCliInspectArguments` is disabled).
- **Data location**: defaults to `PI_CODING_AGENT_DIR = ~/.pi/agent` (sharing credentials, sessions,
  extensions and MCP with the CLI); settings can switch it to `<userData>/pi-agent` (the `agentDirMode`
  key in `<userData>/pi-desktop-settings.json`; **restart required**). ⚠️ Do not write to the same session
  concurrently with the `pi` CLI (explicitly unsupported upstream).

### Gates and probes

```bash
npm run typecheck                # strict TS (tsc --noEmit)
node scripts/smoke-desktop.mjs   # four server assertions: SPA / credentialed API / SSE / pi SDK session

# Packaged end-to-end (start the packaged app first, then assert against the **running** instance; the probe never starts or stops processes)
"out/Pi Desktop-win32-x64/pi-desktop.exe" --remote-debugging-port=9333
node scripts/probe-renderer.mjs --debug-port 9333 --cwd <writable dir>   # R1–R7
```

`typecheck` and `smoke` must both be green before packaging or releasing; CI
(`.github/workflows/ci.yml`) enforces the same two (in the order
`prepare-next → collect-pi → smoke → make`).

## Repository layout

This project sits **side by side** with its siblings (`pi-workspace` is a submodule container repo and the
build scripts resolve `../sibling` paths):

```
pi-workspace/
├── pi/                          # [submodule] upstream host + SDK, pinned to Branch_v1.1.0
├── pi-web/                      # [submodule] upstream UI + server, pinned to Branch_v0.11.1
├── assets/                      # brand assets (parent project; consumed here as ../assets)
├── pi-desktop/                  # [submodule] ← this project (Electron desktop shell)
│      ├─ ../pi      (host + SDK)    ← build time: npm install (produces the @earendil-works/* tree)
│      └─ ../pi-web  (UI + server)   ← build time: npm ci + next build → assemble pi-dist
├── pi-desktop-hos/              # [submodule] HarmonyOS port (separate project; we only reuse its findings and 2 portable modules)
├── pi-desktop-website/          # [submodule] website / download page (candidate data source for the update check)
├── harmonypc-electron/          # [submodule] Electron-on-HarmonyOS runtime (not used here)
└── harmonypc-electron-versions/ # (plain directory) HarmonyOS runtime archives + Node header guides (not used here)
```

Inside this project:

```
pi-desktop/
├── src/main/                       # Electron main process (assembly code, no business logic)
│   ├── index.ts                    # entry orchestration: lock → security prep → whenReady → host → window → tray/notifications → exit
│   ├── host.ts                     # in-process Next host: env assembly, secret rotation, chdir to artifact root, startServer, readiness, auth injection, shutdown
│   ├── artifact.ts                 # pi-dist extraction + SHA-256 marker idempotence + PI_DESKTOP_PI_DIST escape hatch
│   ├── tar-extract.ts              # streaming ustar(.gz) extractor (ported from pi-desktop-hos)
│   ├── windows.ts                  # BrowserWindow + loading page + load strategy + navigation hardening + permission allowlist + window icon
│   ├── window-state.ts             # window-state.json persistence (debounced, bounds-checked)
│   ├── tray.ts                     # tray and menu
│   ├── notifications.ts            # session JSONL tailing → native notifications (cooldown / dedupe / background only)
│   ├── session-watch.ts            # incremental session-file tail (consumed by notifications)
│   ├── lifecycle.ts                # NO_PROXY / system CAs / crash fallback / graceful shutdown / proxy bypass
│   ├── settings.ts                 # shell settings (agentDirMode, …) read/write
│   ├── update-check.ts             # update check (semi-automatic)
│   └── logger.ts                   # [pi-desktop] unified logging → <userData>/logs
├── src/preload/index.ts            # empty by default (a minimal bridge can be enabled; the data path never uses IPC)
├── src/renderer/renderer.ts        # drives the shell-owned pages (loading / fallback)
├── index.html                      # fallback / loading page (CSP: default-src 'self')
├── resources/                      # icon.ico / icon.icns / icon.png / tray.png / trayTemplate.png
├── resources/brand/                # asset mirror (committed, so CI works without the parent project)
├── config/                         # preset templates (settings.json / mcp.json defaults)
├── scripts/
│   ├── prepare-next.mjs            # 1. ../pi-web: npm ci → native-dependency check → next build
│   ├── smoke-desktop.mjs           # 2. gate: start the server with Node 24.21 + SPA/API/SSE/SDK assertions
│   ├── collect-pi.mjs              # 3. assemble pi-dist → brand → final check → tar.gz(ustar) + SHA-256 marker
│   ├── brand-assets.mjs            # asset validation/freeze + pi-dist copy·logo·icon branding + three assertion layers
│   ├── probe-renderer.mjs          # packaged renderer/terminal probe (R1–R7 over CDP)
│   └── pin-upstream.mjs            # record ../pi and ../pi-web commit SHAs (upstream.lock.json)
├── forge.config.ts                 # packagerConfig (asar / extraResource / executableName) + makers + plugins
├── vite.{main,preload,renderer}.config.ts , tsconfig.json , forge.env.d.ts
├── .github/workflows/{ci.yml,release.yml}
├── specs/                          # NNN-name/{spec.md,plan.md[,test-cases.md]} (001…012 + 201)
├── docs/                           # engineering plan + desktop capability list + build/verification log + release & update
├── upstream.lock.json              # pinned upstream commit SHAs (reproducibility; generated at build time)
├── README.md / README_zh.md        # this file (English / Chinese)
└── logs/                           # per-round build and device-verification evidence (not committed)
```

### Current status

| Status | Contents |
|---|---|
| ✅ Implemented | `src/main/**` (14 modules), `src/preload`, `src/renderer`, 6 build/probe scripts, `resources/` (including the brand mirror), `config/`, Forge + Vite + TS config, `.github/workflows/{ci,release}.yml`, `specs/` (`001`–`012` paired, `201` undecided), the four `docs/` documents |
| ✅ Measured (Windows) | packaged first screen, in-process host, branding (copy/logo/icons/version check), cross-drive default layout startup, PTY, native notifications, Squirrel install → launch → uninstall (see [docs/构建验证记录.md](docs/构建验证记录.md) rounds 1 and 2) |
| ⬜ Not yet measured | the full macOS / Linux paths; `make`'s dmg/deb/rpm install experience; P0-4's "memory curve during extraction"; item-by-item verification of MCP / `git` / search tools; the **visual** appearance of the tray and notifications (beyond the programmable criteria) |
| ⬜ Still to land | `extensions/`, `skills/` (shell-specific extensions and skills, optional tier); end-to-end evidence for the parts of `specs/003`–`011` that only have specs; the `patches/` directory (plan §7 requires it with a written "empty for this version" note — the repo has none yet); the `config/trust.json` preset template (listed in plan §6.2; only `settings.json` / `mcp.json` exist) |
| ❌ Explicitly out of scope | deep links / auto-start / global shortcuts / multi-window; code signing / notarization / silent update; cross-platform packaging |

Note: this table is a README snapshot — file presence is governed by the repository (`git status` / `ls`),
and verdicts are governed by the round log in [docs/构建验证记录.md](docs/构建验证记录.md) and the
capability matrix in [docs/桌面能力清单.md](docs/桌面能力清单.md).

## Related documents

| Document | Contents |
|---|---|
| [docs/工程规划.md](docs/工程规划.md) | **Engineering plan**: architecture, structure, pipeline, capabilities and degradation, phased plan, risks (source of truth) |
| [docs/桌面能力清单.md](docs/桌面能力清单.md) | Three platforms × capability matrix, degradation matrix, evidence tags, differences from the HarmonyOS port |
| [docs/构建验证记录.md](docs/构建验证记录.md) | Ledger of every build/device round + Phase 0 probe (P0-0…P0-6) verdicts and evidence paths |
| [docs/发布与更新.md](docs/发布与更新.md) | Version policy, CI/Release workflows, three-platform artifacts, unsigned-install guidance, uninstall residue, update behaviour and upgrade semantics |
| [specs/](specs/) | Module specs (`NNN-name/{spec.md,plan.md}`) and project-level documents (`README` / `constitution` / `ARCHITECTURE` / `TECH` / `STRUCTURE` / `overall-{spec,plan}`) |

## Upstream notice and license

- **Unofficial**: independently implemented by a third party (`fellow99`), with no affiliation to or
  endorsement from the Pi / Pi Web authors.
- **Assemble, never fork**: this version needs **0 patches** (rationale item by item in plan §7); all
  handling of upstream is idempotent and never overwrites user changes.
- **Upstream licenses**: [Pi](https://github.com/earendil-works/pi) MIT ·
  [Pi Web](https://github.com/agegr/pi-web) MIT. The shipped `pi-dist.tar.gz` contains upstream artifacts
  whose license and copyright belong to the upstream authors; this project's own code is MIT
  (see [LICENSE](LICENSE)).
- **Name notice**: the name contains `pi` only to describe the upstream project being wrapped; the in-app
  "About" page states the same notices.
