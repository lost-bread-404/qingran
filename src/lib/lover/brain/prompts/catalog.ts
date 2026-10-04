import {
  PROMPT_TEMPLATES,
  type PromptMessage,
  type PromptPlaceholder,
  type PromptVariantTemplate,
} from "./templates.ts";

export type PromptKey = "voice" | "editor" | "report" | "formats";

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
    blurb: "每轮发给模型的材料怎么排：人设（在「人设」页，按现在谁在演选一份）、「清然和 Rosie 现在」、最近的对话、想起的往事、现在几点和他这一段里心里想的。指令都写在人设里，这里只排材料。你很久没说话时，他也想要不要来找你（主动找她）。",
  },
  {
    key: "editor",
    name: "夜里整理",
    blurb: "每天凌晨 4 点后，把还没整理的那天收进回忆：写下这一天的几个时刻（只往后加，不改不删以前的）、新看懂你的地方、以前哪些后来变了，重写「清然和 Rosie 现在」，写这一天的时间线。",
  },
  {
    key: "report",
    name: "月报",
    blurb: "读这个月每天的时间线和对话，写成一份月报。日记页打开开关后，每月 1 日自动写上个月；也可以在日记页手动写。",
  },
  {
    key: "formats",
    name: "材料的写法",
    blurb: "上面几步里一条一条的材料怎么写：对话里的停顿和照片、想起来的事、夜里整理看到的每一句和每件回忆、月报的每一天。一行一种，「名字：写法」，{…} 换成实际内容；写法里的 {…} 都是空的那一行不写。",
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
