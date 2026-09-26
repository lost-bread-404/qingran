import { getSql } from "../../db.ts";
import { DB_LIMIT_MB } from "./config.ts";
import { now } from "./clock.ts";

export type TableSize = { name: string; bytes: number };

export type DbSize = {
  totalBytes: number | null;
  tables: TableSize[];
  limitMb: number;
  usedRatio: number | null;
  warn: boolean;
  growth30dBytes: number | null;
  fillDate: string | null;
};

export function dbLimitMb(): number {
  return DB_LIMIT_MB;
}

export function formatBytes(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "未知";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export async function brainDbSize(): Promise<DbSize> {
  const limitMb = dbLimitMb();
  const empty: DbSize = {
    totalBytes: null,
    tables: [],
    limitMb,
    usedRatio: null,
    warn: false,
    growth30dBytes: null,
    fillDate: null,
  };
  try {
    const db = await getSql();
    let totalBytes: number | null = null;
    try {
      const tot = await db.query<{ n: number }>(`select pg_database_size(current_database())::bigint as n`);
      const n = Number(tot[0]?.n);
      totalBytes = Number.isFinite(n) ? n : null;
    } catch {
      totalBytes = null;
    }
    let tables: TableSize[] = [];
    try {
      const rows = await db.query<{ name: string; bytes: number }>(
        `select c.relname as name, pg_total_relation_size(c.oid)::bigint as bytes
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
         order by pg_total_relation_size(c.oid) desc`,
      );
      tables = rows
        .map((r) => ({ name: String(r.name), bytes: Number(r.bytes) || 0 }))
        .filter((r) => r.bytes > 0)
        .slice(0, 20);
    } catch {
      tables = [];
    }
    const growth30dBytes: number | null = null;
    const usedRatio =
      totalBytes != null && limitMb > 0 ? totalBytes / (limitMb * 1024 * 1024) : null;
    let fillDate: string | null = null;
    if (totalBytes != null && growth30dBytes != null && growth30dBytes > 0 && limitMb > 0) {
      const remain = limitMb * 1024 * 1024 - totalBytes;
      const daily = growth30dBytes / 30;
      if (daily > 0 && remain > 0) {
        fillDate = new Date(now() + (remain / daily) * 86_400_000).toISOString().slice(0, 10);
      }
    }
    return {
      totalBytes,
      tables,
      limitMb,
      usedRatio,
      warn: usedRatio != null && usedRatio >= 0.7,
      growth30dBytes,
      fillDate,
    };
  } catch {
    return empty;
  }
}
