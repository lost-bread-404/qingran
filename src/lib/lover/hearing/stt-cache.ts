import { getSql } from "../../db.ts";
import { isActiveConfusion, type ConfusionRule } from "./confusions.ts";
import { mergeKeyterms } from "./context.ts";
import { lexiconKeyterms, listHearingConfusions, maybeRebuildLexicon, type Sql } from "./persist.ts";

export const STT_CACHE_TTL_MS = 10 * 60 * 1000;

export type HearingSttSnapshot = {
  keyterms: string[];
  rules: ConfusionRule[];
  fetchedAt: number;
};

export type HotPathHearingStt = {
  keyterms: string[];
  rules: ConfusionRule[];
  needsRefresh: boolean;
  stale: boolean;
};

let cache: HearingSttSnapshot | null = null;
let refreshInFlight: Promise<HearingSttSnapshot> | null = null;

export function peekHearingSttCache(): HearingSttSnapshot | null {
  return cache;
}

export function hotPathHearingStt(extra: string[] = []): HotPathHearingStt {
  const snap = cache;
  const ageMs = snap ? Date.now() - snap.fetchedAt : null;
  const stale = snap == null || ageMs == null || ageMs >= STT_CACHE_TTL_MS;
  return {
    keyterms: mergeKeyterms(snap?.keyterms ?? [], extra),
    rules: snap?.rules ?? [],
    needsRefresh: stale,
    stale,
  };
}

export async function refreshHearingSttCache(sql: Sql): Promise<HearingSttSnapshot> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const rules = await listHearingConfusions(sql);
    const lexicon = await lexiconKeyterms(sql);
    const corrections = rules.filter(isActiveConfusion).map((rule) => rule.correct);
    const snap: HearingSttSnapshot = {
      keyterms: mergeKeyterms(corrections, lexicon),
      rules,
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

export function resetHearingSttCacheForTests() {
  cache = null;
  refreshInFlight = null;
}

export function seedHearingSttCacheForTests(snap: HearingSttSnapshot) {
  cache = snap;
  refreshInFlight = null;
}
