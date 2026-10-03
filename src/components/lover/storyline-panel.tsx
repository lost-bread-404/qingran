import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { brainSaveStoryline } from "@/lib/lover/brain/memory-api";

/**
 * 数据 → 故事线: what happened between them before this app. It is how his memory starts: saved, it is cut into
 * moments (by blank lines) and put into 记忆 → 回忆 right away, replacing the last cut; what the night pass wrote stays.
 */
export function StorylinePanel({ storyline, onSaved }: { storyline: string; onSaved: (storyline: string) => void }) {
  const [draft, setDraft] = useState(storyline);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setDraft(storyline), [storyline]);
  const dirty = draft.trim() !== storyline.trim();

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">故事线</p>
      <p className="text-xs text-subtle">
        这个 app 之前你们之间发生过的事，是他记忆的起点。按空行切成一件一件，放进「记忆 → 回忆」；你说话时他想起最相关的几件，不是每轮都带全文。改了点下面的按钮，会重新切一遍、换掉上次切的那些；夜里整理出来的回忆不动。以后每天的事不用写在这里，凌晨自动整理。
      </p>
      <Textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setNote(null);
        }}
        maxLength={20000}
        className="min-h-64 resize-none leading-relaxed"
        placeholder="你们之前发生过的事"
      />
      <Button
        type="button"
        variant="outline"
        disabled={busy || !dirty}
        onClick={() => {
          setBusy(true);
          setNote(null);
          void brainSaveStoryline({ data: { storyline: draft } })
            .then((res) => {
              if (!res.ok) {
                setNote(res.error);
                return;
              }
              onSaved(draft.trim());
              setNote(`放进记忆了：故事线现在是 ${res.story} 件回忆。`);
            })
            .catch(() => setNote("没存上，再试一次。"))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "正在放进记忆…" : dirty ? "保存，重新放进记忆" : "没有改动"}
      </Button>
      {note ? <p className="text-xs text-subtle">{note}</p> : null}
    </div>
  );
}
