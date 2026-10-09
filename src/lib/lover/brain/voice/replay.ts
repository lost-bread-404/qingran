import { createHash } from "node:crypto";
import { getSql } from "../../../db.ts";
import { collapseReplyVariants } from "../../pair-messages.ts";
import { lockedProfile, type Profile } from "../../types.ts";
import { asModelInput, callModel, type CallModelResult } from "../llm.ts";
import { now } from "../clock.ts";
import { resolveVoiceChat, type Effort } from "../config.ts";
import { resolveTz } from "../tz.ts";
import { gatherVoiceParts, TODAY_MAX } from "./pack.ts";
import { dayStart } from "../sleep.ts";
import {
  getMessage,
  getMeta,
  getProfileData,
  getProfilePrompt,
  listHistoryWindow,
  listRecentMessages,
  listReplayDays,
  listUserLinesOfDay,
} from "../store.ts";
import { BraceCut } from "./brace-cut.ts";
import { applyProfilePatch } from "../../profile-patch.ts";
import { buildVoiceMessages } from "./pack-build.ts";

export type ReplaySide = {
  speech: string;
  innerJson: string | null;
  error: string | null;
  model: string;
  placement: "system" | "first_user";
};

type Complete = typeof callModel;

export { listReplayDays };

/** Her lines to replay: one day's (any day, also before 清空聊天), or the most recent ones. */
export async function listReplayTargets(limit = 60, day?: string | null): Promise<Array<{ id: string; text: string; createdAt: number }>> {
  if (day) return listUserLinesOfDay(day);
  const rows = await listRecentMessages(240);
  return rows
    .filter((row) => row.role === "user" && row.kind !== "system_notice")
    .slice(-limit)
    .reverse()
    .map((row) => ({ id: row.id, text: row.text.slice(0, 160), createdAt: row.createdAt }));
}

export async function replayMessages(opts: {
  userMsgId: string;
  charter: string;
  placement: Profile["personaPlacement"];
  profile: Profile;
  nowMs?: number;
}): Promise<{ messages: Array<{ role: string; content: string }>; userText: string }> {
  const user = await getMessage(opts.userMsgId);
  if (!user || user.role !== "user") throw new Error("找不到这句");
  const nowMs = opts.nowMs ?? now();
  const meta = await getMeta();
  const tz = resolveTz(meta.timeZone);
  // As it was when she said it, the same as a live reply: her whole day up to that line (from when she last slept,
  // also before a 清空聊天 that came later), the time then, his notes then.
  const at = user.createdAt || nowMs;
  const history = Promise.all([listHistoryWindow(user.id, TODAY_MAX, at, false), dayStart(at, tz)]).then(([rows, start]) =>
    collapseReplyVariants(rows.filter((m) => m.createdAt >= start)),
  );
  const { parts } = await gatherVoiceParts({
    profile: opts.profile,
    nowMs: at,
    timeZone: tz,
    history,
    userText: user.text,
    lastSaidBefore: user.createdAt,
    charter: opts.charter,
    placement: opts.placement,
  });
  const messages = buildVoiceMessages(parts);
  return { messages, userText: user.text };
}

function emptyReason(raw: unknown): string {
  const r = (raw ?? {}) as { stop_reason?: unknown; incomplete_details?: { reason?: unknown } | null };
  const why = r.stop_reason ?? r.incomplete_details?.reason;
  return typeof why === "string" ? why : "空回复";
}

function sideFrom(result: CallModelResult, placement: Profile["personaPlacement"]): ReplaySide {
  const braces = new BraceCut();
  const speech = braces.push(result.text || "").trim();
  braces.finish();
  return {
    speech,
    innerJson: braces.text().trim() || null,
    // A Claude refusal comes back as 200 with no text: say why instead of an empty card.
    error: !result.ok ? result.failKind || "error" : speech ? null : `没有正文（${emptyReason(result.raw)}）`,
    model: result.model,
    placement,
  };
}

/** Read-only. Does not write messages, inner state, reach, or the dossier. */
export async function runReplay(opts: {
  userMsgId: string;
  bPersona: string;
  bPlacement: Profile["personaPlacement"];
  bModel: string;
  bEffort: Effort;
  complete?: Complete;
}): Promise<{ a: ReplaySide; b: ReplaySide }> {
  const profile = lockedProfile(await getProfileData());
  const charter = profile.systemPrompt;
  const complete = opts.complete ?? callModel;
  const [aPack, bPack] = await Promise.all([
    replayMessages({ userMsgId: opts.userMsgId, charter, placement: profile.personaPlacement, profile }),
    replayMessages({
      userMsgId: opts.userMsgId,
      charter: opts.bPersona.trim() || charter,
      placement: opts.bPlacement,
      profile,
    }),
  ]);
  // Each side gets an effort its model takes (grok-4.3 「不想」 is none, which other models reject) and the time the
  // live reply would give it (Claude max may think for minutes).
  const a = resolveVoiceChat(profile.voiceModel, profile.voiceEffort);
  const b = resolveVoiceChat(opts.bModel || profile.voiceModel, opts.bEffort);
  const [aResult, bResult] = await Promise.all([
    complete("replay", {
      ...asModelInput(aPack.messages),
      model: a.model,
      effort: a.effort,
      timeoutMs: a.timeoutMs,
      promptKey: "replay",
    }),
    complete("replay", {
      ...asModelInput(bPack.messages),
      model: b.model,
      effort: b.effort,
      timeoutMs: b.timeoutMs,
      promptKey: "replay",
    }),
  ]);
  return {
    a: sideFrom(aResult, profile.personaPlacement),
    b: sideFrom(bResult, opts.bPlacement),
  };
}

export async function adoptPersona(nextPersona: string): Promise<void> {
  const current = await getProfilePrompt();
  const next = nextPersona.trim().slice(0, 16_000);
  if (!next) throw new Error("人设是空的");
  const ts = now();
  const hash = `persona:${createHash("sha256").update(current).digest("hex")}`;
  const db = await getSql();
  await db.query(
    `insert into qr_prompt_versions (hash, key, body, first_seen, last_seen)
     values ($1, 'persona', $2, $3, $3)
     on conflict (hash) do update set last_seen = excluded.last_seen`,
    [hash, current, ts],
  );
  await applyProfilePatch({
    patch: { systemPrompt: next },
    force: true,
    source: "replay",
    at: ts,
  });
}

export async function listPersonaVersions(limit = 8): Promise<Array<{ hash: string; body: string; at: number }>> {
  const db = await getSql();
  const rows = await db.query<{ hash: string; body: string; last_seen: number }>(
    `select hash, body, last_seen from qr_prompt_versions where key = 'persona' order by last_seen desc limit $1`,
    [limit],
  );
  return rows.map((row) => ({ hash: String(row.hash), body: String(row.body ?? ""), at: Number(row.last_seen) || 0 }));
}
