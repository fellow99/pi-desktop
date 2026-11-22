# patches/ — 上游补丁集

> 原则：**补丁是结论，不是快捷方式**。每一条都必须写明「触发条件 / 实施时机 / 替代方案」，
> 并占用全局唯一编号（编号只增不改、不复用）。
> 当前上游基线：`pi-web` tag **`v0.18.0`**（commit `2daa0d1`）。


## 0.0 v0.18.0 rebase 记录（2026-11-22）

| 项 | 内容 |
|---|---|
| 上游基线 | `pi-web` tag **`v0.18.0`**（`2daa0d131eae6c2fd8c2a80872eee01ea3c7a0a1`，annotated tag `38bb6805`，`Release v0.18.0`）· `pi` tag **`v1.6.0`**（`faac585884ae2c013a6b1400f3e9e77f10b34bac`） |
| 生成方式 | 独立 detached worktree `git worktree add --detach ../.tmp/wt-018 v0.18.0`；逐条 `git apply`（冲突条目手工重放）→ `git add` → `git commit` → `git diff HEAD^ HEAD > patches/v0.18.0/<同名>.patch`；**未经 PowerShell 重定向**，全目录 **UTF-8 / LF** |
| 行尾口径修正 | v0.17.0 目录下 19 条补丁中 15 条为 **CRLF**（`pi-desktop/0001` 与四条 `sync-daemon`/`system-back` 系为 LF）。在 LF 工作树（WSL/Linux）上 `git apply` 对 CRLF 补丁必然失败，只有 Git-for-Windows（`core.autocrlf=true`）能容错。本轮起**统一 LF**，与「UTF-8 / LF」纪律一致，并已在 LF 环境下逐条验证可应用 |
| 上游变更（v0.17.0→v0.18.0） | 127 文件，+4874/−946，34 提交 |
| 冲突与处置 | 见下「本轮变更」 |
| 验证 | ① pristine v0.18.0 上按文件名排序逐条 `git apply --check` + `git apply` 全绿；② 反序 `git apply --reverse` 后 `git status --porcelain` 为空（受影响文件 SHA-256 逐条还原） |

### 本轮变更

| 补丁 | 变更 |
|---|---|
| `0001-sync-daemon-settings-tab` | 无上游冲突，按 v0.18.0 上下文重新生成（触及 `lib/settings-navigation.ts`、`components/SettingsPanel.tsx`、`components/SyncConfig.tsx`、`lib/i18n/messages/*`、`app/api/sync-daemon/route.ts`）。`SettingsPanel.tsx` 在 v0.18.0 新增 `clearStoredDrafts` 相关改动（#1739/#1740 系），与本补丁插入位置不重叠 |

## 0. 已登记补丁

### P301-1 — pi-web 设置对话框新增「中枢服务」分区

| 项 | 内容 |
|---|---|
| 文件 | `patches/v0.18.0/0001-sync-daemon-settings-tab.patch`（UTF-8 / LF） |
| 全局编号 | `P301-1` |
| 打补丁的上游 | `pi-web` tag **`v0.18.0`**（`2daa0d1`，`Release v0.18.0`） |
| 触及文件 | `lib/settings-navigation.ts`（`SETTINGS_SECTION_VALUES` 加 `sync`）；`components/SettingsPanel.tsx`（分区项 / 图标 / 渲染 / 无桥回退）；**新增** `components/SyncConfig.tsx`；`lib/i18n/messages/{zh-CN,en,zh-TW}.ts`（`settings.sync*` 文案） |
| **触发条件** | 需求 `301-sync-daemon` 改版（D18）：设置入口从桌面壳的原生窗口改为 **pi-web 设置对话框内的分区**。pi-web **没有** 客户端 UI 插件/扩展插槽：pi 扩展 UI 只有 `select`/`confirm`/`input`/`editor`/`custom`（终端组件）与编辑器上/下 widget、状态栏；设置分区由 `lib/settings-navigation.ts` 枚举 + `components/SettingsPanel.tsx` 硬编码，无注册表。运行时 DOM 注入依赖上游 DOM 结构、升级即静默失效，且手机端层级 / i18n / 焦点 / a11y 无法自然接入 → 选择构建期补丁 |
| **实施时机** | `scripts/prepare-next.mjs` 阶段 **1b**：在 `next build` 之前幂等应用，构建成功后 `finally` 自动回退（`revertAll`），`../pi-web` 在构建窗口期之外保持 pristine |
| **替代方案** | ① 插件 / 扩展 —— 无设置分区插槽（否决）；② 运行时注入 —— 依赖上游 DOM、升级无构建期感知（否决）；③ 保留原生设置窗口 —— 与 pi-web 现有设置重复建设（用户已否决） |
| **往返校验** | 应用前记录受影响文件 SHA-256 → 应用 → 反向 → 断言逐文件还原 → 再正式应用；冲突即硬失败（绝不 `--3way`） |
| **生成方式** | 独立 detached worktree（`git -C ../pi-web worktree add --detach <tmp> v0.18.0`）上修改并 `tsc --noEmit` 验证 → `git diff --cached --output=<patch>`（不经 PowerShell 重定向，避免 UTF-16）→ `worktree remove` |
| **回退方式** | `node scripts/patches.mjs revert`（或在 `../pi-web` 上 `git apply --reverse patches/v0.18.0/0001-sync-daemon-settings-tab.patch`） |
| **规格** | `specs/301-sync-daemon/{spec,plan,test-cases}.md`（FR-301-004a/004b/004c、D18–D20、TC-21） |

## 1. 补丁纪律（新增补丁时必须遵守）

1. **幂等**：应用前 `git apply --reverse --check <patch>`，成功即视为已应用 → 跳过。
2. **冲突即终止**：绝不 `--3way` 强行合并，绝不覆盖 `../pi` / `../pi-web` 中的用户改动。
3. **不带镜像噪声**：`package-lock.json` 等由 `npm install` 重新生成，不进补丁。
4. **按上游 tag 组织**：`patches/<tag>/`；上游升级时**新建目录**，旧目录保留可追溯。
5. **不得落在既有补丁的连续上下文区间**（`git apply` 默认前后 3 行）。
6. **可往返**：正向应用 → 反向应用后，受影响文件的 SHA-256 必须完全还原。
7. **只在独立 detached worktree 里生成与校验**，不在工作树上直接 diff。
8. **登记三要素**：触发条件 / 实施时机 / 替代方案，并占用全局唯一编号。

## 2. 构建脚本如何消费

```
prepare-next（阶段 1b，next build 之前）
  for patch of patches/<pi-web version>/*.patch（按文件名排序）
    ├─ git apply --reverse --check 命中 → 已应用，skip（幂等）
    ├─ 否则 git apply --check 命中
    │    ├─ 记录受影响文件 SHA-256（新增文件记为 null）
    │    ├─ git apply             （临时应用）
    │    ├─ git apply --reverse   （回退）
    │    ├─ 断言 SHA-256 逐条相等（往返校验）
    │    └─ git apply             （正式应用）
    └─ 两者都失败 → 硬失败中止（绝不 --3way）
  → next build
  → finally: revertAll(本次实际应用的补丁)
```

## 3. dev 态手工迭代

```bash
# 应用补丁（之后可直接在 ../pi-web 跑 npm run dev 看 UI；改完记得回退）
node scripts/patches.mjs apply

# 查状态（clean / applied / conflict）
node scripts/patches.mjs status

# 还原上游树（提交前必须为 clean）
node scripts/patches.mjs revert
```

> 默认构建流程不需要手工 apply/revert；`prepare-next` 会自动成对执行。
