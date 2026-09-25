import { useEffect, useState } from "react";
import { dismissHomophoneEdit, listHomophoneEdits, type HomophoneRow } from "@/lib/lover/hearing/homophone-api";

/** Same-sounding words you fixed by editing your own messages. Add the right one to keyterms, or dismiss. */
export function HomophoneEdits({ keyterms, onAdd }: { keyterms: string[]; onAdd: (term: string) => void }) {
  const [rows, setRows] = useState<HomophoneRow[] | null>(null);
  useEffect(() => {
    void listHomophoneEdits()
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  const dismiss = (row: HomophoneRow) => {
    setRows((cur) => (cur ?? []).filter((r) => !(r.wrong === row.wrong && r.correct === row.correct)));
    void dismissHomophoneEdit({ data: { wrong: row.wrong, correct: row.correct } }).catch(() => undefined);
  };
  return (
    <div className="rounded-md bg-surface-2 px-3 py-3">
      <p className="text-sm">你改过的同音词</p>
      <p className="mt-1 text-xs text-subtle">你编辑自己消息时，把一个词换成读音相同的另一个词，就会记在这里。想让 xAI 以后直接听对，就加进上面的 keyterm。</p>
      {rows == null ? (
        <p className="mt-2 text-sm text-subtle">正在读…</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-subtle">还没有。</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {rows.map((row) => {
            const added = keyterms.includes(row.correct);
            return (
              <div key={`${row.wrong}>${row.correct}`} className="flex flex-col gap-1 rounded-md bg-surface px-3 py-2">
                <p className="text-sm">
                  {row.wrong} → <span className="text-fg">{row.correct}</span>
                  <span className="ml-2 text-xs text-subtle">×{row.count}</span>
                </p>
                <p className="text-xs text-subtle">{row.example}</p>
                <div className="flex gap-3">
                  <button
                    type="button"
                    className="h-11 text-sm text-muted disabled:opacity-50"
                    disabled={added}
                    onClick={() => onAdd(row.correct)}
                  >
                    {added ? "已在 keyterm" : "加进 keyterm"}
                  </button>
                  <button type="button" className="h-11 text-sm text-muted" onClick={() => dismiss(row)}>
                    删掉
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
