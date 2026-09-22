import { getSql } from "../../db.ts";
import { noteAsOf, messageAsOf, messageEditedAfter } from "./as-of.ts";
import { codeVersion, getBlockByHash, getCharterByHash, type ArchiveRefs, type ReflectRefs, type VoiceRefs } from "./log-refs.ts";
import { fromPgArray, getMeta } from "./store.ts";
import { resolveTz } from "./tz.ts";
import { coerceMind } from "./mind-parse.ts";
import { EMPTY_MIND, type IndexItem, type Mind, type Note, type StoredMessage } from "./types.ts";
import { noteAsIndex } from "./voice/retrieve.ts";
import { buildTail, buildVoiceMessages } from "./voice/pack-build.ts";
import { buildArchivistInput } from "./archivist.ts";
import { buildReflectorInput, formatReflectConversation } from "./voice/reflector.ts";
import { defaultPrompt } from "./prompts/catalog.ts";
import { getPromptVersion } from "./prompts/store.ts";

export type RebuildResult = {
  messages: Array<{ role: string; content: string }>;
  warnings: string[];
};

function asObj(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  return v as Record<string, unknown>;
}

function asStrArr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  return fromPgArray(v);
}

function warnCode(code: string | null | undefined, warnings: string[]) {
  const cur = codeVersion();
  if (code && code !== cur) {
    warnings.push("拼装代码已变化，重建结果可能与当时不完全一致");
  }
}

type LoadedLog = {
  id: number;
  route: string | null;
  at: number;
  codeVersion: string | null;
  refs: Record<string, unknown> | null;
  outputRef: string | null;
  promptKey: string | null;
  promptHash: string | null;
  inputSystem: string | null;
  inputUser: string | null;
  outputText: string | null;
  raw: string | null;
};

async function loadLog(opts: { turnSeq?: number; logId?: number; route?: string }): Promise<LoadedLog | null> {
  const db = await getSql();
  if (opts.logId) {
    const rows = await db.query<Record<string, unknown>>(`select * from brain_log where id = $1`, [opts.logId]);
    const r = rows[0];
    if (!r) return null;
    return mapLog(r);
  }
  if (opts.turnSeq != null) {
    const route = opts.route ?? "voice";
    const rows = await db.query<Record<string, unknown>>(
      `select * from brain_log where turn_seq = $1 and route = $2 order by id desc limit 1`,
      [opts.turnSeq, route],
    );
    const r = rows[0];
    if (!r) return null;
    return mapLog(r);
  }
  return null;
}

function mapLog(r: Record<string, unknown>): LoadedLog {
  return {
    id: Number(r.id),
    route: r.route ? String(r.route) : null,
    at: Number(r.at) || 0,
    codeVersion: r.code_version ? String(r.code_version) : null,
    refs: asObj(typeof r.refs === "string" ? JSON.parse(String(r.refs)) : r.refs),
    outputRef: r.output_ref ? String(r.output_ref) : null,
    promptKey: r.prompt_key ? String(r.prompt_key) : null,
    promptHash: r.prompt_hash ? String(r.prompt_hash) : null,
    inputSystem: r.input_system ? String(r.input_system) : null,
    inputUser: r.input_user ? String(r.input_user) : null,
    outputText: r.output_text ? String(r.output_text) : null,
    raw: r.raw ? String(r.raw) : null,
  };
}

function storedPromptMessages(log: LoadedLog): RebuildResult | null {
  const messages: Array<{ role: string; content: string }> = [];
  if (log.inputSystem) messages.push({ role: "system", content: log.inputSystem });
  if (log.inputUser) messages.push({ role: "user", content: log.inputUser });
  if (!messages.length) return null;
  return { messages, warnings: [] };
}

async function promptBody(hash: string | null, fallbackKey: "voice" | "reflect" | "archive"): Promise<string> {
  if (hash) {
    const body = await getPromptVersion(hash);
    if (body) return body;
  }
  return defaultPrompt(fallbackKey);
}

async function loadTurn(turnSeq: number): Promise<Record<string, unknown> | null> {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(`select * from brain_turns where turn_seq = $1`, [turnSeq]);
  return rows[0] ?? null;
}

async function loadMindAt(turnSeq: number): Promise<Mind | null> {
  if (!turnSeq) return EMPTY_MIND;
  const db = await getSql();
  const rows = await db.query<{ data: unknown }>(`select data from qr_mind_history where turn_seq = $1`, [turnSeq]);
  if (!rows[0]) return null;
  const data = typeof rows[0].data === "string" ? JSON.parse(String(rows[0].data)) : rows[0].data;
  if (!data || typeof data !== "object") return EMPTY_MIND;
  return coerceMind(data, turnSeq);
}

function asNumArr(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(Number).filter((n) => Number.isFinite(n));
  if (typeof v === "string") {
    const inner = v.trim().replace(/^\{/, "").replace(/\}$/, "");
    if (!inner) return [];
    return inner.split(",").map(Number).filter((n) => Number.isFinite(n));
  }
  return [];
}

function voiceRefsFromTurn(turn: Record<string, unknown>): VoiceRefs {
  const queryIds = asStrArr(turn.query_ids).length ? asStrArr(turn.query_ids) : asStrArr(turn.fallback_ids);
  return {
    charterHash: String(turn.charter_hash ?? ""),
    longtermHash: String(turn.longterm_hash ?? ""),
    historyIds: asStrArr(turn.history_ids),
    mindTurnSeq: Number(turn.mind_turn_seq) || 0,
    mindStale: turn.mind_stale === true || turn.mind_stale === "t",
    pickedIds: asStrArr(turn.picked_ids),
    fallbackIds: queryIds,
    queryIds,
    queryScores: asNumArr(turn.query_scores),
    jump: turn.jump === true || turn.jump === "t",
    jumpScore: Number(turn.jump_score) || 0,
    careHint: turn.care_hint === true || turn.care_hint === "t",
    clockText: String(turn.clock_text ?? ""),
    userMsgId: String(turn.user_msg_id ?? ""),
    timeZone: "",
    mindAgeMs: Number(turn.mind_age_ms) || 0,
  };
}

async function notesInOrder(ids: string[], t: number, warnings: string[]): Promise<Note[]> {
  const out: Note[] = [];
  for (const id of ids) {
    const n = await noteAsOf(id, t);
    if (!n) {
      warnings.push(`笔记缺失：${id}`);
      continue;
    }
    out.push(n);
  }
  return out;
}

async function messagesInOrder(ids: string[], t: number, warnings: string[]): Promise<StoredMessage[]> {
  const out: StoredMessage[] = [];
  for (const id of ids) {
    const m = await messageAsOf(id, t);
    if (!m) {
      warnings.push(`消息缺失：${id}`);
      continue;
    }
    if (await messageEditedAfter(id, t)) warnings.push(`消息在调用后被编辑过：${id}`);
    out.push(m);
  }
  return out;
}

export async function rebuildVoiceMessages(turnSeq: number): Promise<RebuildResult> {
  const warnings: string[] = [];
  const log = await loadLog({ turnSeq, route: "voice" });
  const turn = await loadTurn(turnSeq);
  const refs = (log?.refs as VoiceRefs | null) ?? (turn ? voiceRefsFromTurn(turn) : null);
  if (!refs) return { messages: [], warnings: ["找不到这一轮的引用"] };
  warnCode(log?.codeVersion ?? (turn?.code_version ? String(turn.code_version) : null), warnings);
  const t = log?.at || Number(turn?.created_at) || 0;
  const charter = refs.charterHash ? await getCharterByHash(refs.charterHash) : null;
  if (refs.charterHash && !charter) warnings.push("人设快照缺失");
  const block = refs.longtermHash ? await getBlockByHash(refs.longtermHash) : null;
  if (refs.longtermHash && !block) warnings.push("长期块快照缺失");
  const history = await messagesInOrder(refs.historyIds ?? [], t, warnings);
  const user = refs.userMsgId ? await messageAsOf(refs.userMsgId, t) : null;
  if (refs.userMsgId && !user) warnings.push("用户消息缺失");
  if (user && (await messageEditedAfter(refs.userMsgId, t))) warnings.push(`消息在调用后被编辑过：${refs.userMsgId}`);
  const notes = await notesInOrder([...(refs.pickedIds ?? []), ...(refs.queryIds ?? refs.fallbackIds ?? [])], t, warnings);
  const mind = refs.mindTurnSeq ? await loadMindAt(refs.mindTurnSeq) : EMPTY_MIND;
  if (refs.mindTurnSeq && !mind) warnings.push("内心记录缺失");
  const liveMind = mind ?? EMPTY_MIND;
  const tz = resolveTz(refs.timeZone || (await getMeta()).timeZone);
  const nowMs = (liveMind.updated_at ?? 0) + (refs.mindAgeMs || 0);
  const tail = buildTail({
    clock: refs.clockText,
    mind: liveMind,
    notes,
    timeZone: tz,
    careHint: Boolean(refs.careHint),
    nowMs,
    stale: Boolean(refs.mindStale),
    jump: Boolean(refs.jump),
  });
  const voiceBody = await promptBody(log?.promptHash ?? null, "voice");
  const messages = buildVoiceMessages({
    charter: charter ?? "",
    longterm: block?.text ?? "",
    history,
    tail,
    userText: user?.text ?? "",
    voiceTemplate: voiceBody,
  });
  return { messages, warnings };
}

export async function rebuildReflectorInput(turnSeq: number): Promise<RebuildResult> {
  const warnings: string[] = [];
  const log = await loadLog({ turnSeq, route: "reflect" });
  if (!log?.refs) return { messages: [], warnings: ["找不到这一轮内心的引用"] };
  warnCode(log.codeVersion, warnings);
  const refs = log.refs as unknown as ReflectRefs;
  const t = log.at;
  const charter = refs.charterHash ? await getCharterByHash(refs.charterHash) : null;
  if (refs.charterHash && !charter) warnings.push("人设快照缺失");
  const block = refs.blockBHash ? await getBlockByHash(refs.blockBHash) : null;
  if (refs.blockBHash && !block) warnings.push("长期块快照缺失");
  const relatedNotes = await notesInOrder(refs.relatedIds ?? [], t, warnings);
  const relatedIndex: IndexItem[] = relatedNotes.map((n) => noteAsIndex(n));
  const recent = await messagesInOrder(refs.recentMessageIds ?? [], t, warnings);
  const oldMind = refs.oldMindTurnSeq ? await loadMindAt(refs.oldMindTurnSeq) : EMPTY_MIND;
  if (refs.oldMindTurnSeq && !oldMind) warnings.push("内心记录缺失");
  const tz = resolveTz(refs.timeZone);
  const packed = buildReflectorInput(
    {
      charter: charter ?? "",
      selfSummary: "",
      bondSummary: "",
      portrait: [],
      themes: [],
      findings: [],
      coreIndex: [],
      clock: refs.clockText,
      relatedIndex,
      oldMind: oldMind ?? EMPTY_MIND,
      conversation: formatReflectConversation(recent, tz),
    },
    await promptBody(log.promptHash, "reflect"),
  );
  if (block?.text != null) packed.stable = block.text;
  return {
    messages: [
      { role: "system", content: packed.system },
      { role: "user", content: packed.stable },
      { role: "user", content: packed.turn },
    ],
    warnings,
  };
}

export async function rebuildArchiveInput(logId: number): Promise<RebuildResult> {
  const warnings: string[] = [];
  const log = await loadLog({ logId });
  if (!log?.refs) return { messages: [], warnings: ["找不到这条整理记录的引用"] };
  warnCode(log.codeVersion, warnings);
  const refs = log.refs as unknown as ArchiveRefs;
  const t = log.at;
  const pending = await messagesInOrder(refs.batchMessageIds ?? [], t, warnings);
  const candidates = await notesInOrder(refs.candidateNoteIds ?? [], t, warnings);
  return {
    messages: [
      { role: "system", content: await promptBody(log.promptHash, "archive") },
      { role: "user", content: buildArchivistInput(pending, candidates) },
    ],
    warnings,
  };
}

export async function rebuildFromLog(row: {
  id?: number;
  route?: string | null;
  turn_seq?: number | null;
}): Promise<RebuildResult | null> {
  const route = row.route ?? "";
  if (route === "voice" && row.turn_seq != null) return rebuildVoiceMessages(Number(row.turn_seq));
  if (route === "reflect" && row.turn_seq != null) return rebuildReflectorInput(Number(row.turn_seq));
  if (route === "archive" && row.id != null) return rebuildArchiveInput(Number(row.id));
  if (row.id != null) {
    const log = await loadLog({ logId: Number(row.id) });
    if (!log) return null;
    return storedPromptMessages(log);
  }
  return null;
}
