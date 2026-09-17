# Eval 基线

用当前 `claude-memory` 配置跑：

```
npm run eval -- --repeat 3
```

可选临时覆盖模型档：`--routes REALTIME=…,FAST_THINKER=…`。

## 待 Rosie 运行

本环境没有 `XAI_API_KEY`，脚本和 scenario 已齐（清然侧每个 ≥20 轮，另有跨 3 天、含会话中断的 `mixed.jsonl`）。请 Rosie 在有 key 的机器上跑：

```
npm run eval -- --repeat 3
```

把 `out/report.md` 的结果贴回这里：各指标均值与标准差、每轮平均费用、reflect 耗时 p50 / p95。

## 已覆盖的 scenario

清然侧：`lead` `charitable` `care` `insight` `stance` `recall` `preference` `pushback` `self-consistency` `repetition` `mixed`

日记侧仍走原来的 `diary-*`（judge 跳过）。

replay 使用引用式日志，每轮会做 voice 重建一致性检查。
