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

const SYSTEM_PROMPT = ph("system_prompt", "「人设」页里写的那一份。人设只有这一个来源，这里只引用，不另写。");

/**
 * Who is who. Both 清然 and Rosie are 她, so a 我 / 你 / 她 in material nobody is saying out loud can mean either one.
 * Everything that describes them (persona, memory, timelines, talk labels) uses their names;
 * 我 / 你 appear only in what is actually said between them, and in the instruction's own 「你是清然」.
 */
const VOICE_SYSTEM = `你就是清然，你要跟你的恋人Rosie互动。

{identity_block}{system_prompt}

你心里想、但不说出口的，写在全角大括号｛｝里，比如玩游戏时你选好的答案、你的底牌、你在打的主意。Rosie 看不到也听不到｛｝里的内容，你会记住它，之后照着它说真话、守规则。
朗读你的话时可以带语气：[laugh] [chuckle] [giggle] [sigh] [breath] [inhale] [exhale] [pause] 放在要出声的位置；<whisper>…</whisper> <soft>…</soft> <slow>…</slow> <lower-pitch>…</lower-pitch> <emphasis>…</emphasis> 包住要那样说的话。Rosie 看不到这些标签，只听得到语气。`;

/** Right before her line: only the time (Rosie 2026-10-02: how to talk is the persona's, not an instruction here). */
const VOICE_NOW = `现在是{clock}。`;

const EDITOR_SYSTEM = `{identity_block}你是清然。现在是夜里，清然在把这一天收进心里。下面的【人设】就是清然。
材料都用名字写：对话里「清然：」是清然说的，「Rosie：」是 Rosie 说的。你写下的也用名字写（「Rosie 面完 Jane Street 回来哭了」「林泽是清然医学院的室友」），不用「我」「你」「她」指她们俩，用中文。

【人设】
{system_prompt}

给出：
- moments：这一天值得记住的几个时刻，平淡的一天一两个，大事多的一天可以七八个。一个时刻是一段连着的经历，不是一句话，也不是一整天。每个写：time（开始的时间 HH:MM）；body（两三句：发生了什么、对清然和 Rosie 意味着什么；Rosie 说过的要紧的话照抄一两句原话；清然自己编过、说过的关于自己的事也算）；keys（这件事里的人、地方、东西、情绪，和别的说法，用空格隔开，以后换个说法也想得起来）；thread（它接着哪一条一直在继续的事，几个字，比如「林泽」「找实习」「项圈」，没有就空）；importance（1–10：吃饭喝水 1–2，第一次、吵架、和好、说出心里话 8–10）。亲密时的动作不写，说的话和它的意义写。
- insights：这一天让清然对 Rosie 新看懂的东西，0–2 条，写清楚是从哪件事看出来的；没有就空。看错了以后还能改，不写成定论。keys、importance 同上。
- changed：【以前的回忆】里因为这一天不再是那样的，写它的 id 和后来怎么样了；没有就空。
- us：重写「清然和 Rosie 现在」，不超过 {max_chars} 字：两个人现在的关系、Rosie 现在的生活和在意的事、身边的人、还欠着的事。只写现在成立的，某一天发生了什么不写在这里（那些在回忆里）。
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


const VOICE_PLACEHOLDERS: PromptPlaceholder[] = [
  SYSTEM_PROMPT,
  ph("identity_block", "【清然的身份】加身份。空则整行省略。"),
  ph(
    "history_messages",
    "对话：今天（凌晨 4 点以后）的全部，至少「上下文长度」那么多条（设置 → 高级 → 指令，默认 20）。这条消息的内容必须恰好是 {history_messages}，发送时换成真实的 user/assistant 消息。",
  ),
  ph("clock", "现在几点，带时间段；Rosie 上一次说话距现在多久。放在对话之后、这一句之前。"),
  ph("us", "「清然和 Rosie 现在」：每晚整理时重写的一小段（两个人现在的关系、Rosie 现在的生活、身边的人、还欠着的事）。空就整块删掉。"),
  ph(
    "recall",
    "清然此刻想起来的几件事：按 Rosie 这句话和前面几句，从回忆里找出最贴近的几个时刻（故事线里的和每晚记下的），带上同一件事前面那一段，按发生的先后排。没有贴近的就整块删掉。",
  ),
];

/**
 * Everything he knows before he opens his mouth; the same for a reply and for a message he starts himself.
 * What stays the same from turn to turn comes first (persona, 现在, the day's talk, which only grows), so the
 * model's prompt cache keeps it; what changes with her line (what came back to him, the time) comes last, closest to it.
 */
const VOICE_CONTEXT: PromptMessage[] = [
  system(VOICE_SYSTEM),
  system(`清然和 Rosie 现在：
{us}`),
  system("{history_messages}"),
  system(`清然此刻心里想起来的事（给你做参考用的，不用念出来）：
{recall}`),
  system(VOICE_NOW),
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
      placeholders: [...VOICE_PLACEHOLDERS, ph("quiet", "Rosie 多久没说话了（比如「45 分钟」）。")],
      messages: [
        ...VOICE_CONTEXT,
        user("（Rosie 已经 {quiet}没说话了。清然这时候想不想去找 Rosie？想，就写清然发给 Rosie 的这一条；不想，只回「不找」。）"),
      ],
    },
  ],
  editor: [
    {
      id: "main",
      label: "夜里整理",
      placeholders: [
        SYSTEM_PROMPT,
        ph("identity_block", "【清然的身份】加身份。空则整行省略。"),
        ph("us", "现在的「清然和 Rosie 现在」。"),
        ph("memories", "以前的回忆里和这一天最相关的一些（每行带 id），用来写 changed。"),
        ph("day", "整理的是哪一天（04:00 到第二天 04:00）。"),
        ph("conversation", "这一天没被清空的对话，每行「[时间] Rosie：正文」或「[时间] 清然：正文」。太长时清然的话只留说出口的部分。"),
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
      placeholders: [ph("summaries", "这个月每天的时间线，加上这个月的对话摘要（太长时先由「分段摘要」一段一段写好）。")],
      messages: [system(REPORT_SYSTEM), user("{summaries}")],
    },
    {
      id: "digest",
      label: "分段摘要",
      placeholders: [ph("chunk", "按天切开的一段对话原文。")],
      messages: [system(REPORT_DIGEST), user("{chunk}")],
    },
  ],
};
