import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { brainGetFeedback, brainRunNightNow } from "@/lib/lover/brain/memory-api";

type Item = { id: number; day: string; body: string };

/** 记忆: rewrite the dossier now, and her complaints the night pass found (for her only; 清然 never sees them). */
export function NightPanel() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void brainGetFeedback()
      .then((res) => setItems(res.items))
      .catch(() => setItems([]));
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setNote(null);
          void brainRunNightNow()
            .then((res) => setNote(res.ok ? "开始整理了，几分钟后回来刷新 dossier。" : res.error))
            .catch(() => setNote("没开始，再试一次。"))
            .finally(() => setBusy(false));
        }}
      >
        现在整理一次 dossier
      </Button>
      {note ? <p className="text-xs text-subtle">{note}</p> : null}
      <p className="pt-2 text-sm">你的抱怨（只有你看得到）</p>
      {items == null ? (
        <p className="text-xs text-subtle">正在读…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-subtle">还没有。</p>
      ) : (
        items.map((item) => (
          <p key={item.id} className="rounded-md bg-surface-2 px-3 py-2 text-sm leading-relaxed">
            <span className="block text-xs text-subtle">{item.day}</span>
            {item.body}
          </p>
        ))
      )}
    </div>
  );
}
