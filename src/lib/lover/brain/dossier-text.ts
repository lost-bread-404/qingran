export const DEFAULT_DOSSIER_HEADINGS = [
  "## 你现在的处境",
  "## 你这个人",
  "## 我们",
  "## 我自己",
  "## 还没做完的事",
] as const;

export const DEFAULT_DOSSIER = `${DEFAULT_DOSSIER_HEADINGS.join("\n\n")}\n`;

export const EDITOR_EVERY_TURNS = 20;
export const EDITOR_CONVO_CHARS = 12_000;

export type DossierAction = "add" | "replace" | "remove";

export type DossierOp = {
  section: string;
  action: DossierAction;
  old: string;
  new: string;
};

export type SkippedOp = { index: number; reason: string; section: string };

export type DossierSection = { heading: string; body: string };

export function parseDossier(text: string): { preamble: string; sections: DossierSection[] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections: DossierSection[] = [];
  const pre: string[] = [];
  let current: DossierSection | null = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (current) sections.push(current);
      current = { heading: line.trim(), body: "" };
      continue;
    }
    if (!current) pre.push(line);
    else current.body += (current.body ? "\n" : "") + line;
  }
  if (current) sections.push(current);
  return { preamble: pre.join("\n").trim(), sections };
}

export function renderDossier(preamble: string, sections: DossierSection[]): string {
  const parts: string[] = [];
  if (preamble.trim()) parts.push(preamble.trim());
  for (const section of sections) {
    const body = section.body.replace(/[ \t]+$/g, "").replace(/\n+$/g, "");
    parts.push(body ? `${section.heading}\n${body}` : section.heading);
  }
  const text = parts.join("\n\n").trim();
  return text ? `${text}\n` : "";
}

function asOp(raw: unknown): DossierOp | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const action = row.action;
  if (action !== "add" && action !== "replace" && action !== "remove") return null;
  return {
    section: typeof row.section === "string" ? row.section.trim() : "",
    action,
    old: typeof row.old === "string" ? row.old : "",
    new: typeof row.new === "string" ? row.new : "",
  };
}

export function applyDossierOps(body: string, rawOps: unknown): { body: string; skipped: SkippedOp[]; ops: DossierOp[] } {
  const list = Array.isArray(rawOps) ? rawOps : [];
  const parsed = parseDossier(body.trim() ? body : DEFAULT_DOSSIER);
  const skipped: SkippedOp[] = [];
  const applied: DossierOp[] = [];
  list.forEach((raw, index) => {
    const op = asOp(raw);
    if (!op || !op.section.startsWith("## ")) {
      skipped.push({ index, reason: "bad op", section: op?.section ?? "" });
      return;
    }
    let section = parsed.sections.find((item) => item.heading === op.section);
    if (!section && op.action === "add") {
      section = { heading: op.section, body: "" };
      parsed.sections.push(section);
    }
    if (!section) {
      skipped.push({ index, reason: "section missing", section: op.section });
      return;
    }
    if (op.action === "add") {
      const next = op.new.trim();
      if (!next) {
        skipped.push({ index, reason: "empty add", section: op.section });
        return;
      }
      section.body = section.body.trim() ? `${section.body.replace(/\n+$/g, "")}\n${next}` : next;
      applied.push(op);
      return;
    }
    if (!op.old) {
      skipped.push({ index, reason: "empty old", section: op.section });
      return;
    }
    const at = section.body.indexOf(op.old);
    if (at < 0) {
      skipped.push({ index, reason: "old not found", section: op.section });
      return;
    }
    if (op.action === "replace") {
      section.body = `${section.body.slice(0, at)}${op.new}${section.body.slice(at + op.old.length)}`;
    } else {
      section.body = `${section.body.slice(0, at)}${section.body.slice(at + op.old.length)}`;
    }
    applied.push(op);
  });
  return { body: renderDossier(parsed.preamble, parsed.sections), skipped, ops: applied };
}

export function editorDue(input: {
  active: boolean;
  turns: number;
  gap: boolean;
  unread: boolean;
  manual?: boolean;
  every?: number;
}): "manual" | "turns" | "gap" | null {
  if (input.manual) return "manual";
  if (!input.active) return null;
  if (input.turns >= (input.every ?? EDITOR_EVERY_TURNS)) return "turns";
  if (input.gap && input.unread) return "gap";
  return null;
}

export type ConvoItem = { line: string; createdAt: number };

export function batchConversation(items: ConvoItem[], max = EDITOR_CONVO_CHARS): ConvoItem[][] {
  const batches: ConvoItem[][] = [];
  let cur: ConvoItem[] = [];
  let len = 0;
  for (const item of items) {
    const line = item.line.length > max ? item.line.slice(0, max) : item.line;
    const piece = line === item.line ? item : { ...item, line };
    const add = piece.line.length + (cur.length ? 1 : 0);
    if (cur.length && len + add > max) {
      batches.push(cur);
      cur = [piece];
      len = piece.line.length;
    } else {
      cur.push(piece);
      len += add;
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}
