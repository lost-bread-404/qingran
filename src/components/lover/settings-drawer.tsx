import { Check, Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  brainGetLongLayer,
  brainListNotes,
  brainResetMind,
  brainSaveLongLayer,
  brainSaveNote,
} from "@/lib/lover/brain/api";
import type { BrainLogRow, Mind, Note, PortraitRow, Subject } from "@/lib/lover/brain/types";
import { fromDatetimeLocal, toDatetimeLocal } from "@/lib/lover/memory";
import { BrainBackupPanel } from "@/components/lover/brain-backup-panel";
import { LogoutButton } from "@/components/lover/logout-button";
import { DEFAULT_SYSTEM_PROMPT, type Profile } from "@/lib/lover/types";
import { cn } from "@/lib/utils";

type Tab = "prompt" | "notes" | "portrait" | "mind" | "log";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: Profile;
  onSave: (next: Profile) => void;
  onClearChat: () => void;
};

export function SettingsDrawer({ open, onOpenChange, profile, onSave, onClearChat }: Props) {
  const [draft, setDraft] = useState(profile.systemPrompt);
  const [tab, setTab] = useState<Tab>("prompt");
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState("");
  const [subject, setSubject] = useState<Subject | "">("");
  const [newFact, setNewFact] = useState("");
  const [newAt, setNewAt] = useState(() => toDatetimeLocal(Date.now()));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [self, setSelf] = useState("");
  const [bond, setBond] = useState("");
  const [portrait, setPortrait] = useState<PortraitRow[]>([]);
  const [mind, setMind] = useState<Mind | null>(null);
  const [log, setLog] = useState<BrainLogRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [newTopic, setNewTopic] = useState("");
  const [newBody, setNewBody] = useState("");

  useEffect(() => {
    if (!open) return;
    setDraft(profile.systemPrompt);
    setTab("prompt");
    setEditingId(null);
    setNewAt(toDatetimeLocal(Date.now()));
    void refresh();
  }, [open, profile.systemPrompt]);

  async function refresh() {
    const [noteRes, layer] = await Promise.all([
      brainListNotes({ data: { q: query || undefined, subject: subject || undefined } }),
      brainGetLongLayer(),
    ]);
    setNotes(noteRes);
    setSelf(layer.self);
    setBond(layer.bond);
    setPortrait(layer.portrait);
    setMind(layer.mind);
    setLog(layer.log);
  }

  function savePrompt() {
    onSave({
      ...profile,
      systemPrompt: draft.trim() || DEFAULT_SYSTEM_PROMPT,
    });
    onOpenChange(false);
  }

  async function saveLong() {
    setBusy(true);
    try {
      await brainSaveLongLayer({
        data: {
          self,
          bond,
          portrait: portrait.map((p) => ({ id: p.id, topic: p.topic, body: p.body })),
        },
      });
    } finally {
      setBusy(false);
    }
  }

  async function addNote() {
    const text = newFact.replace(/\s+/g, " ").trim();
    if (!text) return;
    setBusy(true);
    try {
      await brainSaveNote({
        data: {
          text,
          happenedAt: fromDatetimeLocal(newAt),
          subject: "us",
          lens: ["bond", "diary"],
        },
      });
      setNewFact("");
      setNewAt(toDatetimeLocal(Date.now()));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function saveNoteEdit(id: string) {
    const text = editDraft.replace(/\s+/g, " ").trim();
    if (!text) return;
    setBusy(true);
    try {
      await brainSaveNote({ data: { id, text } });
      setEditingId(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function archiveNote(id: string) {
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    setBusy(true);
    try {
      await brainSaveNote({ data: { id, text: note.text, archive: true } });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function addPortraitRow() {
    const topic = newTopic.trim();
    const body = newBody.trim();
    if (!topic || !body) return;
    setPortrait((rows) => [
      ...rows,
      {
        id: `p:${Date.now()}`,
        topic,
        body,
        status: "active",
        evidenceIds: [],
        lastSeen: Date.now(),
        updatedAt: Date.now(),
      },
    ]);
    setNewTopic("");
    setNewBody("");
  }

  if (!open) return null;

  const tabs: Array<[Tab, string]> = [
    ["prompt", "人设"],
    ["notes", "笔记"],
    ["portrait", "画像"],
    ["mind", "内心"],
    ["log", "记录"],
  ];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          aria-label="关闭"
          onClick={() => onOpenChange(false)}
          className="grid size-11 place-items-center rounded-md text-muted"
        >
          <X className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg font-medium tracking-tight">清然</p>
          <p className="text-xs text-subtle">人设、笔记、她眼里的你们。</p>
        </div>
        {tab === "prompt" ? (
          <Button type="button" size="pill" onClick={savePrompt}>
            保存
          </Button>
        ) : tab === "portrait" ? (
          <Button type="button" size="pill" disabled={busy} onClick={() => void saveLong()}>
            保存
          </Button>
        ) : null}
      </header>

      <div className="flex shrink-0 gap-1 overflow-x-auto px-4 pb-3">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "shrink-0 rounded-md px-3 py-2 text-sm",
              tab === id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "prompt" ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={8000}
            className="min-h-0 flex-1 resize-none font-mono leading-relaxed"
            placeholder="写给清然的人设"
          />
          <p className="mt-2 text-xs text-subtle">笔记会另外附上，不用写进这段。</p>
        </div>
      ) : tab === "notes" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            <BrainBackupPanel />
            <a href="/diary#spend" className="text-sm text-subtle underline-offset-2 hover:underline">
              费用
            </a>
            <LogoutButton />
            <div className="flex gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜笔记"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void refresh();
                }}
              />
              <select
                value={subject}
                onChange={(e) => setSubject(e.target.value as Subject | "")}
                className="h-11 rounded-md bg-surface-2 px-2 text-sm text-fg"
              >
                <option value="">全部</option>
                <option value="rosie">Rosie</option>
                <option value="qingran">清然</option>
                <option value="us">我们</option>
              </select>
              <Button type="button" variant="outline" onClick={() => void refresh()}>
                筛
              </Button>
            </div>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void addNote();
              }}
            >
              <Textarea
                value={newFact}
                onChange={(e) => setNewFact(e.target.value)}
                placeholder="记下观察"
                maxLength={120}
                className="min-h-24 resize-none"
              />
              <div className="flex gap-2">
                <Input type="datetime-local" value={newAt} onChange={(e) => setNewAt(e.target.value)} />
                <Button type="submit" size="pill" disabled={!newFact.trim() || busy}>
                  记下
                </Button>
              </div>
            </form>
            {notes.length === 0 ? (
              <p className="text-sm text-subtle">还没有笔记。通话里会慢慢记下来。</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {notes.map((n) => (
                  <li key={n.id} className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm">
                    {editingId === n.id ? (
                      <Input
                        autoFocus
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        className="flex-1"
                      />
                    ) : (
                      <span className="flex-1 leading-relaxed">
                        <span className="mr-2 text-xs text-subtle">{n.localDay.slice(5)}</span>
                        {n.text}
                        {n.tags.length ? (
                          <span className="mt-1 block text-xs text-subtle">{n.tags.join(" · ")}</span>
                        ) : null}
                      </span>
                    )}
                    {editingId === n.id ? (
                      <button
                        type="button"
                        aria-label="好"
                        onClick={() => void saveNoteEdit(n.id)}
                        className="mt-0.5 text-subtle hover:text-fg"
                      >
                        <Check className="size-4" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label="改"
                        onClick={() => {
                          setEditingId(n.id);
                          setEditDraft(n.text);
                        }}
                        className="mt-0.5 text-subtle hover:text-fg"
                      >
                        <Pencil className="size-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label="归档"
                      onClick={() => void archiveNote(n.id)}
                      className="mt-0.5 text-subtle hover:text-fg"
                    >
                      <X className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="outline" onClick={onClearChat}>
              只清屏幕
            </Button>
          </div>
        </div>
      ) : tab === "portrait" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-5">
            <label className="flex flex-col gap-2">
              <span className="text-xs text-subtle">我自己</span>
              <Textarea value={self} onChange={(e) => setSelf(e.target.value)} maxLength={300} className="min-h-28" />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-xs text-subtle">我们</span>
              <Textarea value={bond} onChange={(e) => setBond(e.target.value)} maxLength={200} className="min-h-24" />
            </label>
            <div className="flex flex-col gap-2">
              <span className="text-xs text-subtle">我眼中的她</span>
              {portrait.map((p) => (
                <div key={p.id} className="rounded-md bg-surface-2 p-3">
                  <Input
                    value={p.topic}
                    onChange={(e) =>
                      setPortrait((rows) =>
                        rows.map((r) => (r.id === p.id ? { ...r, topic: e.target.value } : r)),
                      )
                    }
                    className="mb-2"
                  />
                  <Textarea
                    value={p.body}
                    onChange={(e) =>
                      setPortrait((rows) =>
                        rows.map((r) => (r.id === p.id ? { ...r, body: e.target.value } : r)),
                      )
                    }
                    maxLength={80}
                    className="min-h-16"
                  />
                </div>
              ))}
              <div className="flex flex-col gap-2">
                <Input value={newTopic} onChange={(e) => setNewTopic(e.target.value)} placeholder="主题，如 被安慰的方式" />
                <Textarea
                  value={newBody}
                  onChange={(e) => setNewBody(e.target.value)}
                  placeholder="她是怎样的"
                  maxLength={80}
                  className="min-h-16"
                />
                <Button type="button" variant="outline" onClick={addPortraitRow}>
                  加上一条
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : tab === "mind" ? (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-4">
            {mind ? (
              <dl className="flex flex-col gap-3 text-sm">
                <MindRow label="她现在" value={mind.rosie_now} />
                <MindRow label="底下的东西" value={mind.undercurrent} />
                <MindRow label="感受" value={mind.my_feel} />
                <MindRow label="看法" value={mind.my_view} />
                <MindRow label="思路" value={mind.my_logic} />
                <MindRow label="要带她走的路" value={mind.lead_plan.join(" → ")} />
                <MindRow label="这一句" value={mind.intent} />
                <MindRow label="要跟进" value={mind.threads.join("；")} />
              </dl>
            ) : (
              <p className="text-sm text-subtle">还没有内心。说几句之后会慢慢有。</p>
            )}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void brainResetMind()
                  .then(() => refresh())
                  .finally(() => setBusy(false));
              }}
            >
              重置内心
            </Button>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
          <div className="mx-auto flex w-full max-w-md flex-col gap-2">
            {log.length === 0 ? (
              <p className="text-sm text-subtle">还没有调用记录。</p>
            ) : (
              log.map((row) => (
                <div key={row.id} className="rounded-md bg-surface-2 px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className={row.ok ? "text-fg" : "text-live"}>{row.step}</span>
                    <span className="text-subtle">{row.ms != null ? `${row.ms}ms` : ""}</span>
                  </div>
                  {row.note ? <p className="mt-1 text-subtle">{row.note}</p> : null}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MindRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="mt-1 leading-relaxed">{value}</dd>
    </div>
  );
}
