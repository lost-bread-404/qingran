# 把 `claude-memory` 并进 `ios-microphone` 时

本 branch 没动通话 / 音频 / 后台保持（`use-call.ts`、`use-voice-input.ts`、`playback.ts`、`audio.ts`、`vad.ts`、`ios/`）。合并时按下面处理。

## 冲突文件

| 文件 | 原则 |
|---|---|
| `use-call.ts`、`use-voice-input.ts`、`playback.ts` | 以 `ios-microphone` 为准 |
| `voice-room.tsx` | 保留 ios-microphone 的通话 UI，再叠：去掉客户端 memory、`done` 时结束本轮、timing 事件、`warmBrain()` 一行、日记入口 |
| `settings-drawer.tsx` | 保留 ios-microphone 的通话与备份 UI，再叠本 branch 的笔记 / 画像 / 内心，并加上 `BrainBackupPanel` |
| `talk-client.ts` | 保留 ios-microphone 的通话客户端，叠 timing 事件 |
| `package.json` | 合并双方依赖与脚本（`eval`、brain 测试、`@vercel/functions`） |

## 备份

合并后 `src/lib/lover/backup.ts`（v1）的**导出入口**换成 v2；**导入入口**统一走 `src/lib/lover/brain/backup.ts`（兼容 v1：messages / memories / profile 会补 `local_day`、`session_id`，旧 memories 变成 `legacy:` notes，并 enqueue archive）。

不要把 v1 的 `kind: "qingran-backup"` 改掉，v2 用同一个 kind、`version: 2`。

## Vercel

- `vercel.json`：`regions: ["iad1"]`（和 Neon US East 同区）；三条 cron 打到 `/api/cron/brain?slot=1|2|3`，调度 `0 10/11/12 * * *`（UTC，对应纽约夏令时早上 6–8 点，都在 04:00 日界之后）。Hobby 每个表达式每天最多一次，所以拆成三个小时把积压的 synth / report 分段跑完。slot 参数路由忽略。
- **maxDuration**：Nitro 3 + TanStack Start 把 SSR 和 `createServerFn` 打进同一条 Vercel Function，`waitUntil` 的 270s drain 无法只加在 cron 上。因此 `vite.config.ts` 里 `nitro({ vercel: { functions: { maxDuration: 300 } } })` 全局设成 300s。**不要**再用 `functionRules` 给 `/api/cron/brain` 单独复制一份——Nitro 会把整个 server bundle 再拷一份（[nitro#4233](https://github.com/nitrojs/nitro/issues/4233)），而 Diary 触发的 waitUntil 也跑在同一条 function 上。Hobby Fluid 上限就是 300s。
- 环境变量：新增 **`CRON_SECRET`**。Vercel Cron 会带 `Authorization: Bearer $CRON_SECRET`。本地没设 `CRON_SECRET` 时允许从 localhost 调 `/api/cron/brain`。

## `操作说明.md` 需要补的步骤

1. 在 Vercel 项目 Settings → Environment Variables 加上 `CRON_SECRET`（随机长字符串）。
2. 确认 Functions region 为 `iad1`，与 Neon AWS US East 相同。
3. 第 6 步「搬记忆」改为使用设置里的「导出完整备份 / 导入备份」（v2，含日记）。旧 v1 JSON 仍可导入。
