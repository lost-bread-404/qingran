# 模型更换记录

## 2026-09-22 Voice：REALTIME `grok-4.20-0309-non-reasoning` → `grok-4.3` effort=low

- **原因**：实时回复改走有思考的 4.3，设置 → 听力 → 高级可切 `grok-4.3 low` / `grok-4.3 medium` / `grok-4.20-0309-non-reasoning`，下一句立刻生效。
- **旧**：`ROUTES.voice = { cls: "REALTIME", timeoutMs: 28_000 }`
- **新**：`ROUTES.voice = { cls: "FAST_THINKER", effort: "low", timeoutMs: 60_000 }`
- **兜底**：4.3 报错或空回复时，先用 4.20 再试一次（`brain_log` 记 `model_fallback=yes|no` 和原因），仍空再按原逻辑去掉 mind → 记忆笔记 → 历史。
- **观测**：分段耗时增加「首字」（请求发出 → 第一个文字 token），`brain_log` 的 try 行带 `ttft_ms`。

## 2026-09-17 Reflector：FAST_THINKER `grok-4.6` → `grok-4.3`

- **原因**：成本。按 prompt 长度估算，每轮约 $0.028，其中 Reflector 约占 78%（输入 8–9k tokens，记忆 index 约 5k）。
- **旧**：`MODEL_CLASSES.FAST_THINKER = { model: "grok-4.6", effort: "low" }`
- **新**：`MODEL_CLASSES.FAST_THINKER = { model: "grok-4.3", effort: "low" }`
- **回切**：`QR_CLASS_FAST_THINKER_MODEL=grok-4.6`
- **eval**（`scripts/eval/scenarios/lead.jsonl`，3 轮；Voice 仍是 REALTIME，Reflector 只影响第 2–3 轮注入的内心）：

| 指标 | grok-4.3 | grok-4.6 |
|---|---|---|
| logic | 4.33 | 4.00 |
| felt_seen | 3.33 | 3.00 |
| agency | 5.00 | 4.67 |
| takes_lead | 5.00 | 4.33 |
| warmth | 4.00 | 4.33 |

样本很小，不能当回归基线。`grok-4.3` 输入 $1.25 / cached $0.20 / 输出 $2.50（每 1M），`grok-4.6` 是 $2 / $0.50 / $6。离线演练里 Reflector 输入约 1.5–2.5k 字符；真实对话有核心 index 后会更大，但分段 + cache 之后 cached 部分按 4.3 的 $0.20 计。

同时做了输入分段（稳定前缀走 prompt cache）和记忆 index 拆成核心 60 + 相关 30，用来降低 tokens_in 并提高 `tokens_cached / tokens_in`。
