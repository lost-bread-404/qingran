import { createServerFn } from "@tanstack/react-start";
import { getSql } from "../../db.ts";

export type HomophoneRow = { wrong: string; correct: string; count: number; lastAt: number; example: string };

/** Same-sounding swaps Rosie made when editing her own messages, grouped, newest first. */
export const listHomophoneEdits = createServerFn({ method: "GET" }).handler(async (): Promise<HomophoneRow[]> => {
  const db = await getSql();
  const rows = await db.query<Record<string, unknown>>(
    `select wrong, correct, count(*)::int as n, max(at)::float8 as last_at,
            (array_agg(after order by at desc))[1] as example
     from qr_homophone_edits group by wrong, correct order by max(at) desc limit 100`,
  );
  return rows.map((r) => ({
    wrong: String(r.wrong),
    correct: String(r.correct),
    count: Number(r.n) || 0,
    lastAt: Number(r.last_at) || 0,
    example: String(r.example ?? ""),
  }));
});

export const dismissHomophoneEdit = createServerFn({ method: "POST" })
  .validator((d: { wrong: string; correct: string }) => d)
  .handler(async ({ data }) => {
    const db = await getSql();
    await db.query(`delete from qr_homophone_edits where wrong = $1 and correct = $2`, [data.wrong, data.correct]);
    return { ok: true };
  });
