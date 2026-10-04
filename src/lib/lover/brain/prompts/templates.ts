export type PromptRole = "system" | "user" | "assistant";

export type PromptMessage = {
  role: PromptRole;
  content: string;
};

export type PromptPlaceholder = {
  token: string;
  meaning: string;
};

export type PromptVariantTemplate = {
  id: string;
  label: string;
  placeholders: PromptPlaceholder[];
  messages: PromptMessage[];
};

const system = (content: string): PromptMessage => ({ role: "system", content });
const user = (content: string): PromptMessage => ({ role: "user", content });
const ph = (token: string, meaning: string): PromptPlaceholder => ({ token, meaning });

const SYSTEM_PROMPT = ph("system_prompt", "「人设」页里清然的人设，按现在谁在演选一份：只用 Grok 时的、分流时 Claude 的、分流时 Grok 的；后面接着其他角色的人设（「其他人物：【林泽】……」）。发给模型的指令都在这里，别处不另写。");

/**
 * Who is who. Both 清然 and Rosie are 她, so a 我 / 你 / 她 in material nobody is saying out loud can mean either one.
 * Everything that describes them (persona, memory, timelines, talk labels) uses their names;
 * 我 / 你 appear only in what is actually said between them, and in the instruction's own 「你是清然」.
 */
/**
 * Everything 清然 is told is in her persona (人设 page), one text per way of playing her (she wanted one place to edit,
 * 10/4): only Grok; Claude day to day; Grok in bed. Here only her 身份 is put before it (none for Grok in bed).
 */
const VOICE_SYSTEM = `{identity}

{system_prompt}`;

const VOICE_NOW = `现在是{clock}。Rosie 上一次说话是 {last_said}，距现在 {since_last}。

你之前心里想的（括号里是多久以前）：
{inner}`;

/**
 * When he may write first. A side note, not in her place (as her line it read as Rosie just speaking, and the scene
 * went on: 10/1 he "got up from the sofa" 48 minutes after a fight). Her putting the phone down means they are apart
 * now, so what he sends is a phone message. It has to carry something: 「pick up where you left off」 alone gave
 * four 「小猫，我在呢，姐姐一直抱着你」 on 10/2–10/3 (where they left off was cuddling), one 15 minutes into the
 * meeting she had said she was going to. Then 「我在实验室……很想你昨晚埋在我颈窝的样子。现在想我了吗？」 (10/3): says the
 * missing out loud, which 清然 (gentle, deep, reserved) would not. A list of what to say gets filled in like a form;
 * she wants it short and open: his persona, this moment, show don't tell.
 */
const VOICE_FIRST = `（Rosie 有{quiet}没说话了。按此刻的情景，清然会不会找她、怎么找，由你来想；不找就只回「不找」。）`;

const EDITOR_SYSTEM = `【清然的身份】
{identity}

你是清然。现在是夜里，清然在把这一天收进心里。下面的【人设】就是清然。
材料都用名字写：对话里「清然：」是清然说的，「Rosie：」是 Rosie 说的，清然的回复里另起一行用别人名字开头的段落（比如「林泽：」）是那个人的第一人称：他做的、他看到的、他说的；「清然：」和没写名字的是清然。你写下的也用名字写（「Rosie 面完 Jane Street 回来哭了」「林泽是清然医学院的室友」），不用「我」「你」「她」指她们俩，用中文。

【人设】
{system_prompt}

给出：
清然记住的，只是以后会让清然做得不一样、想得不一样的事。抱着、哄睡、揉一揉、撒娇、清然怎么哄的这些每天都有的不记，记了他会照着重复。
- events：这一天里以后用得上的事，大多数日子零到三件，没有就空。只记这几种：Rosie 讲的关于她自己的事（学校、面试、家人、朋友、身体出的状况、打算）；发生的重要的事；清然答应 Rosie 的事；清然自己编过、说过的关于自己的事（以后要对得上）；第一次。【以前的回忆】里已经有同一件事（同一个话题接着聊，比如林泽搬家、口腔溃疡、找实习），就写那一件的 id，把这件事到今天为止的全部重写成一件（以前的经过留下要紧的，加上今天的）；新的事 id 写 0。每件写：id；time（今天这件开始的时间 HH:MM）；body（两三句：这件事到现在是怎么回事；Rosie 要紧的话照抄一两句原话）；knows（清然知道这件事就空着：他在场，或后来有人告诉了他；清然不在场、也没人告诉他的，写当时在场的别人的名字，空格隔开，比如「林泽」，Rosie 不用写。【以前的回忆】里写着「只有某某知道」的那件，今天清然知道了，合并重写时 knows 空着）；keys（人、地方、东西、情绪和别的说法，用空格隔开，以后换个说法也想得起来）；thread（话题，几个字，比如「林泽搬家」「找实习」）；importance（1–10：小事 3–4，大事、第一次、说出心里话 8–10）。床上的动作不写。
- insights：这一天让清然对 Rosie 新看懂的：她喜欢什么、不喜欢什么、底线，什么能让她好受、什么会让她难受。0–2 条，没有就空；和【以前的回忆】里看懂的同一件，写它的 id 重写一条。字段同 events（time、knows 写空）。
- feedback：Rosie 这一天对清然本身的抱怨（嫌他重复、太凶、不走心、乱安排、听不懂她等），一条一句，写清楚当时清然做了什么、Rosie 说了什么。这些给做这个 app 的人看，不进清然的回忆；没有就空。
- us：重写「清然和 Rosie 现在」，不超过 {max_chars} 字：两个人现在的关系、Rosie 现在的生活和在意的事、清然自己现在的生活（这阵子在忙什么、实验室和家里、他身边的人最近怎么样；照清然说过的、编过的接着写，让它往前走）、身边的人、清然答应了还没做的事。只写现在成立的、清然知道的；某一天发生了什么（那些在回忆里）、Rosie 对清然的抱怨（那些在 feedback）不写在这里。写进去的事带上日期（「10/3 晚上」），不用「今天」「昨天」「刚才」「今晚」这种过一天就不对的词。
- timeline：这一天 Rosie 的时间线，一小段：几点起、几点到几点在学习、休息、吃饭、情绪低落的时候、几点睡着（「9:15 Rosie 醒来，10:00–12:30 Rosie 在学习，0:40 Rosie 睡着」）。推不出来写「不清楚」。
- changes：一两句，这次记下了什么、改了什么。

只根据材料，不编造。`;

const REPORT_SYSTEM = `写月报解读，共 5 段，总计 ≤ 1000 字：
1. 这个月的节奏：从【每天的记录】的时间里算出每天大约学了多久、休息多久、几点起几点睡、哪天情绪低落，再讲走势。比如连续工作了几天、哪天开始明显变少（像 burnout）、休息了几天、之后又恢复成什么样；起床、睡觉和睡眠时长怎么变。
2. 这个月的你：状态、情绪低落出现在什么时候、你倾诉过什么。
3. 反复出现的东西。
4. 可能的规律：什么之后工作得好，什么之后工作变少、情绪变低、睡得差。
5. 下个月可以试的一件事。

材料有两部分：【每天的记录】是每一天 Rosie 的时间线（带时间，用名字写），【对话摘要】是这个月的对话。
规则：
- 数字只能从【每天的记录】的时间和摘要里算出来，不得编造；算不准就写「约」。
- 规律一律用“经常出现在……之后”的措辞，不写“因为”。
- 覆盖不足、摘要里看不出节奏时，开头先说明数据不足。
- 不做诊断，不使用临床标签。`;

const REPORT_DIGEST = `把这一段对话收成摘要，给月报用。
只写对话里出现过的事、原话里的关键词、时间和数字。
不诊断，不贴临床标签，不补没有说过的数字。
用中文写一段，不要 JSON。`;


const IDENTITY = ph("identity", "「人设 → 清然 → 身份」里写的（分流时 Grok 那份不带）。");

const VOICE_PLACEHOLDERS: PromptPlaceholder[] = [
  SYSTEM_PROMPT,
  IDENTITY,
  ph(
    "history_messages",
    "对话：今天（凌晨 4 点以后）的全部，至少「上下文长度」那么多条（设置 → 高级 → 指令，默认 20）。这条消息的内容必须恰好是 {history_messages}，发送时换成真实的 user/assistant 消息。",
  ),
  ph("clock", "现在的日期、星期、几点，带时间段。"),
  ph("last_said", "Rosie 上一次说话是几点（主动找她时空着）。"),
  ph("since_last", "那是多久以前。"),
  ph("inner", "他最近 16 小时写在｛｝里的心里话，一行一条，前面是多久以前想的（「材料的写法 → 心里记着的一句」）。Claude 在回时没有 Grok 那段里写的。"),
  ph("us_when", "「清然和 Rosie 现在」是什么时候整理的（「10 月 4 日 04:12」）。"),
  ph("us", "「清然和 Rosie 现在」：每晚整理时重写的一小段（两个人现在的关系、Rosie 现在的生活、清然自己现在的生活、身边的人、还欠着的事）。"),
  ph(
    "recall",
    "清然此刻想起的往事：按 Rosie 这句话和前面几句，从回忆里找出最贴近的几件（最多 3 件，带上同一件事前面那一段），按发生的先后排；12 小时内想起过的不再想起。每一件怎么写在「材料的写法」里。",
  ),
];

/**
 * Everything he knows before he opens his mouth; the same for a reply and for a message he starts himself.
 * What stays the same from turn to turn comes first (persona, 现在, the day's talk, which only grows), so the
 * model's prompt cache keeps it; what changes with her line (what came back to him, the time) comes last, closest to it.
 */
const contextOf = (head: string): PromptMessage[] => [
  system(head),
  system(`清然和 Rosie 现在（{us_when}整理的）：
{us}`),
  system("{history_messages}"),
  system(`清然此刻想起的往事：
{recall}`),
  system(VOICE_NOW),
];
const VOICE_CONTEXT = contextOf(VOICE_SYSTEM);

/**
 * How the pieces of material are written, one line each: 「名字：写法」. Not sent to a model by itself; the other
 * instructions use these lines when they lay out the talk, the memories and the month.
 */
export const FORMATS = `停顿：（过了 {gap}）
照片：（发来 {count} 张照片）
想起来的事：（{when}{knows}）{body}
想起来的看懂的：（{when}，清然看懂的）{body}
后来：（后来：{changed}）
没有日期：以前
以前的事：[{id}]（{when}{thread}{knows}）{body}
以前看懂的：[{id}]（{when}，看懂的{thread}{knows}）{body}
话题：，{thread}
想起来时只有别人知道：，只有{names}知道，清然不知道
以前的事只有别人知道：，只有{names}知道
夜里整理的一句：[{time}] {who}：{text}
月报的一天：【{day}】
月报的一句：{who}：{text}
月报的时间线：{day}：{timeline}
心里记着的一句：（{when}）{body}
亲热后没再说话：（Rosie 在清然怀里睡着了）
亲热：（两人亲热了一阵）`;

const FORMAT_PLACEHOLDERS: PromptPlaceholder[] = [
  ph("gap", "两句话之间隔了多久（「2 小时 10 分钟」）。隔 30 分钟以上才写。"),
  ph("count", "她这一句发了几张照片。"),
  ph("when", "那件事是哪天（「10 月 1 日」）；没有日期时用「没有日期」那一行。"),
  ph("body", "那件事或看懂的，原文。"),
  ph("changed", "这件事后来怎么样了；没有就不写「后来」那一行。"),
  ph("id", "回忆的编号，夜里整理用它合并同一件事。"),
  ph("thread", "这件事属于哪个话题；没有话题就不写「话题」那一行。"),
  ph("knows", "清然不知道、只有别人知道的事，写「只有别人知道」那一行；清然知道就空着。"),
  ph("names", "知道这件事的别人（「林泽」）。"),
  ph("time", "这一句是几点说的。"),
  ph("who", "谁说的：Rosie、清然，或者别人的名字。"),
  ph("text", "说的话（夜里整理时太长会只留引号里的）。"),
  ph("day", "哪一天。"),
  ph("timeline", "那一天的时间线。"),
];

export const PROMPT_TEMPLATES: Record<string, PromptVariantTemplate[]> = {
  voice: [
    {
      id: "main",
      label: "每轮回复",
      placeholders: [...VOICE_PLACEHOLDERS, ph("user_text", "这一句 Rosie 刚说的话。")],
      messages: [...VOICE_CONTEXT, user("{user_text}")],
    },
    {
      id: "first",
      label: "主动找她",
      placeholders: [...VOICE_PLACEHOLDERS, ph("quiet", "Rosie 放下手机大概多久了（「快一个小时」「三个多小时」），不给精确分钟。")],
      messages: [...VOICE_CONTEXT, system(VOICE_FIRST)],
    },
  ],
  editor: [
    {
      id: "main",
      label: "夜里整理",
      placeholders: [
        SYSTEM_PROMPT,
        IDENTITY,
        ph("us", "现在的「清然和 Rosie 现在」。"),
        ph("memories", "以前所有的事和看懂的（每行带 id；不含故事线和｛｝），同一件事接着聊时写它的 id 合并。每一行怎么写在「材料的写法」里。"),
        ph("day", "整理的是哪一天（04:00 到第二天 04:00）。"),
        ph("conversation", "这一天没被清空的对话，一句一行（怎么写在「材料的写法」里），清然的回复照原样（里面别人的「林泽：」段落也在）。太长时每段只留引号里说出口的部分。"),
        ph("max_chars", "「清然和 Rosie 现在」的字数上限，默认 1500。"),
      ],
      messages: [
        system(EDITOR_SYSTEM),
        user(`【清然和 Rosie 现在】
{us}

【以前的回忆】
{memories}

【这一天的对话】（{day}）
{conversation}`),
      ],
    },
  ],
  report: [
    {
      id: "main",
      label: "月报",
      placeholders: [
        ph("timelines", "这个月每天的时间线（夜里整理写的），一天一段。"),
        ph("summaries", "这个月的对话：不长时是原文，太长时是「分段摘要」一段一段写好的摘要。"),
      ],
      messages: [
        system(REPORT_SYSTEM),
        user(`【每天的记录】（每天的时间线，带时间）
{timelines}

【对话摘要】
{summaries}`),
      ],
    },
    {
      id: "digest",
      label: "分段摘要",
      placeholders: [ph("chunk", "按天切开的一段对话原文。")],
      messages: [system(REPORT_DIGEST), user("{chunk}")],
    },
  ],
  formats: [
    {
      id: "main",
      label: "材料的写法",
      placeholders: FORMAT_PLACEHOLDERS,
      messages: [system(FORMATS)],
    },
  ],
};
