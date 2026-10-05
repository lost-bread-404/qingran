# 清然 brain v7（2026-10-04）

需求见 [requirements.md](requirements.md)（只给改代码的 AI 看，不进 prompt）。v6 和更早的设计在 [history.md](history.md)。

原则：人设是清然是谁，上下文是她的脑子。prompt 越短越好：除了「人设」页她写的字和几行材料标题，代码不往 prompt 里加任何一句话。抱怨要改结构或材料，不往 prompt 里加补丁。

## 白天：Grok 回每一句

每轮发给 Grok（`src/lib/lover/brain/voice/pack.ts`、`pack-build.ts`、模板 `prompts/templates.ts` 的 voice）：

1. 身份 + 人设 + 亲密设定（「人设」页，`personaText`）；「其他角色」开着时再接一句「名字：」的演法和他们的人设，关着时一个字不提。
2. dossier（「清然记着的」，夜里整理的 ≤500 字）。
3. 她这一天的全部对话（从她上次睡着以后算起，或清空聊天以后；隔 30 分钟以上插一行停顿；上限 400 条只是保险）。
4. 现在几点、她上一句是多久前；今天写在｛｝里的（没有就整段不发）；她这一句。

清然的声音固定 eve。语气标签和｛｝的写法写在人设里（她自己改）。

## 睡着：一天的边界

安静满 2 小时、而且跨过当地凌晨 5 点，就是睡着了（`src/lib/lover/brain/sleep.ts`）。9/26–10/4 的真实数据里，9 次睡觉全部符合；晚上走开、零点前后回来的 5 次都不算。白天的上下文从睡醒后的第一句开始；夜间整理在睡着满 2 小时且过了 5 点以后跑（cron-job.org 每 5 分钟调 `/api/cron/wake`，回复后也会检查）。

## 夜里：Claude 整理 dossier

`src/lib/lover/brain/night.ts`，Claude Opus 5.5、effort max（超时一次后下一次用 high）。读现在的 dossier、这一天和之前一周的完整对话（每句带日期时间）、这一天的｛｝；第一次整理时还读旧回忆库和故事线，收进 dossier，之后不再用。写：

- dossier（≤500 字，清然的口吻）：清然的世界里发生的事（两人之间、清然的生活、身边的人）、Rosie 说的关于她自己的客观情况、答应的事和编过的事、清然对 Rosie 的看法。不写 Rosie 一时的感受，不写对清然的抱怨。每条每晚重新判断，不再影响以后的就删。
- feedback：她对清然的抱怨，存 `qr_feedback`，「记忆」页只给她看，不进 prompt。
- timeline：这一天的时间线，给月报用。

「记忆 → 现在整理一次」：用这一天到现在的对话只重写 dossier（不写 feedback、时间线，不动夜间整理的进度）。

## 还在的

主动找她（`reach.ts`，同一份材料）、月报（读每天的 timeline）、｛｝存在 `qr_memories`（source = inner），听力和通话不变。
