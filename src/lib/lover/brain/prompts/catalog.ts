import {
  PROMPT_TEMPLATES,
  type PromptMessage,
  type PromptPlaceholder,
  type PromptVariantTemplate,
} from "./templates.ts";

export type PromptKey = "voice" | "reflect" | "editor" | "persona_ack" | "report";

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
    blurb: "每次你说完话立刻跑，只生成清然开口的那一句。它看得到人设、当前模式、他记得的、他心里和眼前这一件、现在几点和最近的对话。看不到打算和今天的记录。",
  },
  {
    key: "reflect",
    name: "内心",
    blurb: "每轮回复之后跑一次，更新他心里、眼前这一件、打算和下一次用的模式。你沉默 45 分钟时再跑一次，这时顺便把刚才那一段你的事记进「今天」。没有变化就什么都不改。",
  },
  {
    key: "editor",
    name: "整理记忆",
    blurb: "每天凌晨 4 点后跑一次（main），整篇重写「他记得的」，写这一天的时间线、明天的打算、明早的心里和明早的模式。也可以在「他的心」里手动整理今天。",
  },
  {
    key: "persona_ack",
    name: "人设之后",
    blurb: "人设放在第一条消息时，紧跟着的那一句回应。人设在系统提示里时用不到。",
  },
  {
    key: "report",
    name: "月报",
    blurb: "读这个月每天的时间线和对话，写成一份月报。日记页打开开关后，每月 1 日自动写上个月；也可以在日记页手动写。",
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
