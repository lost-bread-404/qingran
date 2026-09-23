/**
 * One-shot backfill of mem_notes.aliases. Not a brain job.
 *
 *   npm run backfill:aliases
 */
import { getSql } from "../src/lib/db.ts";
import { now } from "../src/lib/lover/brain/clock.ts";
import { asModelInput, callModel } from "../src/lib/lover/brain/llm.ts";
import { bumpNotesVersion, pgTextArray } from "../src/lib/lover/brain/store.ts";
import { loadPrompt } from "../src/lib/lover/brain/prompts/store.ts";
import { parsePromptBody, renderVariant } from "../src/lib/lover/brain/prompts/doc.ts";

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
    const loaded = await loadPrompt("assign");
    const result = await callModel("assign", {
      ...asModelInput(
        renderVariant(parsePromptBody("assign", loaded.body), "aliases", {
          notes: batch.map((n) => `${n.id}|${Array.isArray(n.tags) ? n.tags.join(",") : ""}|${n.text}`).join("\n"),
        }),
      ),
      schema: SCHEMA,
      promptKey: loaded.key,
      promptHash: loaded.hash,
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
