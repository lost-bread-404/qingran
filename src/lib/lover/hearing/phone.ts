import { getProfileData, listHistoryWindow } from "../brain/store.ts";
import { lockedProfile } from "../types.ts";
import { xaiCreds } from "../xai-auth.ts";
import { HEARING, xaiVadThreshold } from "./config.ts";
import { buildHearingContext, extractContextKeyterms, mergeKeyterms, type ContextTurn } from "./context.ts";
import { extractTfIdfTerms } from "./keyterms.ts";
import { backgroundRefreshHearingStt, hotPathHearingStt } from "./stt-cache.ts";
import { keytermList } from "./xai.ts";

/**
 * The iPhone shell's call (requirements 第 7 节). While she speaks, the phone streams her voice straight to xAI and,
 * on the phone, to Apple's recognizer; when she is done it sends the clip and both texts to /api/stt, which runs the
 * same finishing steps as the web. xAI's turn model says when a sentence is finished, so a pause in the middle of
 * one does not end it.
 */

/** What the phone's hearing needs from the talk so far: her settings, the last turns, and the words to listen for. */
export async function phoneHearingInputs() {
  const [savedProfile, recent] = await Promise.all([getProfileData(), listHistoryWindow(null, 24)]);
  const profile = lockedProfile(savedProfile);
  const turns: ContextTurn[] = recent
    .filter((m) => m.kind === "say" || m.kind === "proactive")
    .map((m) => ({ role: m.role, text: m.text.replace(/^⟦回:[^⟧]*⟧/, "") }));
  const context = buildHearingContext(turns);
  const extraKeyterms = mergeKeyterms(
    extractTfIdfTerms([{ text: profile.systemPrompt }], 50),
    extractContextKeyterms(context, 50),
  );
  return { profile, turns, context, extraKeyterms };
}

const STREAM_URL = "wss://api.x.ai/v1/stt";
const CLIENT_SECRET_URL = "https://api.x.ai/v1/realtime/client_secrets";
/** How long a stream ticket lives. The phone takes a fresh one for every line. */
const TICKET_SECONDS = 300;
/** xAI waits this much silence before asking its turn model whether she is done. */
const STREAM_ENDPOINTING_MS = 500;
/** How sure the turn model must be that the sentence is finished. */
const STREAM_SMART_TURN = 0.5;
/** However unfinished the sentence sounds, this much silence ends it (xAI and the phone both). */
export const STREAM_BACKSTOP_MS = 3000;
/** The phone's own ear must also have heard this much quiet before xAI's "she is done" counts. */
export const STREAM_QUIET_MS = 600;
/** Long keyterm lists are cut so the address stays a normal length. */
const URL_MAX = 7000;

export type StreamTicket = {
  url: string;
  token: string;
  expiresAt: number;
  backstopMs: number;
  quietMs: number;
};

function streamUrl(terms: string[]): string {
  const url = new URL(STREAM_URL);
  const q = url.searchParams;
  q.set("model", HEARING.xai.model);
  q.set("sample_rate", "16000");
  q.set("encoding", "pcm");
  q.set("filler_words", "true");
  q.set("vad_threshold", String(xaiVadThreshold()));
  q.set("endpointing", String(STREAM_ENDPOINTING_MS));
  q.set("smart_turn", String(STREAM_SMART_TURN));
  q.set("smart_turn_timeout", String(STREAM_BACKSTOP_MS));
  for (const term of terms) {
    q.append("keyterm", term);
    if (url.toString().length > URL_MAX) {
      const kept = q.getAll("keyterm").slice(0, -1);
      q.delete("keyterm");
      for (const k of kept) q.append("keyterm", k);
      break;
    }
  }
  return url.toString();
}

/** A short-lived xAI secret for one stream, so the phone never holds a real credential. */
async function clientSecret(): Promise<{ token: string; expiresAt: number } | null> {
  // Each credential in turn, without marking the subscription refused for everything else if this one call is.
  for (const cred of await xaiCreds()) {
    try {
      const res = await fetch(CLIENT_SECRET_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cred.token}` },
        body: JSON.stringify({ expires_after: { seconds: TICKET_SECONDS } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const nested = (json.client_secret ?? {}) as Record<string, unknown>;
      const token = [json.value, nested.value, json.secret, json.token].find((v) => typeof v === "string" && v) as string | undefined;
      if (!token) continue;
      const at = Number(json.expires_at ?? nested.expires_at);
      const expiresAt = Number.isFinite(at) && at > 0 ? (at < 1e12 ? at * 1000 : at) : Date.now() + TICKET_SECONDS * 1000;
      return { token, expiresAt };
    } catch {
      /* next credential */
    }
  }
  return null;
}

export async function streamTicket(): Promise<StreamTicket | null> {
  const [{ profile, extraKeyterms }, secret] = await Promise.all([phoneHearingInputs(), clientSecret()]);
  if (!secret) return null;
  let hot = hotPathHearingStt(extraKeyterms);
  if (hot.stale) {
    await backgroundRefreshHearingStt();
    hot = hotPathHearingStt(extraKeyterms);
  }
  return {
    url: streamUrl(keytermList(profile.sttKeyterms, hot.keyterms)),
    token: secret.token,
    expiresAt: secret.expiresAt,
    backstopMs: STREAM_BACKSTOP_MS,
    quietMs: STREAM_QUIET_MS,
  };
}
