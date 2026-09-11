import { getSql } from "@/lib/db";
import { formatClock } from "../prompt";
import { newId } from "../storage";

export type JournalKind = "chat" | "l1" | "l2" | "l3" | "portrait" | "open" | "process";

const FILES: Record<JournalKind, string> = {
  chat: "chat.md",
  l1: "l1.md",
  l2: "l2.md",
  l3: "l3.md",
  portrait: "portrait.md",
  open: "open.md",
  process: "process.md",
};

export function journalClock(ms = Date.now(), timeZone = "America/New_York"): string {
  return `${formatClock(ms, timeZone)}  (${new Date(ms).toISOString()})`;
}

export function formatJournalBlock(clock: string, body: string): string {
  return `\n---\n时间 ${clock}\n${body.trim()}\n`;
}

export async function writeJournal(
  kind: JournalKind,
  record: Record<string, unknown>,
  at = Date.now(),
  timeZone = "America/New_York",
): Promise<void> {
  const clock = journalClock(at, timeZone);
  const text = formatJournalBlock(clock, renderJournal(kind, record));
  await Promise.all([
    appendJournalFile(FILES[kind], text),
    appendJournalRow(kind, at, clock, record),
  ]);
}

function renderJournal(kind: JournalKind, record: Record<string, unknown>): string {
  if (kind === "chat") {
    const who = record.role === "assistant" ? "清然" : "Rosie";
    return `${who}：${String(record.text ?? "")}`;
  }
  if (kind === "l1") {
    return `L1 ${record.started ?? ""} → ${record.ended ?? ""}\n${String(record.text ?? "")}`;
  }
  if (kind === "l2") {
    return `L2 ${record.started ?? ""} → ${record.ended ?? ""}\n${String(record.text ?? "")}`;
  }
  if (kind === "l3") {
    const lines = Array.isArray(record.patterns)
      ? (record.patterns as Array<{ status?: string; text?: string }>).map(
          (item) => `- [${item.status ?? ""}] ${item.text ?? ""}`,
        )
      : [];
    return lines.length ? `规律快照\n${lines.join("\n")}` : "规律快照：（空）";
  }
  if (kind === "portrait") {
    return `活画像\n${String(record.text ?? "")}`;
  }
  if (kind === "open") {
    if (!record.draft) return "未闭合事件：已清空";
    return `未闭合事件\n开始：${record.started ?? ""}\n草稿：${record.draft}`;
  }
  const bits = [
    record.step ? `步骤 ${record.step}` : "",
    record.decision ? `判定 ${record.decision}` : "",
    record.note ? `备注 ${record.note}` : "",
    record.closed ? `收入 L1：${record.closed}` : "",
    record.draft ? `当前草稿：${record.draft}` : "",
    record.raw ? `\n模型原文\n${record.raw}` : "",
  ].filter(Boolean);
  return bits.join("\n") || JSON.stringify(record);
}

async function appendJournalFile(name: string, text: string): Promise<void> {
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = process.env.MEMORY_JOURNAL_DIR || path.join(process.cwd(), "memory-journal");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, name);
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, headerFor(name), "utf8");
    }
    await fs.appendFile(file, text, "utf8");
  } catch {
    // Vercel 等只读盘时只靠数据库。
  }
}

function headerFor(name: string): string {
  const title: Record<string, string> = {
    "chat.md": "聊天记录",
    "l1.md": "L1 已结束事件",
    "l2.md": "L2 收束叙述",
    "l3.md": "L3 规律快照",
    "portrait.md": "活画像历史",
    "open.md": "未闭合事件草稿",
    "process.md": "A/B/C 工作过程",
  };
  return `# ${title[name] || name}\n\n只追加，带时间戳。用来看记忆系统这一周实际写了什么。\n`;
}

async function appendJournalRow(
  kind: JournalKind,
  at: number,
  clock: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    const sql = await getSql();
    await sql`
      insert into qingran_journal (id, kind, at, clock, body)
      values (${newId()}, ${kind}, ${at}, ${clock}, ${JSON.stringify(body)}::jsonb)
    `;
  } catch {
    // 迁移未上时不挡说话。
  }
}
