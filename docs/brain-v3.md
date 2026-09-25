# 清然 brain v3

三部分，每部分只有一个写入方。日记另走一条管线，清然不读。

```
                ┌───────────────────────────────┐
                │ ③ 记忆库                        │
                │  a. qingran_messages（原文，只追加） │
                │  b. qr_dossier（一份文档，有字数上限） │
                └──────┬────────────▲───────────┘
                  读    │            │ editor
                       ▼            │
Rosie ──► ① 回答 ◄──── ② 内心 ───────┘
```

| 部分 | 写入方 | 频率 | 读取方 |
|---|---|---|---|
| ① 回答 | `voice` | 每轮 | Rosie |
| ② 内心 | `reflect`，回复结束之后单独跑 | 每轮，异步，不挡回复。下一轮才注入 | ①，以及 reach |
| ③ Dossier | `editor` | 第一次自动生效；之后约每 20 轮 Rosie 的消息，或隔了一次会话再开口，或设置里「现在整理」 | ① ② |
| 日记 | `report` | 默认暂停。打开开关后，每月第一天写上个月。日记页也可以手动生成本月 | 只给日记页。清然不读 |

## 为什么是这样

否定式意图会被念出来。早期热路径里写过「不要催她学习」，回复模型会说「我没有继续催你学习」。所以思考和结论分开：`read_her`、`choice` 和 `plans` 只留给 reflect 和 reach 看，热路径只拿 `desire` / `feel` / `now` 和心情词。`now` 如果写成否定式（不要、别再、不催、停止、避免……）会被丢掉，不重跑，并记在 `qr_inner_log`。如果 `now` 没有以「我」为主语、又像是在描述她，记一条 `now_not_action`，文字留下，只做统计。

History 会自我模仿。窗口里一半是清然自己的旧回复，他就跟着旧回复说话。默认历史从 40 改成 20（已保存的设置不覆盖）。`recent_phrases` 那种黑名单已经删掉。

碎片检索互相不一致。notes、画像、self/bond、mind、前端旧记忆大约十几处在写「记忆」。清然现在只读一份有上限的 Dossier。原文留在 `qingran_messages`，不删、不改正文。`forgotten_at` 只是让清然和屏幕看不到，行还在。

## 表

| 表 | 谁写 | 说明 |
|---|---|---|
| `qingran_messages` | 通话 | 只追加。清空聊天是 `forgotten_at` + `room_cleared_at`，不是 DELETE |
| `qr_inner` | reflect | desire / read_her / feel / choice / now_text / scene / longing / plans。旧的 `want` 列保留，不再写入；0030 把已有的 `want` 复制进 `desire`。清空聊天清掉 desire、read_her、feel、choice、now，并把 scene 放回 daily；open 的 plans 标成 dropped |
| `qr_inner_log` | reflect | 每轮完整输出，包括被丢掉的 `now` |
| `qr_dossier` | editor、Rosie | 一份 markdown。`cursor_at` 是已经读过的最后一条消息。`active` 见下面的偏差 |
| `qr_dossier_versions` | 每次成功写入 | author：`editor` / `rosie` / `seed` / `compact` |
| `mem_notes`、`qr_portrait`、`qr_mind` | 旧日记管线还留着代码 | 清然的热路径不再读。表不删。自动 archive / dusk / assign / synth / ask / experiments / backfill 已断开 |

备份导出带上 `qr_inner`、`qr_inner_log`、`qr_dossier`、`qr_dossier_versions`。旧表照旧导出。

## 热路径注入了什么

都是 system，在 history 前面。顺序：

1. `{system_prompt}`，外加 `{A|B}` 那句听力说明
2. `【我记得的】`：生效之后是全文；还没生效时是旧的「我自己 / 我们 / 我眼中的她」
3. `【我此刻】`：想要（desire）、心里（feel）、正在做（now）、心情（glow 词）、惦记（longings，带日期）。某一行空了就删掉那一行；想要、心里、正在做、心情都空就整块删掉。desire / feel / now 超过 30 分钟不注入；惦记按自己的更新时间，默认能留一周。
4. `现在是{clock}。`
5. 最近 N 条 history
6. user：这一句

`read_her`、`choice` 和 `plans` 不进回复。忙碌程度也不进回复，只进 reflect，用来决定下一次什么时候找她。亲密设定只在上一轮 scene 是 intimate、并且没过 30 分钟时，跟在【我此刻】后面。降级顺序仍是：去掉【我此刻】→ 去掉【我记得的】→ 只留人设 + 最近 8 条 + 这一句。

回复模型不再写心思。如果它还是输出了 `⟦心⟧`，分隔符后面的内容不进屏幕、不进 TTS、不进 `qingran_messages`，也不拿来更新状态。turn trace 记 `unexpected_state_block`。

每轮回复成功之后 enqueue `reflect`。失败就留着上一轮的状态，记 `qr_inner_log`（`kind='reflect'`），不重试。`now` 写成否定式会被丢掉。`plans` 的 what 写成否定式时这一条不保存，原文记 `plan_rejected`；同一条旧计划如果还在，保留旧的正向写法。glow 事件的 source 是 `reflect`。`next_reach` 写入 `qr_reach`，`set_by='reflect'`。

## 每个 prompt

都在设置 → 指令里，可以改。模型在 `brain/config.ts` 的 `ROUTES`，设置里可以按指令换。

| key | 何时跑 | 输入 | 输出 |
|---|---|---|---|
| `voice` | 每轮回复 | 人设、我记得的、我此刻、时间、history、这一句。不包含 plans、read_her、choice，也不再要求写 `⟦心⟧` | 说出来的话 |
| `reflect` | 每轮回复结束后 | 人设、我记得的、时钟（带时间段）、忙碌行、上一次的全部内心字段（含 read_her、choice、plans）、最近 16 条对话 | desire / read_her / feel / choice / now / longings / plans / scene / glow / next_reach。默认 grok-4.3 medium |
| `editor` main | 见上 | 人设、当前文档、longing、cursor 之后没被遗忘的对话（一批最多约 12000 字）、字数上限 | `{ops:[{section,action,old,new}]}` |
| `editor` compact | 应用后超过上限 | 全文、上限 | `{body}`，author=`compact` |
| `editor` seed | `active` 仍是 false 且没有草稿时，自动跑一次 | 人设、`seed/story.json`、还在用的画像和 self/bond、最近 60 天 weight≥3 的笔记最多 150 条、longing | `{body}`，写进版本历史后立刻生效 |
| `archive` | 不再自动入队 | 函数还在，旧任务可以跑完 | 笔记 ops |
| `judge` | 离线 | 人设和对话 | 打分，含 `meta_narration` 和 `self_desire` |
| `report` | 日记页。开关打开时每月 1 日写上个月；「生成本月报告」随时可点 | 这个月的对话原文（跳过 system_notice 和已遗忘）。太长则先 `digest` 再 `main` | 四段月报。模型 grok-4.3 medium |
| dusk / assign / synth / ask / experiments / backfill | 不再从日记页或周期任务触发 | 旧数据还在 | 指令列表里不再显示 |

`editor` 的 add 在段末追加（段不存在就新建），replace / remove 必须和原文完全一致，对不上就跳过并写进这次的 ops 记录。没有要改的就 `{"ops":[]}`，仍然推进 cursor。

## 私有字段

| 字段 | 回复看得到？ | 为什么 |
|---|---|---|
| desire, feel, now, 心情词 | 看得到（未过期、开关开着） | 这是要长成话的结论。desire 是他自己的欲望，不是对她的分析 |
| read_her | 看不到 | 对她的理解留在这里，避免挤进欲望和动作 |
| choice | 看不到 | 否定句和取舍过程留在这里，避免被念出来 |
| plans | 看不到 | 只给 reflect 和 reach 延续。否定句不保存 |
| Dossier 全文 | 生效后看得到 | 一份当前成立的理解，不是流水账 |

## 生效之前和之后

`qr_dossier.active` 默认 false，页面上不露开关。没生效时，热路径和 reflect 继续用旧的 self / bond / portrait。第一次说话、打开「我记得的」，或 `/api/cron/brain`，会排一个幂等任务：已有最新的 seed 草稿就直接生效；没有就生成再生效。`cursor_at` 停在当时最新一条消息上，`turns_since_edit` 归零。之后 editor 的更新本来就会直接写进正文。

清空聊天：

- 还没生效：仍按 `archived_at is null` 标记遗忘（和以前一样）。
- 生效之后：`created_at > cursor_at` 且还没遗忘的，标记 `forgotten_at`。已经整理进文档的对话还在她眼前。日记的 archive 是否跳过被遗忘的消息，维持原样。

## 以后再做（这次不做）

等原文攒了 3–6 个月，在 reflect 里加一个原文检索 tool：pgvector + 时间过滤，先查每天 / 每月摘要，再翻原文。现在不实现。

## 和规格不一致的地方

- `qr_dossier.active` 仍在，当安全开关读，页面上不再点「启用」。没生效之前热路径用旧文。
- 自动 editor 只在 `active` 之后入队。轮次计数一直加，但没生效时不调用整理模型；那时候只跑一次生成或把已有草稿生效。
- `qr_dossier_versions.ops` 存的是 `{ops, skipped, reason}`，不是裸数组。跳过的 replace 才能在版本历史里看见。
- 关系阶段没有单独的列，seed 时从画像主题「关系阶段」读。
- `portrait` route 还留在 `config.ts`，给旧的花费记录用。设置里已经没有画像 prompt，也不会再跑 nightly。
- 实验室的「导入故事线」不再清空或写入 notes / portrait。种子只作为第一次自动整理的输入。
- 清然读 `mem_notes` 的唯一一次是生成初版。日记和检索测试里的函数还在，不在通话路径上。
- `qr_inner.want` 不删。0030 复制进 `desire` 之后不再写入。已保存的自定义 reflect / voice 模板不会被新默认覆盖。默认热路径不再注入 longing；自定义模板里如果还写着 `{want}` 或 `{longing}`，`{want}` 会填成 desire。
