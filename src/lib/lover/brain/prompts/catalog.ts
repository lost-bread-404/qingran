import {
  DIARY_ANALYST_TEXT,
  PROMPT_TEMPLATES,
  type PromptMessage,
  type PromptPlaceholder,
  type PromptVariantTemplate,
} from "./templates.ts";

export { DIARY_ANALYST_TEXT };

export type PromptKey =
  | "voice"
  | "reflect"
  | "archive"
  | "editor"
  | "busy"
  | "busy_tool"
  | "reach"
  | "dusk"
  | "assign"
  | "synth"
  | "ask"
  | "report"
  | "experiments"
  | "backfill"
  | "judge";

export type { PromptMessage, PromptPlaceholder };

export type PromptVariant = PromptVariantTemplate;

export type PromptSpec = {
  key: PromptKey;
  name: string;
  blurb: string;
  placeholders: PromptPlaceholder[];
  variants: PromptVariant[];
  defaultText: string;
};

const META: Array<Pick<PromptSpec, "key" | "name" | "blurb">> = [
  {
    key: "voice",
    name: "每轮回复",
    blurb: "每次你说完话立刻跑，生成清然开口的那一句。模型在这一条上选，下一句生效。",
  },
  {
    key: "reflect",
    name: "内心",
    blurb: "每轮回复后在后台跑。先写自己的欲望，再写对她的理解、心里的感觉、取舍和这一轮要做的动作。回复只看欲望、心里、正在做和心情。",
  },
  {
    key: "archive",
    name: "记笔记",
    blurb: "对话滑出窗口时写观察笔记。用日常档。",
  },
  {
    key: "editor",
    name: "整理记忆",
    blurb: "大约每 20 轮，或隔了一段时间再开口时，把新对话收进「我记得的」。也可以手动现在整理。",
  },
  {
    key: "busy",
    name: "忙碌表",
    blurb: "身份保存后在后台生成未来大约三年的忙闲。身份没变就不会再跑。",
  },
  {
    key: "busy_tool",
    name: "查忙碌",
    blurb: "回复时的工具说明。只有她问起某段时间在忙什么时才会用。",
  },
  {
    key: "reach",
    name: "主动找她",
    blurb: "不在聊天里。醒来之后决定要不要发一条，并写下一次什么时候再想起她。",
  },
  {
    key: "dusk",
    name: "日暮",
    blurb: "一天结束时整理当天日记和因子。用分析档。",
  },
  {
    key: "assign",
    name: "日记打标",
    blurb: "把笔记归进主题、给每天或每周打因子。用日常档。",
  },
  {
    key: "synth",
    name: "合成规律",
    blurb: "每周维护主题、发现新因子。用深思考档。",
  },
  {
    key: "ask",
    name: "问日记",
    blurb: "你在日记页提问时跑。用能调用工具的那档。",
  },
  {
    key: "report",
    name: "月报",
    blurb: "写月报解读。用深思考档。",
  },
  {
    key: "experiments",
    name: "小实验",
    blurb: "月报之后提出小实验。用深思考档。",
  },
  {
    key: "backfill",
    name: "回填",
    blurb: "新因子出现后，按定义回填历史每一天。用日常档。",
  },
  {
    key: "judge",
    name: "评审",
    blurb: "离线评审回复，不在通话里跑。用深思考档。",
  },
];

function specOf(meta: Pick<PromptSpec, "key" | "name" | "blurb">): PromptSpec {
  const variants = PROMPT_TEMPLATES[meta.key] ?? [];
  const head = variants[0]?.messages.find((message) => message.role === "system") ?? variants[0]?.messages[0];
  const placeholders: PromptPlaceholder[] = [];
  const seen = new Set<string>();
  for (const variant of variants) {
    for (const placeholder of variant.placeholders) {
      if (seen.has(placeholder.token)) continue;
      seen.add(placeholder.token);
      placeholders.push(placeholder);
    }
  }
  return {
    ...meta,
    variants,
    placeholders,
    defaultText: head?.content ?? "",
  };
}

export const PROMPT_CATALOG: PromptSpec[] = META.map(specOf);

const BY_KEY = new Map(PROMPT_CATALOG.map((spec) => [spec.key, spec]));

export function isPromptKey(value: unknown): value is PromptKey {
  return typeof value === "string" && BY_KEY.has(value as PromptKey);
}

export function promptSpec(key: PromptKey): PromptSpec {
  return BY_KEY.get(key)!;
}

export function defaultPrompt(key: PromptKey): string {
  return BY_KEY.get(key)!.defaultText;
}

export function promptKeys(): PromptKey[] {
  return PROMPT_CATALOG.map((spec) => spec.key);
}
