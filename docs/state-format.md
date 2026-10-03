# 清然的状态文件（导入 = 初始化）

设置 → 数据 → 「导出」和「导入（初始化）」用的是同一种 JSON 文件。
这份说明也是写给 Claude 的：Rosie 会把以前导出的数据、她写的目标和故事线交给一个新的 Claude 对话，让它写出一份用来初始化的文件，再导入。

代码：`src/lib/lover/brain/state-public.ts`（类型）、`state-io.ts`（导入导出）、`src/components/lover/state-panel.tsx`（按钮）。

## 规则

- 顶层 `kind` 必须是 `"qingran-state"`，`version` 是 `5`。旧文件（≤ 4）里的 `mode`、`plans`、`dayNotes` 导入时忽略；旧的 `memory` 会当成「清然和 Rosie 现在」导入，太长时下一次夜里整理会把它缩短。
- **文件里有的部分，整块换掉；没有写的部分，不动。** 例如只想换回忆，就只写 `kind`、`version`、`memories`。
- 消息（`messages`）**只会加上或按 id 更新，永远不删**。没有 `id` 的消息，按「角色 + 时间 + 正文」算出固定 id，同一个文件导入两次不会重复。
- 所有时间都写成 `"YYYY-MM-DD HH:MM"`（消息可以带秒 `"YYYY-MM-DD HH:MM:SS"`），是 `timeZone` 里的当地时间。也可以直接写毫秒时间戳。
- 一天从当地 04:00 算到第二天 04:00（凌晨 1 点睡觉算前一天）。

## 字段

| 字段 | 类型 | 导入时 | 说明 |
|---|---|---|---|
| `kind` | `"qingran-state"` | 必须 | |
| `version` | `5` | 必须 | |
| `exportedAt` | 毫秒 | 忽略 | 导出时写 |
| `timeZone` | IANA 时区，如 `"America/New_York"` | 覆盖 | 文件里所有时间按它解释 |
| `profile` | 对象 | 只覆盖写了的键 | 设置。常用的键见下表。写了 `storyline` 会马上重新切成回忆 |
| `memory` | 字符串 | 整篇换掉并立刻生效 | 「清然和 Rosie 现在」：回复每一轮都读的一小段。写法见下 |
| `memories` | 数组 | 除故事线切出来的以外，全部换掉 | 一件一件的回忆，见下。文件里出现过的日子算已经整理过，夜里整理不会再写一遍 |
| `days` | 数组 `{day, timeline}` | 全部换掉 | 每天 Rosie 的时间线，`day` 形如 `"2026-09-25"`。月报从这里算 |
| `prompts` | 对象 `{key: 正文}` | 只覆盖写了的键 | 自定义指令。key 是 `voice`、`editor`、`report`。一般不用写，用代码里的默认 |
| `messages` | 数组 | 加上 / 按 id 更新 | `{id?, role: "user"｜"assistant", text, at, kind?, forgotten?, meta?}`。`text` 只有说的话；`meta` 是其余知道的事（回的是哪一句 `replyTo`、选的页 `activeReply`、录音 `voiceTurnId`、照片 `images` 等，见 `src/lib/lover/message-meta.ts`）。`kind` 默认 `"say"`，主动消息是 `"proactive"`。2026-10-02 以前导出的文件，这些写在 `text` 前面的 ⟦…⟧ 里，导入时照样读得懂。照片本身在 `qr_photos`，不在导出文件里 |

### `profile` 里常用的键

| 键 | 说明 |
|---|---|
| `systemPrompt` | 人设（她写的角色卡）。不同场景的反差写在这里，没有模式 |
| `identity` | 清然的身份（学校、年龄、在做什么），和人设分开 |
| `storyline` | 故事线：在用这个 app 之前两人之间发生过的事。按空行切成最早的回忆（一段一件，原文照抄；只有一个名字的短行，比如「林泽：」，跟着下一段） |
| `intimateNotes` | 亲密设定，接在人设后面，每轮都在 |
| `voiceCast` | 角色声线：一行一个人「林泽 lux」，那个人「林泽：」开头的那一段用这个声音念；「其他人 ara」给没写进表的人 |
| `brainOn` | 是否运行记忆（回忆、夜里整理、主动找她） |
| `voiceModel` | 回复模型 id |
| `historyWindow` | 回复至少看几条（0–80，默认 20）；今天的对话总会全带上 |
| `dossierMaxChars` | 「清然和 Rosie 现在」的字数上限（500–3000，默认 1500） |

导出的文件里 `profile` 是完整的设置（含听力参数等），初始化文件只需要写想改的键。

## `memories` 怎么写

每件是一段连着的经历（不是一句话，也不是一整天），或者清然看懂 Rosie 的一个地方：

| 键 | 说明 |
|---|---|
| `kind` | `"moment"`（发生过的事，默认）或 `"insight"`（清然看懂的，写清楚从哪件事看出来的） |
| `source` | `"night"`（夜里整理写的，默认）、`"rosie"`（她自己加的）或 `"inner"`（他写在｛｝里没说出口的）。故事线切出来的不写在这里 |
| `day` | 那天，形如 `"2026-09-28"` |
| `at` | 开始的时间（可空） |
| `body` | 两三句：发生了什么、两个人说了什么要紧的话、对她们意味着什么。用名字写（「Rosie 面完 Jane Street 回来……」），不用「我 / 你 / 她」 |
| `keys` | 这件事里的人、地方、东西、情绪和别的说法，空格隔开。回复靠它和正文想起这件事 |
| `thread` | 它接着哪一条一直在继续的事（几个字：「林泽」「找实习」「项圈」），没有就空。想起一件时，会带上同一条线上紧挨在前面的那件 |
| `importance` | 1–10：吃饭喝水 1–2，第一次、吵架、和好、说出心里话 8–10 |
| `changed` | 后来怎么样了（可空）。这件事不再是那样时写，正文不改 |
| `knows` | 谁知道（可空）。空 = 清然知道；「林泽」= 清然不在场、只有林泽知道 |

## `memory`（清然和 Rosie 现在）怎么写

用名字写。只写现在成立的：两个人现在的关系、Rosie 现在的生活和在意的事（在找什么实习、上什么课、吃药和作息这类会改变清然怎么做的事）、身边的人（是谁、和谁什么关系、清然是怎么知道的）、还欠着的事。某一天发生了什么不写在这里（那些是回忆）。不超过 `dossierMaxChars`。

## 例子

```json
{
  "kind": "qingran-state",
  "version": 5,
  "timeZone": "America/New_York",
  "profile": { "storyline": "……" },
  "memory": "清然和 Rosie 同居，睡一个卧室……Rosie 在找量化公司的实习，10/20 面 Google……",
  "memories": [
    {
      "kind": "moment",
      "day": "2026-09-28",
      "at": "2026-09-28 23:13",
      "body": "Rosie 面完 Jane Street 回来说大概没过，觉得清然没听懂她准备了三周的压力，半夜说清然套公式、要分手，去林泽房间哭。",
      "keys": "Jane Street 面试 没过 分手 林泽 哭 不被懂 压力 三周",
      "thread": "找实习",
      "importance": 9
    }
  ],
  "days": [{ "day": "2026-09-28", "timeline": "8:21 Rosie 醒来……21:00 Rosie 面 Jane Street……一夜没睡。" }]
}
```
