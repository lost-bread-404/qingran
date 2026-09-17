# 可观测性

清然把「她看到了什么、想了什么、说了什么、花了多少」写进几张表。Diary 的「系统档案」页用来看，不进通话。

## 表

| 表 | 用途 | 保留 |
|---|---|---|
| `brain_log` | 每一次模型调用：完整 system / user / 输出、tokens、估算费用 | 数值永久；完整文本 90 天（`LOG_FULL_DAYS`），之后截到 `raw` 前 500 字，`trimmed=true` |
| `brain_turns` | 每一轮对话：注入的 tail、mind 版本、picked / fallback 记忆、pack / TTFT | `tail` 同样 90 天截断 |
| `qr_mind_history` | 每次 `saveMind` 成功追加一行 | 全部保留（约 1–2KB / 行） |
| `brain_daily_digest` | dusk 结束时由代码写的当天档案（markdown + json） | 全部 |
| `diary_intention_ops` | 同一天同一条 intention op 不重复应用 | 全部 |
| `mem_history` | 记忆库每次写入 | 全部 |
| `brain_jobs` | 慢路径任务 | done 14 天后清理 |

**不记录** STT / TTS 音频。Voice 的 `brain_log` 只存文本（system + 历史 + tail + 回复）。

## 字段要点

`brain_log.route` 是 `voice` / `reflect` / `archive` / `dusk` / …。`cost_usd` 用 `config.ts` 的 `MODEL_PRICES`（每 1M tokens 的 input / cached / output 美元）估算。usage 解析失败时 token 字段为 null。

`brain_turns.mind_stale`：注入时 `now - mind.updated_at ≥ SESSION_GAP_MS`。过期内心不注入 `intent` / `rosie_now`。

## 导出

Diary → 系统档案 → 「导出日志」会分页拉 `brainExportLogs`，拼成 `.jsonl`（每行带 `table`）。

离线分析（不需要数据库和 API key）：

```
npm run analyze -- path/to/export.jsonl
```

写出 `out/usage-report.md`：延迟、Reflector 成功率 / 超时 / stale 比例、注入记忆、按 route / 模型的 tokens 和费用、记忆库增长、错误 Top 10。

## 升级模型或 prompt 前后对比

至少看这些：

1. Voice TTFT p50 / p95，first_audio p95
2. Reflect 成功率、超时率、stale mind 比例
3. 每轮注入记忆数，picked vs fallback
4. 按 route 的 tokens 和 `cost_usd`
5. dusk / archive 失败原因
6. 有 `feedback` 时：好 / 差回复的 tail 长度和注入记忆数

价格表随模型一起改：`MODEL_CLASSES`、`MODEL_CAPS`、`MODEL_PRICES` 写在 `src/lib/lover/brain/config.ts`。

## Prompt cache

xAI 按 messages 数组**从头开始的精确前缀**计费；Responses API 用请求体里的 `prompt_cache_key` 把同一类请求打到同一台机器（等同 Chat Completions 的 `x-grok-conv-id`）。文档没有要求别的会话 header。

Reflector 的 `callModel("reflect")` 固定传 `prompt_cache_key: "qingran-reflect"`（`REFLECT_PROMPT_CACHE_KEY`）。输入拆成三段：

| 段 | 位置 | 何时变 |
|---|---|---|
| A | `system`：指令 + 立场 + 人设 | 几乎不变 |
| B | 第 1 条 `user`：self / bond / portrait / 规律 / 核心 index | 日界或 `notesVersion` |
| C | 第 2 条 `user`：时钟、相关 index、旧 mind、最近对话 | 每轮 |

对比上线前后，看 `brain_log` 里 `route=reflect` 的 `tokens_cached / tokens_in` 和 `cost_usd`。Diary「系统档案」每日汇总会显示 Reflector 缓存命中率和平均每轮费用；`usage-report` 按 route 输出命中率和按天趋势。

