# 可观测性

清然把「她看到了什么、想了什么、说了什么、花了多少」写进几张表。设置 → 高级 → 记录 / 费用用来看，不进通话。

高频 route（`voice` / `reflect`）**同时存引用和原文**。发给模型的 prompt 仍用数据库里的原料拼出来；日志里再存一份当时的完整输入/输出，设置 → 记录页直接点开看。

## 表

| 表 | 用途 | 保留 |
|---|---|---|
| `brain_log` | 每一次模型调用：route / 模型 / tokens / 费用 / `refs` / `output_ref` / 完整 `input_*` / `output_text` | 数值和引用永久；全文默认 30 天（`QR_LOG_TEXT_DAYS`）后裁到 `raw` 前 300 字。单条超过 200KB 截断并标记 `trimmed` |
| `brain_turns` | 每一轮对话：mind 版本、picked / fallback、pack / TTFT、charter/longterm hash | 永久；不再写 `tail` |
| `qr_charter_versions` | 人设文本按 sha256 | 永久 |
| `qr_block_snapshots` | `voice_longterm` / `reflect_b` 渲染结果 | 仍被日志引用的保留；其余 90 天（`QR_SNAPSHOT_DAYS`） |
| `qr_inner_log` | 心思（刚说完话 / 沉默 / 到时间了）和夜里整理每次的输出或失败原因 | 永久 |
| `qr_dossier_versions` | 记得的每个版本（夜里整理附一句改了什么） | 永久 |
| `qingran_message_edits` | 消息编辑前的原文 | 永久 |
| `brain_log_raw` | 完整 messages 数组 | 与全文同一保留期（默认 30 天）；`QR_LOG_RAW_HOURS>0` 时可更短 |
| `brain_jobs` | 慢路径任务 | done 14 天后清理 |

**不记录** STT / TTS 音频。Voice 的回复在 `qingran_messages`，`output_ref = message:<id>`。

## 各 route 记什么

| Route | `refs` | 输出 |
|---|---|---|
| `voice` | charterHash、longtermHash、historyIds、mindTurnSeq、mindStale、pickedIds、fallbackIds、careHint、clockText、userMsgId、timeZone、mindAgeMs | `output_ref = message:<replyId>` |
| `reflect` | charterHash、blockBHash、relatedIds、oldMindTurnSeq、recentMessageIds、clockText、timeZone | `output_ref = mind:<turn_seq>`；解析失败或乐观锁拒绝时才存 `output_text` |
| 低频（editor / report） | — | 存完整 `input_system` / `input_user` / `output_text` |

所有 route 的完整 messages 另写入 `brain_log_raw`。设置 → 记录页点开某一条，分区显示输入（按 messages 段折叠）、输出、参数与耗时，并可复制全部。

`code_version` 为 `VERCEL_GIT_COMMIT_SHA`，本地为 `dev`。

## 看当时发了什么

每一次调用的完整 messages 都在 `brain_log_raw`（保留期内），记录页点开就是当时的原文，不再从引用重建。超过保留期的只剩数值、引用和输出的前 300 字。

调试窗口：`QR_LOG_RAW_HOURS>0` 时 raw 表按小时裁；默认跟全文一样留 30 天。

## 容量

`brainDbSize()` 读 `pg_database_size`（PGLite 不支持则返回 null）。上限 `QR_DB_LIMIT_MB`，默认 **512**（Neon 免费档 0.5GB）。超过 70% 时记录页警告。

旧全文在首次 cron 分批清空（每批 500 行，超过保留期的 `input_*` / `output_text`），然后 `VACUUM`（Neon 上若不可用则跳过）。

## Prompt cache

xAI 按 messages 数组**从头开始的精确前缀**计费；Responses API 用请求体里的 `prompt_cache_key` 把同一类请求打到同一台机器。

Reflector 固定 `prompt_cache_key: "qingran-reflect"`。输入拆成三段 A/B/C。请求带 `store: false`（`QR_XAI_STORE`，默认关）。上线后对比 reflect 的 `tokens_cached / tokens_in`；若命中率明显下降，把默认改回 `true`。

xAI 仍会对 API 请求做 30 天审计留存，与 `store` 无关。
