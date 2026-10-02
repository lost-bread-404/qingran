import { getSql } from "../../db.ts";
import { mergeKeyterms } from "./context.ts";
import { lexiconKeyterms, maybeRebuildLexicon, type Sql } from "./persist.ts";

export const STT_CACHE_TTL_MS = 10 * 60 * 1000;

export type HearingSttSnapshot = {
  keyterms: string[];
  fetchedAt: number;
};

export type HotPathHearingStt = {
  keyterms: string[];
  /** Nothing cached yet on this server. */
  cold: boolean;
  needsRefresh: boolean;
  stale: boolean;
};

let cache: HearingSttSnapshot | null = null;
let refreshInFlight: Promise<HearingSttSnapshot> | null = null;

export function hotPathHearingStt(extra: string[] = []): HotPathHearingStt {
  const snap = cache;
  const ageMs = snap ? Date.now() - snap.fetchedAt : null;
  const stale = snap == null || ageMs == null || ageMs >= STT_CACHE_TTL_MS;
  return {
    keyterms: mergeKeyterms(snap?.keyterms ?? [], extra),
    cold: snap == null,
    needsRefresh: stale,
    stale,
  };
}

export async function refreshHearingSttCache(sql: Sql): Promise<HearingSttSnapshot> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const snap: HearingSttSnapshot = {
      keyterms: await lexiconKeyterms(sql),
      fetchedAt: Date.now(),
    };
    cache = snap;
    return snap;
  })().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

/** Background only: SELECT cache, then maybe rebuild the daily lexicon. Never call on the STT hot path. */
export async function backgroundRefreshHearingStt(): Promise<void> {
  try {
    const sql = await getSql();
    await refreshHearingSttCache(sql);
    await maybeRebuildLexicon(sql);
  } catch {
    /* cache refresh must never break talk */
  }
}

