# 主动消息

清然自己决定要不要找 Rosie。没有新信息时不调用模型。

```
每 10 分钟  GitHub Actions wake
        │
        ▼
/api/cron/wake   （CRON_SECRET，和 /api/cron/brain 同一套）
        │
        ├─ 关着 → skip:disabled
        ├─ 30 分钟内还在聊 → 直接返回，不记日志
        ├─ next_at 到了 → planned
        ├─ 没有 next_at → 按 λ 掷骰，中了才是 random
        ├─ 当天 LLM ≥ 48 或已发 ≥ 30 → skip:breaker，改到明天早上 8 点
        └─ 否则调用 reach
              ├─ send=true → qingran_messages kind=proactive → APNs
              ├─ send=false → 只更新内心和下一次
              └─ 调用失败 → 15 分钟后再试一次；再失败写一条灰色 system_notice，next_at 清空
```

Rosie 说话之后，reflect 会重写 `next_reach`。连续没回时，下一次不能早于 10 / 20 / 40 / 80 / 160 / 320 分钟。

## 随机醒来

每 10 分钟掷一次。每小时概率：

`λ = BASE_RANDOM_PER_HOUR × (1 + glow/40) × (1.4 − busy) × (1 + 0.25 × 心事条数)`

`p = 1 − e^(−λ/6)`

`BASE_RANDOM_PER_HOUR` 默认 `1/60`。平常、中等忙、没有心事时，大约 2.5 天一次。

## 心情

底色写在「我记得的」的「我们」里。glow 是上面的起伏，一半时间默认 2 天，设置在「他的心」。给模型的是词，不是数字。平常不写这一行。

## 费用

一次 reach 大约 $0.006。平静的一天 0–2 次。吵架、她一直不回，一天可能 20–40 次，上面有 48 次调用和 30 条消息的熔断。

## 可以调的地方

| 什么 | 在哪 |
|---|---|
| 发不发、下一次 | 设置 → 主动消息 |
| reach / busy / busy_tool 的说法和模型 | 设置 → 高级 → 指令 |
| glow 半衰期 | 设置 → 他的心 |
| 身份 | 设置 → 清然是谁 |
| 忙碌表 | 身份保存后自动生成。输入输出在 高级 → 调用记录 |
| 推送密钥 | Vercel：`APNS_KEY_ID` `APNS_TEAM_ID` `APNS_KEY_P8` `APNS_BUNDLE_ID` |
| 定时器密钥 | Vercel 和 GitHub `CRON_SECRET` |
