import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { brainEditMemory, brainGetMemories, brainRunNightNow } from "@/lib/lover/brain/memory-api";

type MemoryRow = {
  id: number;
  kind: "moment" | "insight";
  source: "story" | "night" | "rosie" | "inner";
  day: string;
  body: string;
  thread: string;
  importance: number;
  changed: string;
  recalled: number;
  /** Empty: 清然 knows it. Otherwise only these people do (he was not there). */
  knows?: string;
};

type Loaded = {
  memories: MemoryRow[];
  counts: { story: number; moments: number; insights: number };
  pendingDay: string | null;
};

function label(m: MemoryRow): string {
  const when = m.source === "story" ? "故事线" : m.day;
  const what = m.kind === "insight" ? "看懂的" : m.source === "inner" ? "心里话" : "";
  const who = m.knows ? `只有${m.knows.split(" ").join("、")}知道` : "";
  return [when, what, who, m.thread, `重要 ${m.importance}`, m.recalled ? `想起过 ${m.recalled} 次` : ""].filter(Boolean).join(" · ");
}

/** 他的心 → 回忆: every moment he keeps, newest first. Story moments change with the storyline itself. */
export function MemoryPanel() {
  const [data, setData] = useState<Loaded | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    void brainGetMemories()
      .then((res) => setData(res as Loaded))
      .catch(() => setError("回忆没读出来。"));
  }

  useEffect(() => {
    load();
  }, []);

  if (!data) return <p className="text-sm text-subtle">{error || "正在读…"}</p>;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">回忆</p>
      <p className="text-xs text-subtle">
        他记得的事，一个话题一件：以后会让他做得不一样的事，和看懂你的地方。你说话时，他会按你这句话想起最贴近的几件。故事线里的 {data.counts.story} 件跟着故事线变；每天凌晨整理时，接着以前话题的合并进原来那一件，新的事接在后面（现在 {data.counts.moments} 件，看懂你的 {data.counts.insights} 条）。
      </p>
      {data.pendingDay ? (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setNote(null);
            void brainRunNightNow()
              .then((res) => {
                setNote(res.done.length ? `整理好了：${res.done.join("、")}` : "这次没整理完。");
                load();
              })
              .catch(() => setError("这次没整理完。"))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "正在整理…（要一两分钟）" : `还有没整理的日子（从 ${data.pendingDay} 起），现在整理`}
        </Button>
      ) : null}
      {note ? <p className="text-xs text-subtle">{note}</p> : null}
      {error ? <p className="text-sm text-live">{error}</p> : null}
      {data.memories.length === 0 ? <p className="text-sm text-subtle">还没有回忆。</p> : null}
      {data.memories.map((m) => (
        <div key={m.id} className="rounded-md bg-surface-2 px-3 py-2">
          <button
            type="button"
            className="w-full text-left"
            onClick={() => {
              setOpenId((cur) => (cur === m.id ? null : m.id));
              setDraft(m.body);
            }}
          >
            <span className="block text-xs text-subtle">{label(m)}</span>
            <span className="block whitespace-pre-wrap text-sm">{m.body}</span>
            {m.changed ? <span className="block text-xs text-subtle">后来：{m.changed}</span> : null}
          </button>
          {openId === m.id && m.source !== "story" ? (
            <div className="mt-2 flex flex-col gap-2">
              <Textarea
                value={draft}
                className="min-h-28 text-sm"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => {
                  if (draft.trim() === m.body.trim() || !draft.trim()) return;
                  void brainEditMemory({ data: { id: m.id, body: draft } })
                    .then(load)
                    .catch(() => setError("没记下。"));
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setData({ ...data, memories: data.memories.filter((x) => x.id !== m.id) });
                  void brainEditMemory({ data: { id: m.id, remove: true } }).catch(() => setError("没删掉。"));
                }}
              >
                删掉这件
              </Button>
            </div>
          ) : null}
          {openId === m.id && m.source === "story" ? <p className="mt-2 text-xs text-subtle">这件来自故事线，在「清然是谁 → 故事线」里改。</p> : null}
        </div>
      ))}
    </div>
  );
}
