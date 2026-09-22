# 可观测性

清然把「她看到了什么、想了什么、说了什么、花了多少」写进几张表。Diary 的「系统档案」页用来看，不进通话。

高频 route（`voice` / `reflect` / `archive`）**同时存引用和原文**。发给模型的 prompt 仍用数据库里的原料拼出来；日志里再存一份当时的完整输入/输出，设置 → 记录页直接点开看。

## 表

| 表 | 用途 | 保留 |
|---|---|---|
| `brain_log` | 每一次模型调用：route / 模型 / tokens / 费用 / `refs` / `output_ref` / 完整 `input_*` / `output_text` | 数值和引用永久；全文默认 30 天（`QR_LOG_TEXT_DAYS`）后裁到 `raw` 前 300 字。单条超过 200KB 截断并标记 `trimmed` |
| `brain_turns` | 每一轮对话：mind 版本、picked / fallback、pack / TTFT、charter/longterm hash | 永久；不再写 `tail` |
| `qr_charter_versions` | 人设文本按 sha256 | 永久 |
| `qr_block_snapshots` | `voice_longterm` / `reflect_b` 渲染结果 | 仍被日志引用的保留；其余 90 天（`QR_SNAPSHOT_DAYS`） |
| `qr_mind_history` | 每次 `saveMind` 成功追加一行 | 最近 30 天全部；更早每个会话只留最后一条 |
| `qingran_message_edits` | 消息编辑前的原文 | 永久 |
| `brain_log_raw` | 完整 messages 数组 | 与全文同一保留期（默认 30 天）；`QR_LOG_RAW_HOURS>0` 时可更短 |
| `brain_daily_digest` | dusk 结束时由代码写的当天档案 | 全部 |
| `mem_history` | 记忆库每次写入 | 全部 |
| `brain_jobs` | 慢路径任务 | done 14 天后清理 |

**不记录** STT / TTS 音频。Voice 的回复在 `qingran_messages`，`output_ref = message:<id>`。

## 各 route 记什么

| Route | `refs` | 输出 |
|---|---|---|
| `voice` | charterHash、longtermHash、historyIds、mindTurnSeq、mindStale、pickedIds、fallbackIds、careHint、clockText、userMsgId、timeZone、mindAgeMs | `output_ref = message:<replyId>` |
| `reflect` | charterHash、blockBHash、relatedIds、oldMindTurnSeq、recentMessageIds、clockText、timeZone | `output_ref = mind:<turn_seq>`；解析失败或乐观锁拒绝时才存 `output_text` |
| `archive` | batchMessageIds、candidateNoteIds | 存 `output_text`（ops 原文），按文本保留期裁 |
| 低频（dusk / portrait / assign / backfill / synth / report / ask / judge） | — | 存完整 `input_system` / `input_user` / `output_text` |

所有 route 的完整 messages 另写入 `brain_log_raw`。设置 → 记录页点开某一条，分区显示输入（按 messages 段折叠）、输出、参数与耗时，并可复制全部。

`code_version` 为 `VERCEL_GIT_COMMIT_SHA`，本地为 `dev`。

## 重建

`rebuildVoiceMessages(turnSeq)` / `rebuildReflectorInput(turnSeq)` / `rebuildArchiveInput(logId)` 按引用取回原料，调用与线上相同的 `buildVoiceMessages` / `buildTail` / `buildReflectorInput` / `buildArchivistInput`。

系统档案点开某一轮会显示重建后的 prompt 和 warnings：

- 日志的 `code_version` 与当前部署不同
- 某条原料缺失（超过保留期的 mind / 快照）
- 消息在调用之后被编辑过（已用 `messageAsOf` 还原）

30 天内的任意一轮可以完整重建；更早的轮次保留数值和大部分原料。拼装代码升级后，旧日志重建可能不完全一致，会提示。

导出默认附带重建全文；`brainExportLogs({ rebuild: false })` 只导出引用。

调试窗口：`QR_LOG_RAW_HOURS>0` 时 raw 表按小时裁；默认跟全文一样留 30 天。

## 容量

`brainDbSize()` 读 `pg_database_size`（PGLite 不支持则返回 null）。上限 `QR_DB_LIMIT_MB`，默认 **512**（Neon 免费档 0.5GB）。超过 70% 时系统档案和设置页警告。每日档案记录当天库大小和增量。

旧全文在首次 cron 分批清空（每批 500 行，超过保留期的 `input_*` / `output_text`），然后 `VACUUM`（Neon 上若不可用则跳过）。

## Prompt cache

xAI 按 messages 数组**从头开始的精确前缀**计费；Responses API 用请求体里的 `prompt_cache_key` 把同一类请求打到同一台机器。

Reflector 固定 `prompt_cache_key: "qingran-reflect"`。输入拆成三段 A/B/C。请求带 `store: false`（`QR_XAI_STORE`，默认关）。上线后对比 reflect 的 `tokens_cached / tokens_in`；若命中率明显下降，把默认改回 `true`。

xAI 仍会对 API 请求做 30 天审计留存，与 `store` 无关。
