import { createServerFn } from "@tanstack/react-start";
import { createHash } from "node:crypto";
import { now } from "./clock.ts";
import { getMeta, getProfileData, patchMeta, sql } from "./store.ts";
import { resolveTz } from "./tz.ts";
import { clockOf, localDay } from "./time.ts";
import { lockedProfile, type Profile } from "../types.ts";
import { applyProfilePatch } from "../profile-patch.ts";
import { getDossier, publishMemory } from "./dossier.ts";
import { effectiveMode, recordMode } from "./mode.ts";
import { isPromptKey } from "./prompts/catalog.ts";
import { savePrompt } from "./prompts/store.ts";
import { formatLocal, getHeart, listPlans, parseLocalTime, setHeart } from "./heart.ts";
import { STATE_KIND, STATE_VERSION, type StateFile, type StateMessage } from "./state-public.ts";

const EXPORT_PAGE = 1000;

/** Everything except the messages, which come in pages (`offset`). */
export const brainExportState = createServerFn({ method: "POST" })
  .validator((input: { offset?: number } | undefined) => ({ offset: Math.max(0, Number(input?.offset) || 0) }))
  .handler(async ({ data }) => {
    const tz = resolveTz((await getMeta()).timeZone);
    const db = await sql();
    const rows = await db.query<Record<string, unknown>>(
      `select id, role, body, created_at::float8 as created_at, kind, forgotten_at from qingran_messages
       order by created_at asc, id asc limit $1 offset $2`,
      [EXPORT_PAGE, data.offset],
    );
    const messages: StateMessage[] = rows.map((r) => ({
      id: String(r.id),
      role: r.role === "assistant" ? "assistant" : "user",
      text: String(r.body ?? ""),
      at: formatLocal(Number(r.created_at), tz, true),
      kind: String(r.kind ?? "say"),
      ...(r.forgotten_at != null ? { forgotten: true } : {}),
    }));
    const next = rows.length === EXPORT_PAGE ? data.offset + EXPORT_PAGE : null;
    if (data.offset > 0) return { head: null as string | null, messages, next };

    const at = now();
    const profile = lockedProfile(await getProfileData());
    const [dossier, heart, plans, days, prompts, mode] = await Promise.all([
      getDossier(),
      getHeart(),
      listPlans(),
      db.query<{ day: string; timeline: string }>(`select day, timeline from qr_days order by day asc`),
      db.query<{ key: string; body: string }>(`select key, body from qr_prompts order by key`),
      effectiveMode(at, tz, profile.modes.map((m) => m.id)),
    ]);
    const head: StateFile = {
      kind: STATE_KIND,
      version: STATE_VERSION,
      exportedAt: at,
      timeZone: tz,
      profile: profile as unknown as Record<string, unknown>,
      memory: dossier.body,
      heart: heart.text,
      mode,
      plans: plans.map((p) => ({ text: p.text, at: p.at == null ? null : formatLocal(p.at, tz), setBy: p.setBy })),
      days: days.map((d) => ({ day: String(d.day), timeline: String(d.timeline ?? "") })),
      prompts: Object.fromEntries(prompts.map((p) => [String(p.key), String(p.body)])),
    };
    // Sent as text: the profile holds free-form settings.
    return { head: JSON.stringify(head) as string | null, messages, next };
  });

/**
 * Import = initialize. Every section present replaces what is there now; sections left out stay.
 * Messages are never deleted: they are added, or updated by id (see brainImportStateMessages).
 */
export const brainImportState = createServerFn({ method: "POST" })
  .validator((input: { state: StateFile }) => input)
  .handler(async ({ data }) => {
    const state = data.state;
    if (!state || state.kind !== STATE_KIND) return { ok: false as const, error: "不是清然的状态文件。" };
    const at = now();
    const done: string[] = [];
    if (typeof state.timeZone === "string" && state.timeZone.trim()) {
      await patchMeta({ timeZone: state.timeZone.trim() });
      done.push("时区");
    }
    const tz = resolveTz(state.timeZone ?? (await getMeta()).timeZone);
    const db = await sql();

    if (state.profile && typeof state.profile === "object") {
      await applyProfilePatch({ patch: state.profile as Partial<Profile>, source: "import", force: true, at });
      done.push("设置");
    }
    if (typeof state.memory === "string") {
      await publishMemory(state.memory, "import", at);
      done.push("记忆");
    }
    if (typeof state.heart === "string") {
      await setHeart(state.heart, at);
      done.push("心里");
    }
    if (Array.isArray(state.plans)) {
      await db.query(`delete from qr_reach_plans where done_at is null`);
      for (const p of state.plans.slice(0, 30)) {
        const text = String(p?.text ?? "").trim();
        if (!text) continue;
        await db.query(`insert into qr_reach_plans (at, intent, set_by, set_at) values ($1, $2, $3, $4)`, [
          parseLocalTime(p.at, tz),
          text.slice(0, 500),
          typeof p.setBy === "string" && p.setBy ? p.setBy : "import",
          at,
        ]);
      }
      done.push("打算");
    }
    if (Array.isArray(state.days)) {
      await db.query(`delete from qr_days`);
      for (const d of state.days) {
        if (!d?.day) continue;
        await db.query(`insert into qr_days (day, timeline, updated_at) values ($1, $2, $3) on conflict (day) do update set timeline = excluded.timeline, updated_at = excluded.updated_at`, [
          String(d.day),
          String(d.timeline ?? "").slice(0, 3000),
          at,
        ]);
      }
      done.push("每天的时间线");
    }
    if (Array.isArray(state.dayNotes) && state.dayNotes.length) {
      // Older files kept a list of notes; they become lines in that day's text.
      const byDay = new Map<string, string[]>();
      for (const n of state.dayNotes) {
        const when = parseLocalTime(n?.at, tz);
        const text = String(n?.text ?? "").trim();
        if (when == null || !text) continue;
        const day = localDay(when, tz);
        byDay.set(day, [...(byDay.get(day) ?? []), `${clockOf(when, tz)} ${text}`]);
      }
      for (const [day, lines] of byDay) {
        await db.query(
          `insert into qr_days (day, timeline, updated_at) values ($1, $2, $3)
           on conflict (day) do update set timeline = case when qr_days.timeline = '' then excluded.timeline else qr_days.timeline end`,
          [day, lines.join("\n").slice(0, 3000), at],
        );
      }
      done.push("旧的每天记录");
    }
    if (state.prompts && typeof state.prompts === "object") {
      for (const [key, body] of Object.entries(state.prompts)) {
        if (isPromptKey(key) && typeof body === "string" && body.trim()) await savePrompt(key, body);
      }
      done.push("指令");
    }
    if (typeof state.mode === "string" && state.mode.trim()) {
      const profile = lockedProfile(await getProfileData());
      if (profile.modes.some((m) => m.id === state.mode)) {
        await recordMode({ at, mode: state.mode, until: null, why: "导入" });
        done.push("模式");
      }
    }
    return { ok: true as const, done };
  });

function messageId(m: StateMessage, at: number): string {
  if (typeof m.id === "string" && m.id.trim()) return m.id.trim().slice(0, 120);
  const hash = createHash("sha256").update(`${m.role}|${at}|${m.text}`).digest("hex").slice(0, 24);
  return `imp-${hash}`;
}

export const brainImportStateMessages = createServerFn({ method: "POST" })
  .validator((input: { messages: StateMessage[]; timeZone?: string }) => input)
  .handler(async ({ data }) => {
    const tz = resolveTz(data.timeZone ?? (await getMeta()).timeZone);
    const db = await sql();
    let written = 0;
    let skipped = 0;
    for (const m of data.messages ?? []) {
      const at = parseLocalTime(m?.at, tz);
      const text = typeof m?.text === "string" ? m.text : "";
      if (at == null || !text.trim() || (m.role !== "user" && m.role !== "assistant")) {
        skipped += 1;
        continue;
      }
      const kind = typeof m.kind === "string" && m.kind ? m.kind : "say";
      await db.query(
        `insert into qingran_messages (id, role, body, created_at, kind, local_day, forgotten_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (id) do update set body = excluded.body, kind = excluded.kind`,
        [messageId(m, at), m.role, text, at, kind, localDay(at, tz), m.forgotten ? at : null],
      );
      written += 1;
    }
    return { ok: true as const, written, skipped };
  });
