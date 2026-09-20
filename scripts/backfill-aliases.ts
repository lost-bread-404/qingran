/**
 * One-shot backfill of mem_notes.aliases. Not a brain job.
 *
 *   npm run backfill:aliases
 */
import { getSql } from "../src/lib/db.ts";
import { now } from "../src/lib/lover/brain/clock.ts";
import { callModel } from "../src/lib/lover/brain/llm.ts";
import { bumpNotesVersion, pgTextArray } from "../src/lib/lover/brain/store.ts";

const BATCH = 40;

const SCHEMA = {
  name: "aliases_backfill",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "aliases"],
          properties: {
            id: { type: "string" },
            aliases: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  },
};

function clipAlias(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= 12 ? t : t.slice(0, 12);
}

async function main() {
  const db = await getSql();
  const rows = await db.query<{ id: string; text: string; tags: unknown }>(
    `select id, text, tags from mem_notes
     where status = 'active' and (aliases is null or cardinality(aliases) = 0)
     order by id`,
  );
  console.log(`[backfill-aliases] ${rows.length} active notes with empty aliases`);
  let filled = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const result = await callModel("assign", {
      system: `你在给记忆笔记补 aliases，只用于检索，不会给清然看到。
aliases：这条笔记以后还可能被怎么说起——同义说法、简称、相关的人名/地名/课程名、中英文对照。最多 6 个，每个 ≤12 字。没有就给空数组。不要改 text。`,
      input: `给下面每条笔记写 aliases。

${batch.map((n) => `${n.id}|${Array.isArray(n.tags) ? n.tags.join(",") : ""}|${n.text}`).join("\n")}`,
      schema: SCHEMA,
    });
    if (!result.ok) {
      console.error(`[backfill-aliases] batch ${i} failed`);
      continue;
    }
    const items = Array.isArray((result.json as { items?: unknown })?.items)
      ? ((result.json as { items: Array<{ id?: string; aliases?: unknown }> }).items ?? [])
      : [];
    const byId = new Map(items.map((it) => [String(it.id ?? ""), it]));
    const ts = now();
    for (const n of batch) {
      const raw = byId.get(n.id)?.aliases;
      const aliases = (Array.isArray(raw) ? raw : [])
        .filter((x): x is string => typeof x === "string")
        .map(clipAlias)
        .filter(Boolean)
        .slice(0, 6);
      await db.query(`update mem_notes set aliases = $2::text[], updated_at = $3 where id = $1`, [
        n.id,
        pgTextArray(aliases),
        ts,
      ]);
      filled += 1;
    }
    console.log(`[backfill-aliases] ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  if (filled) await bumpNotesVersion();
  console.log(`[backfill-aliases] done, wrote ${filled}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
