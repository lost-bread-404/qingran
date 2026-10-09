import { useEffect, useState } from "react";
import { brainGetFeedback } from "@/lib/lover/brain/memory-api";

type Item = { id: number; day: string; body: string };

/** 记忆: her complaints the night pass found (for her only; 清然 never sees them). 「现在整理一次」 is in the dossier panel. */
export function NightPanel() {
  const [items, setItems] = useState<Item[] | null>(null);

  useEffect(() => {
    void brainGetFeedback()
      .then((res) => setItems(res.items))
      .catch(() => setItems([]));
  }, []);

  return (
    <div className="flex flex-col gap-3">
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
