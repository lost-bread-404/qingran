/**
 * Isolated PGLite for eval / backup tests. Applies migrations/*.sql from disk.
 * Does not use DATABASE_URL.
 */
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installTestSql, type Sql } from "../../db.ts";
import { pendingMigrations } from "../../../../scripts/migration-plan.mjs";
import { resetRetrieveCache } from "./voice/retrieve.ts";
import { resetLogRefCache } from "./log-refs.ts";

const OID_INT8 = 20;
const OID_DATE = 1082;
const OID_INTERVAL = 1186;
const identity = (v: string) => v;

function toSql(pg: PGlite): Sql {
  const run = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    const result = await pg.query<T>(text, params);
    return result.rows;
  };
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    let text = strings[0] ?? "";
    for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1] ?? ""}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  sql.query = run;
  return sql;
}

function migrationsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../../../migrations");
}

export async function openIsolatedSql(): Promise<{ sql: Sql; close: () => Promise<void> }> {
  const pg = new PGlite({
    parsers: {
      [OID_INT8]: Number,
      [OID_DATE]: identity,
      [OID_INTERVAL]: identity,
    },
  });
  await pg.waitReady;
  await pg.exec(
    "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const dir = migrationsDir();
  const entries = readdirSync(dir);
  const doneRows = await pg.query<{ name: string }>("select name from _migrations");
  const done = doneRows.rows.map((r) => r.name);
  for (const { name } of pendingMigrations(entries, done)) {
    const text = readFileSync(join(dir, name), "utf8");
    await pg.exec(text);
    await pg.query("insert into _migrations (name) values ($1)", [name]);
  }
  const sql = toSql(pg);
  installTestSql(sql);
  resetRetrieveCache();
  resetLogRefCache();
  return {
    sql,
    close: async () => {
      installTestSql(null);
      resetRetrieveCache();
      resetLogRefCache();
      await pg.close();
    },
  };
}
