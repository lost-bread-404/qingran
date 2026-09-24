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
  | "portrait"
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
    blurb: "每轮回复后在后台跑，只写跨越多次对话才能看出的深层理解。没有深刻洞察时会空着。用偏快、低思考的那档。",
  },
  {
    key: "archive",
    name: "记笔记",
    blurb: "对话滑出窗口时写观察笔记。用日常档。",
  },
  {
    key: "portrait",
    name: "画像",
    blurb: "每天整理「我眼中的她」「我自己」和「我们」。用分析档。",
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
