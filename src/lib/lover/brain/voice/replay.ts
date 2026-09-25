import { createHash } from "node:crypto";
import { getSql } from "../../../db.ts";
import { collapseReplyVariants } from "../../pair-messages.ts";
import { lockedProfile, voiceInjectFromProfile, type Profile } from "../../types.ts";
import { asModelInput, callModel, type CallModelResult } from "../llm.ts";
import { now } from "../clock.ts";
import type { Effort } from "../config.ts";
import { getDossier } from "../dossier.ts";
import { identityBlock } from "../life.ts";
import { intimateNotesForVoice, momentForVoice } from "../mind-parse.ts";
import { personaAckText } from "../prompts/doc.ts";
import { loadPrompt } from "../prompts/store.ts";
import {
  getInner,
  getMessage,
  getMeta,
  getProfileData,
  getProfilePrompt,
  listHistoryWindow,
  listPortrait,
  listRecentMessages,
} from "../store.ts";
import { formatClock } from "../time.ts";
import { InnerCutBuffer } from "./inner-cut.ts";
import { buildVoiceMessages, renderDossierBlock, renderVoiceLongterm } from "./pack-build.ts";

export type ReplaySide = {
  speech: string;
  innerJson: string | null;
  error: string | null;
  model: string;
  placement: "system" | "first_user";
};

type Complete = typeof callModel;

export async function listReplayTargets(limit = 20): Promise<Array<{ id: string; text: string; createdAt: number }>> {
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
  const zone = opts.profile ? "America/New_York" : "America/New_York";
  const inject = voiceInjectFromProfile(opts.profile);
  const [history, inner, dossierRow, voicePrompt, ackPrompt, meta] = await Promise.all([
    listHistoryWindow(user.id, inject.history, user.createdAt),
    getInner(),
    getDossier(),
    loadPrompt("voice"),
    loadPrompt("persona_ack"),
    getMeta(),
  ]);
  const legacy = dossierRow.active ? null : { portrait: await listPortrait(), meta };
  const half = Math.round(opts.profile.glowHalfLifeDays * 24 * 60 * 60 * 1000);
  const injected = momentForVoice(inner, nowMs, inject.moment, half);
  const clockText = formatClock(nowMs, meta.timeZone || zone);
  const longterm = dossierRow.active
    ? renderDossierBlock(dossierRow.body)
    : renderVoiceLongterm(legacy!.meta.selfSummary, legacy!.meta.bondSummary, legacy!.portrait);
  const messages = buildVoiceMessages({
    charter: opts.charter,
    longtermOverride: dossierRow.active ? longterm : null,
    selfSummary: dossierRow.active ? undefined : legacy!.meta.selfSummary,
    bondSummary: dossierRow.active ? undefined : legacy!.meta.bondSummary,
    portrait: dossierRow.active ? undefined : legacy!.portrait,
    history: collapseReplyVariants(history),
    userText: user.text,
    moment: {
      feel: injected.feel,
      desire: injected.desire,
      now: injected.now,
      longing: injected.longing,
      glow: injected.glow,
    },
    clock: clockText,
    identity: identityBlock(opts.profile.identity),
    voiceTemplate: voicePrompt.body,
    personaPlacement: opts.placement,
    personaAck: personaAckText(ackPrompt.body),
    intimateNotes: intimateNotesForVoice(inner, nowMs, opts.profile.intimateNotes),
    inject,
  });
  return { messages, userText: user.text };
}

function sideFrom(result: CallModelResult, placement: Profile["personaPlacement"]): ReplaySide {
  const cut = new InnerCutBuffer();
  cut.push(result.text || "");
  cut.finish();
  const tail = cut.seen ? cut.tail.trim() : "";
  return {
    speech: cut.speech.trim(),
    innerJson: tail || null,
    error: result.ok ? null : result.failKind || "error",
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
  const [aResult, bResult] = await Promise.all([
    complete("replay", {
      ...asModelInput(aPack.messages),
      model: profile.voiceModel,
      effort: profile.voiceEffort,
      promptKey: "replay",
    }),
    complete("replay", {
      ...asModelInput(bPack.messages),
      model: opts.bModel || profile.voiceModel,
      effort: opts.bEffort,
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
  await db.query(
    `insert into qingran_profile (id, data, updated_at)
     values (1, jsonb_build_object('systemPrompt', $1::text), now())
     on conflict (id) do update
       set data = jsonb_set(coalesce(qingran_profile.data, '{}'::jsonb), '{systemPrompt}', to_jsonb($1::text), true),
           updated_at = now()`,
    [next],
  );
}

export async function listPersonaVersions(limit = 8): Promise<Array<{ hash: string; body: string; at: number }>> {
  const db = await getSql();
  const rows = await db.query<{ hash: string; body: string; last_seen: number }>(
    `select hash, body, last_seen from qr_prompt_versions where key = 'persona' order by last_seen desc limit $1`,
    [limit],
  );
  return rows.map((row) => ({ hash: String(row.hash), body: String(row.body ?? ""), at: Number(row.last_seen) || 0 }));
}
