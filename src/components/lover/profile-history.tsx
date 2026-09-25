import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { loadProfileVersions, restoreProfileField } from "@/lib/lover/room";
import type { FieldRevs, VersionedField } from "@/lib/lover/profile-patch";
import type { Profile } from "@/lib/lover/types";
import { cn } from "@/lib/utils";

const FIELDS: Array<{ id: VersionedField; label: string }> = [
  { id: "systemPrompt", label: "人设" },
  { id: "intimateNotes", label: "亲密设定" },
  { id: "identity", label: "身份" },
];

type Row = { id: number; field: VersionedField; value: string; source: string; at: number };

function clock(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function VersionConflict({
  latest,
  onUseLatest,
  onKeepMine,
}: {
  latest: string;
  onUseLatest: () => void;
  onKeepMine: () => void;
}) {
  return (
    <div className="rounded-md bg-surface-2 px-3 py-3">
      <p className="text-sm">这段在别处被改过，已为你加载最新内容</p>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">
        {latest.trim() ? latest : "（空）"}
      </pre>
      <div className="mt-3 flex gap-2">
        <Button type="button" variant="outline" onClick={onUseLatest}>
          改回刚加载的
        </Button>
        <Button type="button" onClick={onKeepMine}>
          仍记下我写的
        </Button>
      </div>
    </div>
  );
}

export function ProfileHistory({
  onRestored,
}: {
  onRestored: (profile: Profile, revs: FieldRevs, field: VersionedField) => void;
}) {
  const [field, setField] = useState<VersionedField>("systemPrompt");
  const [rows, setRows] = useState<Row[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void loadProfileVersions({ data: { field } })
      .then((res) => {
        if (!cancelled) setRows((res.rows ?? []) as Row[]);
      })
      .catch(() => {
        if (!cancelled) setError("记录没读出来。");
      });
    return () => {
      cancelled = true;
    };
  }, [field]);

  async function restore(row: Row) {
    setBusy(row.id);
    setError(null);
    try {
      const result = await restoreProfileField({ data: { id: row.id } });
      if (!result || !("ok" in result) || !result.ok || !("profile" in result)) {
        setError("没恢复。");
        return;
      }
      onRestored(result.profile, result.revs, row.field);
      const again = await loadProfileVersions({ data: { field } });
      setRows((again.rows ?? []) as Row[]);
    } catch {
      setError("没恢复。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-3">
      <p className="text-xs text-subtle">人设、亲密设定和身份每次记下都会留一份。可以看是哪个客户端写的，也可以恢复。</p>
      <div className="flex gap-2">
        {FIELDS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setField(item.id);
              setOpenId(null);
            }}
            className={cn(
              "h-11 flex-1 rounded-md text-sm",
              field === item.id ? "bg-accent text-accent-fg" : "bg-surface-2",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      {error ? <p className="text-sm text-live">{error}</p> : null}
      {rows.length === 0 ? <p className="text-sm text-subtle">还没有改过。</p> : null}
      {rows.map((row) => (
        <div key={row.id} className="rounded-md bg-surface-2 px-3 py-3">
          <button type="button" className="w-full text-left" onClick={() => setOpenId((cur) => (cur === row.id ? null : row.id))}>
            <span className="block text-sm">{clock(row.at)}</span>
            <span className="mt-1 block truncate text-xs text-subtle">{row.source || "未知客户端"}</span>
            <span className="mt-2 block truncate text-sm">{row.value.trim() || "（空）"}</span>
          </button>
          {openId === row.id ? (
            <div className="mt-3">
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">{row.value || "（空）"}</pre>
              <Button type="button" className="mt-3" disabled={busy === row.id} onClick={() => void restore(row)}>
                {busy === row.id ? "正在恢复…" : "恢复这段"}
              </Button>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
