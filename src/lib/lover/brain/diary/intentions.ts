import { createHash } from "node:crypto";
import { now } from "../clock.ts";
import { similar } from "../text.ts";
import { openIntentions, upsertIntention } from "../store.ts";
import { getSql } from "../../../db.ts";
import { newId } from "../../storage.ts";
import type { Intention } from "../types.ts";

export type IntentionOp = {
  op: string;
  id?: string;
  text?: string;
  tag?: string;
  target_day?: string;
  evidence_ids?: string[];
};

export function intentionOpHash(op: IntentionOp): string {
  return createHash("sha256")
    .update(`${op.op}|${op.id ?? ""}|${(op.text ?? "").trim()}|${op.tag ?? ""}|${op.target_day ?? ""}`)
    .digest("hex")
    .slice(0, 24);
}

export function matchOpenIntention(open: Intention[], op: IntentionOp): Intention | undefined {
  const text = String(op.text ?? "").trim();
  const tag = String(op.tag ?? "").trim();
  return open.find((i) => {
    if (tag && i.tag && i.tag === tag) return true;
    if (text && similar(i.text, text)) return true;
    return false;
  });
}

async function claimOp(day: string, hash: string, at: number): Promise<boolean> {
  const db = await getSql();
  const rows = await db.query<{ day: string }>(
    `insert into diary_intention_ops (day, op_hash, applied_at)
     values ($1, $2, $3)
     on conflict (day, op_hash) do nothing
     returning day`,
    [day, hash, at],
  );
  return rows.length > 0;
}

function mergeEvidence(cur: string[], extra: string[]): string[] {
  const out = [...cur];
  for (const id of extra) {
    if (id && !out.includes(id)) out.push(id);
  }
  return out.slice(0, 40);
}

/** Apply dusk intention ops. Same (day, op) is skipped. ADD of a similar open item becomes TOUCH. */
export async function applyIntentionOps(
  day: string,
  ops: IntentionOp[],
  at = now(),
): Promise<{ applied: number; skipped: number }> {
  const open = await openIntentions();
  const known = new Map(open.map((i) => [i.id, i]));
  let applied = 0;
  let skipped = 0;

  for (const raw of ops) {
    const kind = String(raw.op ?? "");
    if (!["ADD", "START", "DONE", "DROP", "TOUCH"].includes(kind)) continue;
    const op: IntentionOp = {
      op: kind,
      id: String(raw.id ?? ""),
      text: String(raw.text ?? "").trim(),
      tag: String(raw.tag ?? ""),
      target_day: String(raw.target_day ?? ""),
      evidence_ids: Array.isArray(raw.evidence_ids) ? raw.evidence_ids.map(String) : [],
    };
    // Hash the dusk-emitted op, not the rewritten TOUCH, so a same-day rerun is skipped.
    const hash = intentionOpHash(op);

    if (op.op === "ADD") {
      const hit = matchOpenIntention(open, op);
      if (hit) {
        op.op = "TOUCH";
        op.id = hit.id;
      }
    }

    if (!(await claimOp(day, hash, at))) {
      skipped += 1;
      continue;
    }

    const evidence = op.evidence_ids ?? [];
    if (op.op === "ADD") {
      const text = op.text ?? "";
      if (!text) continue;
      const row: Intention = {
        id: newId(),
        text,
        tag: op.tag || null,
        statedAt: at,
        targetDay: op.target_day || null,
        status: "open",
        startedAt: null,
        doneAt: null,
        lastEvidenceAt: at,
        evidenceIds: evidence,
        updatedAt: at,
      };
      await upsertIntention(row);
      known.set(row.id, row);
      open.push(row);
      applied += 1;
      continue;
    }

    const id = String(op.id ?? "");
    const cur = known.get(id);
    if (!cur) continue;
    const next: Intention = {
      ...cur,
      evidenceIds: mergeEvidence(cur.evidenceIds, evidence),
      lastEvidenceAt: at,
      updatedAt: at,
    };
    if (op.op === "START") {
      if (cur.status !== "started") {
        next.status = "started";
        next.startedAt = next.startedAt ?? at;
      }
    } else if (op.op === "DONE") {
      if (cur.status !== "done") {
        next.status = "done";
        next.doneAt = at;
        if (!next.startedAt) next.startedAt = at;
      }
    } else if (op.op === "DROP") {
      if (cur.status !== "dropped") next.status = "dropped";
    }
    await upsertIntention(next);
    known.set(id, next);
    applied += 1;
  }

  return { applied, skipped };
}
