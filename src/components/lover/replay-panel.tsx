import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  brainAdoptPersona,
  brainListPersonaVersions,
  brainListReplayDays,
  brainListReplayTargets,
  brainReplayCompare,
} from "@/lib/lover/brain/life-api";
import type { Profile, VoiceEffort } from "@/lib/lover/types";
import { ModelPick, type ModelOption, type ModelStat } from "@/components/lover/model-pick";

type Target = { id: string; text: string; createdAt: number };
type Side = {
  speech: string;
  innerJson: string | null;
  error: string | null;
  model: string;
  placement: string;
};

/**
 * The same line of hers answered again: A is what she uses now, B another persona, place or model (any Claude or Grok,
 * picked like 设置 → 回复), so she can see how another model takes a moment she set up.
 */
export function ReplayPanel({ profile, models, stats }: { profile: Profile; models: ModelOption[] | null; stats: ModelStat[] }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [userMsgId, setUserMsgId] = useState("");
  /** "" = the most recent lines; otherwise one day (also before 清空聊天). */
  const [day, setDay] = useState("");
  const [days, setDays] = useState<Array<{ day: string; count: number }>>([]);
  const [persona, setPersona] = useState("");
  const [intimate, setIntimate] = useState("");
  const [placement, setPlacement] = useState<Profile["personaPlacement"]>(profile.personaPlacement);
  const [model, setModel] = useState(profile.voiceModel);
  const [effort, setEffort] = useState<VoiceEffort>(profile.voiceEffort);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [a, setA] = useState<Side | null>(null);
  const [b, setB] = useState<Side | null>(null);
  const [openInner, setOpenInner] = useState(false);
  const [versions, setVersions] = useState<Array<{ hash: string; body: string; at: number }>>([]);

  useEffect(() => {
    let cancelled = false;
    setTargets([]);
    setUserMsgId("");
    void brainListReplayTargets({ data: { day: day || null } })
      .then((rows) => {
        if (cancelled) return;
        setError(null);
        const list = rows as Target[];
        setTargets(list);
        setUserMsgId(list[0]?.id || "");
      })
      .catch(() => {
        if (!cancelled) setError("这一天的话没读出来。");
      });
    return () => {
      cancelled = true;
    };
  }, [day]);

  useEffect(() => {
    void brainListReplayDays()
      .then((rows) => setDays(rows))
      .catch(() => undefined);
    void brainListPersonaVersions()
      .then((rows) => setVersions(rows as Array<{ hash: string; body: string; at: number }>))
      .catch(() => undefined);
  }, []);

  async function compare() {
    if (!userMsgId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await brainReplayCompare({
        data: { userMsgId, persona, intimate, placement, model, effort },
      });
      setA(res.a);
      setB(res.b);
    } catch {
      setError("对比没跑成。");
    } finally {
      setBusy(false);
    }
  }

  async function adopt(text: string) {
    const next = text.trim();
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      await brainAdoptPersona({ data: { persona: next } });
      const rows = await brainListPersonaVersions();
      setVersions(rows as Array<{ hash: string; body: string; at: number }>);
    } catch {
      setError("人设没换上。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      {error ? <p className="text-sm text-live">{error}</p> : null}
      <label className="flex flex-col gap-1">
        <span className="text-sm">哪一天</span>
        <select className="h-11 rounded-md bg-surface-2 px-2 text-sm" value={day} onChange={(e) => setDay(e.target.value)}>
          <option value="">最近 60 句</option>
          {days.map((row) => (
            <option key={row.day} value={row.day}>
              {row.day}（{row.count} 句）
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">哪一句</span>
        <select
          className="h-11 rounded-md bg-surface-2 px-2 text-sm"
          value={userMsgId}
          onChange={(e) => setUserMsgId(e.target.value)}
        >
          {targets.length === 0 ? <option value="">还没有</option> : null}
          {targets.map((row) => (
            <option key={row.id} value={row.id}>
              {clock(row.createdAt)} {row.text.slice(0, 40) || "（空）"}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">B 的人设</span>
        <Textarea
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          className="min-h-36 font-mono text-sm"
          placeholder="贴另一份人设。空着就用现在这份。"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">B 的亲密设定</span>
        <Textarea
          value={intimate}
          onChange={(e) => setIntimate(e.target.value)}
          className="min-h-28 font-mono text-sm"
          placeholder="贴另一份亲密设定。空着就用现在这份。"
        />
      </label>
      <div className="flex flex-col gap-2">
        <p className="text-sm">B 的人设位置</p>
        {(["system", "first_user"] as const).map((id) => (
          <label key={id} className="flex min-h-11 items-center gap-3">
            <input type="radio" name="replay-place" checked={placement === id} onChange={() => setPlacement(id)} />
            <span className="text-sm">{id === "system" ? "系统提示" : "第一条消息"}</span>
          </label>
        ))}
      </div>
      <div className="rounded-md bg-surface-2 px-3 py-3">
        <ModelPick
          label="B 用哪个模型"
          models={models}
          stats={stats}
          model={model}
          effort={effort}
          timeWord="每句"
          onChange={(nextModel, nextEffort) => {
            setModel(nextModel);
            setEffort(nextEffort);
          }}
        />
      </div>
      <Button type="button" disabled={busy || !userMsgId} onClick={() => void compare()}>
        {busy ? "在对比…" : "对比"}
      </Button>
      {a && b ? (
        <div className="flex flex-col gap-2">
          <SideCard title="A 现在用的" side={a} open={openInner} />
          <SideCard title="B" side={b} open={openInner} />
        </div>
      ) : null}
      {a && b ? (
        <button type="button" className="text-left text-sm text-muted" onClick={() => setOpenInner((v) => !v)}>
          {openInner ? "收起｛｝心里话" : "展开｛｝心里话"}
        </button>
      ) : null}
      <Button type="button" variant="outline" disabled={busy || !persona.trim()} onClick={() => void adopt(persona)}>
        把 B 设为当前人设
      </Button>
      {versions.length ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm">换过的人设</p>
          {versions.map((row) => (
            <div key={row.hash} className="rounded-md bg-surface-2 p-2">
              <p className="line-clamp-3 whitespace-pre-wrap text-xs">{row.body}</p>
              <button type="button" className="mt-1 text-sm text-muted" onClick={() => void adopt(row.body)}>
                用回这一份
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function SideCard({ title, side, open }: { title: string; side: Side; open: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-md bg-surface-2 p-2">
      <p className="text-xs text-subtle">
        {title} · {side.placement === "first_user" ? "第一条消息" : "系统"} · {side.model}
      </p>
      {side.error ? <p className="text-xs text-live">{side.error}</p> : null}
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{side.speech || "（没有正文）"}</p>
      {open ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px]">
          {side.innerJson ? side.innerJson : "重放只比较说出来的话。"}
        </pre>
      ) : null}
    </div>
  );
}
