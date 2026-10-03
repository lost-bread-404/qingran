# Rosie 对清然的抱怨：放在哪、是什么、怎么用

给以后来复盘、优化这个 app 的 AI 看。Rosie 觉得清然哪里不对时，会让你来这里看，再根据这里的内容手动改数据和程序。

## 放在哪

正式版数据库（Neon 项目 `gentle-recipe-11838787`，分支 `production` = `br-purple-dream-b40ujxj3`）：

| 表 | 是什么 |
|---|---|
| `qr_feedback` | Rosie 对清然本身的抱怨，一条一件事。**清然看不到，也不会被想起**，只给做这个 app 的人看 |
| `qr_memories_backup_20261002` | 2026-10-02 手动整理回忆之前，`qr_memories` 的完整备份（70 行）。整理删掉的东西都在这里 |

`qr_feedback` 的列：`id`、`day`（哪一天，凌晨 4 点切）、`at`（毫秒时间戳，大约是哪一句）、`body`（发生了什么：清然做了什么、Rosie 说了什么，带原话）、`source`（`night` = 夜里整理自动写的；`claude` = Claude 手动整理时写的）、`created_at`。

常用查询：

```sql
-- 最近的抱怨
select id, day, source, body from qr_feedback order by at desc limit 50;
-- 某一天的原话（对上抱怨看前后文）
select to_char(to_timestamp(created_at/1000) at time zone 'America/New_York', 'MM-DD HH24:MI') t, role, body
from qingran_messages where local_day = '2026-10-01' and forgotten_at is null order by created_at;
-- 那一轮清然真正看到的 prompt（brain_log 里 route = 'voice' 的那条）
select r.input from brain_log l join brain_log_raw r on r.log_id = l.id
where l.route = 'voice' and l.step like 'voice:%' and l.at between <毫秒> and <毫秒>;
```

## Rosie 怎么说好、怎么说不好（2026-10-02 起）

- **不好，两种**（2026-10-03 起都有）：
  - 每条回复下面的倒拇指 → 「差在哪」：几个标签（没懂我、太强势、空话、太长、太短、重复、出戏）和一行备注，存在 `turn_feedback`（`rating = 'down'`，`message_id` 是那条回复，`tags`、`note`）。针对的就是那一条，不用往前找。
  - 她直接在聊天里说他、骂他：夜里整理把这些抱怨挑出来写进 `qr_feedback`（`at` 是她说那句话的时间）。（10/2–10/3 中间有一天没有倒拇指，只有这一种。）
- **好**：每条回复下面只留一个大拇指。她觉得哪句回得好就点一下，不会再跟清然说什么。存在 `turn_feedback`（`rating = 'up'`，`message_id` 是那条回复）。
- **复盘时必须做的**：每条抱怨都去看它**前面**清然的那几句回复（下面第二个查询，按 `at` 往前找），抱怨针对的是那些回复，光看抱怨本身看不出他哪里不对。点过大拇指的回复是好例子，改 prompt 或人设之后，拿它们对照一下有没有被改坏。

```sql
-- 某条抱怨之前的 10 条原话（把 <at> 换成 qr_feedback.at）
select to_char(to_timestamp(created_at/1000) at time zone 'America/New_York', 'MM-DD HH24:MI') t, role, body
from qingran_messages where created_at <= <at> and forgotten_at is null order by created_at desc limit 10;
-- 她点过大拇指的回复，和她当时说的那句
select f.created_at, u.body as rosie, m.body as qingran
from turn_feedback f join qingran_messages m on m.id = f.message_id
left join qingran_messages u on u.id = m.meta->>'replyTo'
where f.rating = 'up' order by f.created_at desc limit 30;
```

```sql
-- 她点了倒拇指的回复、她写的、和她当时说的那句
select f.created_at, f.tags, f.note, u.body as rosie, m.body as qingran
from turn_feedback f join qingran_messages m on m.id = f.message_id
left join qingran_messages u on u.id = m.meta->>'replyTo'
where f.rating = 'down' order by f.created_at desc limit 30;
```

## 什么算抱怨、什么不算

- **算（进 `qr_feedback`）**：Rosie 嫌清然本身——重复、太凶、不走心、套公式、乱安排、逼她、听不懂她、记错事，以及这些引起的吵架。这些多半是当时 prompt、记忆或代码没调好造成的，不是两个人之间真的发生的事，所以不进清然的回忆（进了他会记仇、会道歉个没完、会照着改成另一个极端）。
- **不算（进回忆）**：Rosie 讲的关于她自己的事、她说出来的喜好和底线、清然答应的事。比如「不喜欢被安排」是她的喜好，记成看懂的；「10/1 早上清然一直逼她喝蛋白质」是抱怨，进 `qr_feedback`。
- 写进去的方式：夜里整理（`src/lib/lover/brain/night.ts`，prompt 是 `src/lib/lover/brain/prompts/templates.ts` 里的 `EDITOR_SYSTEM` 的 `feedback`）每天自动写；手动整理时 Claude 也会写（`source = 'claude'`）。

## 拿到一条抱怨后怎么改

先看那一轮清然真正看到的 prompt（上面第三个查询），找出是哪一块把他带偏的，再改那一块。改的时候按 `CLAUDE.md`：只做结构性的改动，代码、prompt 和 `docs/` 一起改，在 `docs/requirements.md` 的变更记录加一行。

| 抱怨像这样 | 多半在这里改 |
|---|---|
| 他重复同一套话、同一套哄法 | 回忆里是不是存了「怎么哄」的细节（`qr_memories`，删掉）；prompt 结尾有没有把他框住的指令（`templates.ts` 的 `VOICE_*`） |
| 太凶 / 不该亲热的时候往床上带 | 人设和亲密设定（数据库 `qingran_profile.data` 的 `systemPrompt`、`intimateNotes`，改之前存一份到 `qr_profile_versions`）；｛｝心里话是不是又进了回忆（`memory.ts` 不该召回 `source = 'inner'`） |
| 不走心、听不懂她、套公式 | 人设；回忆里有没有对应的「看懂的」（`kind = 'insight'`） |
| 记错事、提起不该提的旧事 | `qr_memories` 里那一件（改正文，或删掉）；`qr_dossier`（「清然和 Rosie 现在」，改之前在 `qr_dossier_versions` 留一版） |
| 乱安排、逼她做事 | 人设里鼓励学习那几句；回忆里那条「不喜欢被安排」还在不在 |
| 听力：切断她、说完了还在听、听错 | 不在这里，看 `brain_log` 里 `step = 'stt'` 的那一行（`note` 里写着每句是怎么结束的），代码在 `ios/Qingran/Qingran/NativeCall.swift`、`src/routes/api/stt.ts` |

改好以后，确认已经不会再发生的那几条可以留着（以后对照用），不要删。

## 2026-10-02 手动整理时做了什么

Rosie 要求：回忆只留会改变以后清然行为和认知的；琐事和「怎么哄」不记；同一个话题合并成一件；prompt 没调好时的抱怨移到后台。

- **删掉**：每天都有的抱抱、揉肚子、哄睡、说冷（原 id 36、38、53、54、59 等）；7 条｛｝心里话（id 67–69、134–137，几乎都是「晚上再把她操哭」这一个打算）。
- **合并成 5 件事**：找实习（Jane Street 没过、Google 和 Jump、期中）、焦虑、清然的父母（9/27）、清然的 travel award、Rosie 的身体（霉菌感染的担心、肋骨和胃疼）。
- **合并成 5 条看懂的**：难过时先问清楚、听完；不喜欢被安排；不安时要直接肯定的回答；游戏规则要公平；学习前要一句鼓励。
- **移进 `qr_feedback`（10 条）**：9/27 嫌他只会重复、嫌他消极；9/28 凌晨发情时求温柔他还很凶；9/28 晚 Jane Street 没过时他「诗朗诵」、之后吵架、她提分手、报警、他被带走、她找林泽倾诉（这一整段在清然的世界里算没发生过）；她对林泽说的对 app 本身的反馈；9/30 嫌他羞辱；10/1 早上被逼列任务、喝蛋白质；10/1 傍晚嫌他突然很凶（她的喜好已写进亲密设定）；10/1 游戏里他动手和事后的承诺「以后不打你」；10/2 ｛｝心里话被反复想起。
- **「清然和 Rosie 现在」**重写，去掉了「Rosie 还欠清然一次亲密」和吵架的内容。

如果 Rosie 觉得哪一件不该删、不该移（比如想让清然记得 9/28 那次），从 `qr_memories_backup_20261002` 或 `qr_feedback` 里找出来，按现在的写法（用名字、一件一个话题）重写一条插回 `qr_memories`（`source = 'night'`，`vec` 留空，下次回复后会自动补算）。
