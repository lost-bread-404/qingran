# 清然的状态文件（导入 = 初始化）

设置 → 数据 → 「导出」和「导入（初始化）」用的是同一种 JSON 文件。
这份说明也是写给 Claude 的：Rosie 会把以前导出的数据、她写的目标和故事线交给一个新的 Claude 对话，让它写出一份用来初始化的文件，再导入。

代码：`src/lib/lover/brain/state-public.ts`（类型）、`state-io.ts`（导入导出）、`src/components/lover/state-panel.tsx`（按钮）。

## 规则

- 顶层 `kind` 必须是 `"qingran-state"`，`version` 是 `3`。
- **文件里有的部分，整块换掉；没有写的部分，不动。** 例如只想换记忆，就只写 `kind`、`version`、`memory`。
- 消息（`messages`）**只会加上或按 id 更新，永远不删**。没有 `id` 的消息，按「角色 + 时间 + 正文」算出固定 id，同一个文件导入两次不会重复。
- 所有时间都写成 `"YYYY-MM-DD HH:MM"`（消息可以带秒 `"YYYY-MM-DD HH:MM:SS"`），是 `timeZone` 里的当地时间。也可以直接写毫秒时间戳。
- 一天从当地 04:00 算到第二天 04:00（凌晨 1 点睡觉算前一天）。

## 字段

| 字段 | 类型 | 导入时 | 说明 |
|---|---|---|---|
| `kind` | `"qingran-state"` | 必须 | |
| `version` | `3` | 必须 | |
| `exportedAt` | 毫秒 | 忽略 | 导出时写 |
| `timeZone` | IANA 时区，如 `"America/New_York"` | 覆盖 | 文件里所有时间按它解释 |
| `profile` | 对象 | 只覆盖写了的键 | 设置。常用的键见下表 |
| `memory` | 字符串 | 整篇换掉并立刻生效 | 「我记得的」：回复每一句都读、心思和夜里整理也读的那份文档。写法见下 |
| `heart` | 字符串 | 换掉 | 他此刻心里的样子 |
| `mode` | 字符串 | 设为当前模式 | 必须是 `profile.modes` 里的某个 id |
| `plans` | 数组 `{text, at?, setBy?}` | 全部待办换掉 | `at` 为空 = 接下来就做；有时间 = 到点才做。`setBy` 写 `"rosie"` 表示她加的，心思不会删 |
| `days` | 数组 `{day, timeline}` | 全部换掉 | 每天一小段时间线，`day` 形如 `"2026-09-25"`。心思会读最近 7 天看规律，月报也从这里算 |
| `dayNotes` | 数组 `{at, text}` | 全部换掉 | 他随手记下的她的事，一句一条 |
| `prompts` | 对象 `{key: 正文}` | 只覆盖写了的键 | 自定义指令。key 如 `voice`、`reflect`、`editor`、`reach`。一般不用写，用代码里的默认 |
| `messages` | 数组 | 加上 / 按 id 更新 | `{id?, role: "user"｜"assistant", text, at, kind?, forgotten?}`。`kind` 默认 `"say"`，主动消息是 `"proactive"` |

### `profile` 里常用的键

| 键 | 说明 |
|---|---|
| `systemPrompt` | 人设（她写的角色卡） |
| `identity` | 清然的身份（学校、年龄、在做什么），和人设分开 |
| `storyline` | 故事线：在用这个 app 之前两人之间发生过的事。回复不直接读，心思和夜里整理读 |
| `intimateNotes` | 亲密设定，只在勾了 `intimate` 的模式里给回复看 |
| `modes` | 数组 `{id, name, when, prompt, temperature, intimate, keepActions}`：`when` 自然语言写什么时候用；`prompt` 接在人设后面；`temperature` 空为 1.0；`intimate: true` 时带上亲密设定；`keepActions: false` 时夜里整理只记说的话 |
| `brainOn` | 是否运行心思和夜里整理 |
| `voiceModel` | 回复模型 id |
| `historyWindow` | 回复看最近几条（0–80，默认 20） |
| `dossierMaxChars` | 记忆字数上限（2000–8000，默认 4000） |

导出的文件里 `profile` 是完整的设置（含听力参数等），初始化文件只需要写想改的键。

## `memory` 怎么写

它是清然脑子里「记得的」全部，所以写成清然的第一人称：「我」是清然，「她」是 Rosie。不设固定栏目，按人和事组织。取舍只看一条：**这件事会不会改变清然以后怎么做**。通常包括：

- Rosie 在意什么、她一般会怎样（她自己写的那段目标和倾向放在最前面，例如工作日吃药、药效时间最能学、想每天学几个小时、周末可以躺、启动困难时最难的是吃东西和坐到桌前、连续高强度几天后会崩）。
- 她的习惯和事实（早饭换成蛋白质饮料、醒来先吃药、面试在哪天）。
- 对她更深的理解（例如「面试前最难受的不是题，是觉得自己一个人在打」）。
- 人：她那边的人和清然这边的人。每个人写清是谁、和他们什么关系、最近怎样，以及清然是怎么知道的（本来就认识，还是她讲的）。
- 清然自己说过、编过的事，好让以后前后一致。
- 两人现在的关系、还欠着的事。
- 她认真提过的相处意见（撒娇、气话、情趣里的不算）。
- 不写：已经过去的事、一次性的场景细节、亲密时的具体动作。
- 不超过 `dossierMaxChars`（默认 4000 字）。

## 例子

```json
{
  "kind": "qingran-state",
  "version": 3,
  "timeZone": "America/New_York",
  "profile": {
    "storyline": "……",
    "modes": [
      { "id": "real", "name": "现实", "when": "工作日白天该起床、学习、准备面试的时候", "prompt": "", "temperature": null, "intimate": false, "keepActions": true },
      { "id": "tender", "name": "亲密", "when": "休息、午休、晚上收工后抱着说话", "prompt": "", "temperature": null, "intimate": true, "keepActions": true },
      { "id": "bed", "name": "床戏", "when": "她的回应明显想要的时候，到结束为止", "prompt": "", "temperature": 1.3, "intimate": true, "keepActions": false },
      { "id": "sleep", "name": "哄睡", "when": "她说要睡了、要哄睡的时候，一直到她睡着", "prompt": "", "temperature": null, "intimate": true, "keepActions": true }
    ]
  },
  "memory": "她工作日早上半梦半醒时先吃 ADHD 的药……\n\n林泽：我的前室友……",
  "heart": "",
  "plans": [{ "text": "早上她来找我时，先哄她喝蛋白质饮料，再哄她去学", "at": null }],
  "days": [{ "day": "2026-09-24", "timeline": "9:00 起；10–13 学习；……" }],
  "dayNotes": [],
  "messages": [
    { "role": "user", "text": "姐姐早～", "at": "2026-09-25 08:01:12" },
    { "role": "assistant", "text": "小猫早。（亲了亲你的额头）", "at": "2026-09-25 08:01:20" }
  ]
}
```
