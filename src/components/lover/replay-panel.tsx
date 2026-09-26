import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  brainAdoptPersona,
  brainListPersonaVersions,
  brainListReplayTargets,
  brainReplayCompare,
} from "@/lib/lover/brain/life-api";
import type { Profile } from "@/lib/lover/types";

type Target = { id: string; text: string; createdAt: number };
type Side = {
  speech: string;
  innerJson: string | null;
  error: string | null;
  model: string;
  placement: string;
};

export function ReplayPanel({ profile }: { profile: Profile }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [userMsgId, setUserMsgId] = useState("");
  const [persona, setPersona] = useState("");
  const [placement, setPlacement] = useState<Profile["personaPlacement"]>(profile.personaPlacement);
  const [model, setModel] = useState(profile.voiceModel);
  const [effort, setEffort] = useState<NonNullable<Profile["voiceEffort"]>>(profile.voiceEffort ?? "low");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [a, setA] = useState<Side | null>(null);
  const [b, setB] = useState<Side | null>(null);
  const [openInner, setOpenInner] = useState(false);
  const [versions, setVersions] = useState<Array<{ hash: string; body: string; at: number }>>([]);

  useEffect(() => {
    void brainListReplayTargets()
      .then((rows) => {
        const list = rows as Target[];
        setTargets(list);
        setUserMsgId((cur) => cur || list[0]?.id || "");
      })
      .catch(() => setError("最近的话没读出来。"));
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
        data: { userMsgId, persona, placement, model, effort },
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
      <p className="text-xs text-subtle">
        用当时的对话、他记得的、他心里，各生成一次。不写入聊天，也不改他的心。同一句可以多跑几次看稳不稳。
      </p>
      {error ? <p className="text-sm text-live">{error}</p> : null}
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
              {row.text.slice(0, 42) || "（空）"}
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
      <div className="flex flex-col gap-2">
        <p className="text-sm">B 的人设位置</p>
        {(["system", "first_user"] as const).map((id) => (
          <label key={id} className="flex min-h-11 items-center gap-3">
            <input type="radio" name="replay-place" checked={placement === id} onChange={() => setPlacement(id)} />
            <span className="text-sm">{id === "system" ? "系统提示" : "第一条消息"}</span>
          </label>
        ))}
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-sm">B 的模型</span>
        <input
          className="h-11 rounded-md bg-surface-2 px-3 text-sm"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm">B 的 effort</span>
        <select
          className="h-11 rounded-md bg-surface-2 px-2 text-sm"
          value={effort ?? "low"}
          onChange={(e) => setEffort(e.target.value === "high" || e.target.value === "medium" ? e.target.value : "low")}
        >
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </label>
      <Button type="button" disabled={busy || !userMsgId} onClick={() => void compare()}>
        {busy ? "在对比…" : "对比"}
      </Button>
      {a && b ? (
        <div className="grid grid-cols-2 gap-2">
          <SideCard title="A 当前" side={a} open={openInner} />
          <SideCard title="B" side={b} open={openInner} />
        </div>
      ) : null}
      {a && b ? (
        <button type="button" className="text-left text-sm text-muted" onClick={() => setOpenInner((v) => !v)}>
          {openInner ? "收起心思" : "展开心思"}
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
          {side.innerJson ? side.innerJson : "重放只比较说出来的话。心思在这句之后另写，这里不生成。"}
        </pre>
      ) : null}
    </div>
  );
}
