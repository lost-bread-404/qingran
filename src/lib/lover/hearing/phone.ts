import { waitUntil } from "@vercel/functions";
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
    .map((m) => ({ role: m.role, text: m.text }));
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
/** Long keyterm lists are cut so the address stays a normal length. */
const URL_MAX = 7000;

export type StreamTicket = {
  url: string;
  token: string;
  expiresAt: number;
  backstopMs: number;
};

function streamUrl(terms: string[]): string {
  // Built by hand so a space is %20, not the form encoding's "+".
  const pair = (k: string, v: string) => `${k}=${encodeURIComponent(v)}`;
  let url = `${STREAM_URL}?${[
    pair("model", HEARING.xai.model),
    pair("sample_rate", "16000"),
    pair("encoding", "pcm"),
    pair("filler_words", "true"),
    pair("vad_threshold", String(xaiVadThreshold())),
    pair("endpointing", String(STREAM_ENDPOINTING_MS)),
    pair("smart_turn", String(STREAM_SMART_TURN)),
    pair("smart_turn_timeout", String(STREAM_BACKSTOP_MS)),
  ].join("&")}`;
  for (const term of terms) {
    let next: string;
    try {
      next = `${url}&${pair("keyterm", term)}`;
    } catch {
      continue; // a term cut in the middle of an emoji has half a character, which cannot be encoded
    }
    if (next.length > URL_MAX) break;
    url = next;
  }
  return url;
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
  // Whatever words are cached now; refreshing them can take a while and the phone is waiting. Only a fresh server
  // with nothing cached yet waits a moment, so her corrected words are in the stream.
  let hot = hotPathHearingStt(extraKeyterms);
  if (hot.needsRefresh) {
    const refresh = backgroundRefreshHearingStt();
    if (hot.cold) {
      await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, 1500))]);
      hot = hotPathHearingStt(extraKeyterms);
    }
    waitUntil(refresh);
  }
  return {
    url: streamUrl(keytermList(profile.sttKeyterms, hot.keyterms)),
    token: secret.token,
    expiresAt: secret.expiresAt,
    backstopMs: STREAM_BACKSTOP_MS,
  };
}
