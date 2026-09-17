# 把 `claude-memory` 并进 `ios-microphone` 时

本 branch 没动通话 / 音频 / 后台保持（`use-call.ts`、`use-voice-input.ts`、`playback.ts`、`audio.ts`、`vad.ts`、`ios/`）。合并时按下面处理。

## 冲突文件

| 文件 | 原则 |
|---|---|
| `use-call.ts`、`use-voice-input.ts`、`playback.ts` | 以 `ios-microphone` 为准 |
| `voice-room.tsx` | 保留 ios-microphone 的通话 UI，再叠：去掉客户端 memory、`done` 时结束本轮、timing 事件、`warmBrain()` 一行、日记入口 |
| `settings-drawer.tsx` | 保留 ios-microphone 的通话与备份 UI，再叠本 branch 的笔记 / 画像 / 内心，并加上 `BrainBackupPanel` |
| `talk-client.ts` | 保留 ios-microphone 的通话客户端，叠 timing 事件，并保留 401 跳转那一行（`onUnauthorized`） |
| `package.json` | 合并双方依赖与脚本（`eval`、brain 测试、`@vercel/functions`、auth-lite 测试） |

## 备份

合并后 `src/lib/lover/backup.ts`（v1）的**导出入口**换成 v2；**导入入口**统一走 `src/lib/lover/brain/backup.ts`（兼容 v1：messages / memories / profile 会补 `local_day`、`session_id`，旧 memories 变成 `legacy:` notes，并 enqueue archive）。

不要把 v1 的 `kind: "qingran-backup"` 改掉，v2 用同一个 kind、`version: 2`。

## Vercel

- `vercel.json`：`regions: ["iad1"]`（和 Neon US East 同区）；三条 cron 打到 `/api/cron/brain?slot=1|2|3`，调度 `0 10/11/12 * * *`（UTC，对应纽约夏令时早上 6–8 点，都在 04:00 日界之后）。Hobby 每个表达式每天最多一次，所以拆成三个小时把积压的 synth / report 分段跑完。slot 参数路由忽略。
- **maxDuration**：Nitro 3 + TanStack Start 把 SSR 和 `createServerFn` 打进同一条 Vercel Function，`waitUntil` 的 270s drain 无法只加在 cron 上。因此 `vite.config.ts` 里 `nitro({ vercel: { functions: { maxDuration: 300 } } })` 全局设成 300s。**不要**再用 `functionRules` 给 `/api/cron/brain` 单独复制一份——Nitro 会把整个 server bundle 再拷一份（[nitro#4233](https://github.com/nitrojs/nitro/issues/4233)），而 Diary 触发的 waitUntil 也跑在同一条 function 上。Hobby Fluid 上限就是 300s。
- 环境变量：新增 **`CRON_SECRET`**、**`APP_PASSWORD`**。Vercel Cron 会带 `Authorization: Bearer $CRON_SECRET`。生产 / Nitro 未设 `CRON_SECRET` 时 `/api/cron/brain` 返回 **503**；只有本地 `vite dev` 才允许 localhost 免密。

## 密码门

合并时把本 branch 的 `server/middleware/00-auth.ts`、`server/routes/login.get.ts`、`server/routes/api/login.post.ts`、`server/routes/api/logout.post.ts`、`src/lib/auth-lite/`、`src/components/lover/logout-button.tsx`、`migrations/0006_auth_attempts.sql` **原样保留**。`talk-client.ts` 冲突时保留 401 跳转那一行。本地 `vite dev` 不跑 Nitro middleware，不需要登录；生产未设 `APP_PASSWORD` 时除 cron 外一律 503。

## `操作说明.md` 需要补的步骤

1. 在 Vercel 项目 Settings → Environment Variables 加上 `CRON_SECRET`（随机长字符串）。
2. 加上 `APP_PASSWORD`（建议 ≥ 16 位随机字符），Production / Preview / Development 都勾上。
3. 确认 Functions region 为 `iad1`，与 Neon AWS US East 相同。
4. 第 6 步「搬记忆」改为使用设置里的「导出完整备份 / 导入备份」（v2，含日记）。旧 v1 JSON 仍可导入。
5. iPhone 上第一次打开清然 App 会看到登录页，输入一次密码即可，之后长期保持登录（WKWebView 默认数据存储会记住 cookie）。
6. 忘记密码或怀疑泄露：在 Vercel 修改 `APP_PASSWORD` 并重新部署，所有设备需要重新登录。

## 本 branch 新增（可观测性）

- migration `0007_observability.sql`：`brain_log` 用量字段、`brain_turns`、`qr_mind_history`、`brain_daily_digest`、`diary_intention_ops`。
- Diary「系统档案」tab：`src/components/lover/brain-system-archive.tsx`。
- `package.json`：`test:app`（只跑 `src/`）、`demo:offline`、`analyze`、`engines.node >= 22.18.0`。`test` 分别跑 scripts 和 `test:app`，前者失败不会跳过后者。
- eval / demo 用 `node --import ./scripts/eval/register-alias.mjs --experimental-strip-types ...`。
- 备份 v2 加入 `brain_turns` / `qr_mind_history` / `brain_daily_digest`（`brain_log` 仍不进备份，走导出）。

## 本 branch 新增（费用）

- migration `0008_spend.sql`：`spend_events` / `spend_daily` / `spend_alerts` / `spend_overrides` / `spend_reconcile` / `spend_rate`。
- 新组件 `src/components/lover/brain-spend-page.tsx`（Diary「费用」tab）；设置抽屉加一行跳到 `/diary#spend`。
- `talk.ts` 开头检查限额和每分钟 20 次；熔断时 SSE `code: "spend_breaker"`。`voice-room.tsx` 只加了这个 code 分支，通话逻辑未改。
- `stream-talk.ts` 的 `LiveTts` 和 `server.ts` 的 `speakAsLover` / `transcribeVoice` **只追加了记账**，合成 / 转写路径没动。合并到 `ios-microphone` 时保留这些 `recordTtsSpend` / `recordSttSpend` 调用。
- 环境变量：`QR_SPEND_DAY_SOFT/HARD/BREAKER`、`QR_SPEND_MONTH_SOFT/HARD/BREAKER`（美元，默认 15/30/50 和 100/150/200）。
- 备份 v2 加入上述 spend 表。

## 本 branch 新增（引用式日志）

- migration `0009_log_refs.sql`：`qr_charter_versions`、`qr_block_snapshots`、`qingran_message_edits`、`brain_log` 的 `code_version/refs/output_ref/cost_usd_est`、`brain_turns` 的 hashes、`brain_log_raw`、`spend_events.usd_est/cost_source`、`spend_monthly`。
- `talk.ts` 不再把完整 system/history 写入 `brain_log`，改为 `recordVoiceTurn` 存引用；`brain_turns.tail` 不再写。
- `updateRoomMessage` 走 `updateMessageText`，会写 `qingran_message_edits`（合并到 `ios-microphone` 时保留）。
- 新环境变量：`QR_LOG_TEXT_DAYS`（默认 7）、`QR_SNAPSHOT_DAYS`（默认 90）、`QR_LOG_RAW_HOURS`（默认 0）、`QR_DB_LIMIT_MB`（默认 512，Neon 免费档 0.5GB）、`QR_XAI_STORE`（默认 false）。
- Vercel 需要提供 `VERCEL_GIT_COMMIT_SHA`（默认已提供）；本地日志 `code_version=dev`。
- 备份 v2 加入 charter/snapshot/edits/spend_monthly 以及 messages.edited_at、turns 的 hash 字段、spend_events 的 usd_est/cost_source。

未覆盖决策（选了最简单可测的）：

- `VoiceRefs` 额外记下 `timeZone`、`mindAgeMs`，重建 `formatMindAge` 才能与当时一致。
- `spend_monthly` 在每次 `recordSpend` 时累加，不只在删除明细时写。
- TTS/STT 没有 ticks，固定 `price_table`。
- 仍未接 Management API。
- PGLite 上 `UPDATE … FROM (SELECT … LIMIT)` 和 `= any($1::text[])` 不可靠，保留策略改成 `id in (select … limit 500)`，用 `with u as (update … returning) select count(*)` 计数。
- 冻结时钟下 `messageAsOf` 看 `createdAt > t` 会丢掉同一毫秒的回复，所以 demo / golden / replay 把 assistant 的 `createdAt` 写成 `turn.at`（不再 +1）。

## 操作说明.md 需要补的步骤

1. 开启 xAI 自动续费**之前**，先打开设置 → 费用，确认每日 / 每月软、硬、熔断金额。
2. 如 xAI 控制台支持设置月度消费上限，建议设为 **$250**，作为应用限额外面的最后一道闸。
3. 熔断后在费用页再输入一次登录密码，才能「今天继续使用」或「本月继续使用」。
