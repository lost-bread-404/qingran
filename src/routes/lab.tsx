import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmTurn } from "@/components/lover/confirm-turn";
import {
  assignHearingSplits,
  confirmHearingClip,
  deleteHearingClip,
  exportHearingClips,
  getHearingClipAudio,
  hearingLabDiagnostics,
  hearingLabStats,
  listHearingClips,
  saveHearingGold,
  unlockHearingLab,
  type LabClipFilter,
} from "@/lib/lover/hearing/store";
import { formatUnknownError } from "@/lib/lover/hearing/scripted";
import { EMOTIONS, type CueEmotion, type HearingCue, type HearingResult } from "@/lib/lover/hearing/schema";
import { SCRIPTED_CATEGORIES } from "@/lib/lover/hearing/config";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/lab")({ component: HearingLabPage });

type ClipRow = {
  id: string;
  createdAt: string;
  durationMs: number;
  source: string;
  category: string | null;
  split: string | null;
  xaiText: string;
  hearingText: string;
  hearing: HearingResult | null;
  liveText: string;
  goldText: string;
  goldCues: HearingCue[];
  noiseOnly: boolean;
  skip: boolean;
  hasGold: boolean;
  hasRelabel: boolean;
  goldSource: string | null;
  sttText: string;
  goldTier: number | null;
  utteranceEmotion: string | null;
  mode: string | null;
  audioRoute: string | null;
  turnId: string | null;
  disagreement: boolean;
  storageBackend: string | null;
  blobError: string | null;
};

type LabTab = "annotate" | "recent" | "coverage";

const LAB_KEY = "qingran-hearing-lab";
const FILTERS: { id: LabClipFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "confirmed", label: "已确认" },
  { id: "unconfirmed", label: "未确认" },
  { id: "disagreement", label: "disagreement" },
];

function HearingLabPage() {
  const [password, setPassword] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clips, setClips] = useState<ClipRow[]>([]);
  const [index, setIndex] = useState(0);
  const [relabel, setRelabel] = useState(false);
  const [filter, setFilter] = useState<LabClipFilter>("all");
  const [tab, setTab] = useState<LabTab>("annotate");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [goldText, setGoldText] = useState("");
  const [goldCuesText, setGoldCuesText] = useState("[]");
  const [noiseOnly, setNoiseOnly] = useState(false);
  const [skip, setSkip] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmTurnId, setConfirmTurnId] = useState<string | null>(null);
  const [diag, setDiag] = useState<{
    dbSource: string;
    migrations: string[];
    migrationsError: string | null;
    clipCount: number;
    clipCountError: string | null;
    missingMigrations: string[];
    missingColumns: string[];
    blobTokenSet: boolean;
  } | null>(null);
  const [coverage, setCoverage] = useState<{
    totalTurns: number;
    coverage: {
      confirmed: number;
      edited: number;
      labeled: number;
      confirmationRate: number;
      byCategory: Record<string, { confirmed: number; edited: number; n: number }>;
      byMode: Record<string, { confirmed: number; edited: number; n: number }>;
      thinCategories: string[];
      dbBacked: number;
    };
  } | null>(null);

  const clip = clips[index] ?? null;
  const dbBacked = clips.filter((c) => c.storageBackend === "db").length;

  async function load(nextRelabel = relabel, secret = password, nextFilter = filter) {
    try {
      const listed = await listHearingClips({
        data: { password: secret, relabel: nextRelabel, filter: nextFilter },
      });
      setClips(listed.clips as ClipRow[]);
      setIndex(0);
      const stats = await hearingLabStats({ data: { password: secret } });
      setCoverage({ totalTurns: stats.totalTurns, coverage: stats.coverage });
      const nextDiag = await hearingLabDiagnostics({ data: { password: secret } });
      setDiag(nextDiag);
      setError(null);
    } catch (err) {
      setError(formatUnknownError(err));
    }
  }

  async function unlock() {
    setError(null);
    try {
      const result = await unlockHearingLab({ data: { password } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      sessionStorage.setItem(LAB_KEY, password);
      setUnlocked(true);
      await load(relabel, password);
    } catch (err) {
      setError(formatUnknownError(err));
    }
  }

  useEffect(() => {
    const saved = sessionStorage.getItem(LAB_KEY);
    if (!saved) return;
    setPassword(saved);
    void unlockHearingLab({ data: { password: saved } })
      .then((result) => {
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setUnlocked(true);
        void load(false, saved);
      })
      .catch((err) => setError(formatUnknownError(err)));
  }, []);

  useEffect(() => {
    if (!clip || !unlocked) {
      setGoldText("");
      setGoldCuesText("[]");
      setNoiseOnly(false);
      setSkip(false);
      setAudioUrl(null);
      return;
    }
    setGoldText(clip.goldText);
    setGoldCuesText(JSON.stringify(clip.goldCues, null, 2));
    setNoiseOnly(clip.noiseOnly);
    setSkip(clip.skip);
    let revoked = false;
    let url: string | null = null;
    void getHearingClipAudio({ data: { password, id: clip.id } }).then((result) => {
      if (!result.ok || revoked) return;
      const bytes = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      setAudioUrl(url);
    });
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [clip?.id, unlocked, password]);

  const hearingPreview = useMemo(() => {
    if (!clip?.hearing || typeof clip.hearing !== "object") return "";
    try {
      return JSON.stringify(clip.hearing, null, 2);
    } catch {
      return "";
    }
  }, [clip]);

  if (!unlocked) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
        <p className="font-display text-2xl">听力标注</p>
        <p className="max-w-sm text-center text-sm text-muted">设置里的标注页，需要密码。</p>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="密码"
          className="max-w-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter") void unlock();
          }}
        />
        {error ? <p className="text-sm text-live">{error}</p> : null}
        <Button onClick={() => void unlock()}>打开</Button>
        <Link to="/" className="text-sm text-subtle">
          回通话
        </Link>
      </div>
    );
  }

  const confirmClip = clips.find((c) => c.turnId === confirmTurnId) ?? null;

  return (
    <div className="flex h-full flex-col bg-bg">
      <header className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <Link to="/" className="text-sm text-muted">
          返回
        </Link>
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg">标注</p>
          <p className="text-xs text-subtle">
            {clips.length} 段 · {index + 1}/{Math.max(clips.length, 1)}
            {relabel ? " · 重标" : ""}
          </p>
        </div>
        <Button
          type="button"
          variant={relabel ? "default" : "outline"}
          size="sm"
          onClick={() => {
            const next = !relabel;
            setRelabel(next);
            void load(next);
          }}
        >
          重标
        </Button>
      </header>

      {error ? (
        <div className="mx-4 mb-2 rounded-md bg-live/15 px-3 py-2 text-sm text-live">{error}</div>
      ) : null}

      {diag ? (
        <div className="mx-4 mb-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-subtle">
          <p>
            db={diag.dbSource} · clips={diag.clipCount}
            {diag.clipCountError ? ` · count错误 ${diag.clipCountError}` : ""} · blob=
            {diag.blobTokenSet ? "on" : "off"}
          </p>
          <p className="mt-1">_migrations: {diag.migrations.join(", ") || "（无）"}</p>
          {diag.migrationsError ? <p className="mt-1 text-live">{diag.migrationsError}</p> : null}
          {diag.missingMigrations.length ? (
            <p className="mt-1 text-live">缺 migration：{diag.missingMigrations.join(", ")}</p>
          ) : null}
          {diag.missingColumns.length ? (
            <p className="mt-1 text-live">缺列：{diag.missingColumns.join(", ")}</p>
          ) : null}
        </div>
      ) : null}

      {dbBacked > 0 || coverage?.coverage.dbBacked ? (
        <div className="mx-4 mb-2 rounded-md bg-surface-2 px-3 py-2 text-sm text-live">
          有 {coverage?.coverage.dbBacked ?? dbBacked} 段录音落在数据库里，Blob 写入可能失败了。
        </div>
      ) : null}

      <div className="flex shrink-0 gap-1 px-4 pb-2">
        {(
          [
            ["annotate", "标注"],
            ["recent", "最近 turn"],
            ["coverage", "覆盖率"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "flex-1 min-h-11 rounded-md py-2 text-sm",
              tab === id ? "bg-accent text-accent-fg" : "bg-surface-2 text-muted",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex shrink-0 gap-2 overflow-x-auto px-4 pb-3">
        {FILTERS.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant={filter === item.id ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setFilter(item.id);
              void load(relabel, password, item.id);
            }}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {tab === "coverage" ? (
        <CoveragePanel coverage={coverage} />
      ) : tab === "recent" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          {clips.length === 0 ? (
            <p className="text-sm text-subtle">还没有 turn。</p>
          ) : (
            <ul className="mx-auto flex w-full max-w-xl flex-col gap-3">
              {clips.map((row) => (
                <li key={row.id} className="rounded-md bg-surface-2 px-3 py-3">
                  <p className="text-xs text-subtle">
                    {row.createdAt} · {row.mode || "?"} · {row.audioRoute || "?"}
                    {row.disagreement ? " · disagreement" : ""}
                    {row.goldSource ? ` · ${row.goldSource}` : " · 未确认"}
                  </p>
                  <p className="mt-1 text-sm">{row.sttText || row.hearingText || row.xaiText || "（空）"}</p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!row.turnId}
                      onClick={() => setConfirmTurnId(row.turnId)}
                    >
                      {row.goldSource ? "再确认" : "确认 / 编辑"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setTab("annotate");
                        setIndex(clips.findIndex((c) => c.id === row.id));
                      }}
                    >
                      去标注 cues
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <div className="flex shrink-0 gap-2 overflow-x-auto px-4 pb-3">
            <Button type="button" variant="outline" size="sm" disabled={!clip} onClick={() => setIndex((i) => Math.max(0, i - 1))}>
              上一段
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!clip}
              onClick={() => setIndex((i) => Math.min(clips.length - 1, i + 1))}
            >
              下一段
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                const result = await assignHearingSplits({ data: { password } });
                setStatus(`已按类别分层分好 ${result.assigned} 段（70/30）。`);
                await load();
              }}
            >
              分配 dev/test
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                const exported = await exportHearingClips({ data: { password } });
                const blob = new Blob([`${JSON.stringify(exported)}\n`], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = `qingran-hearing-${new Date().toISOString().slice(0, 10)}.json`;
                link.click();
                URL.revokeObjectURL(url);
                setStatus("已导出 JSON。");
              }}
            >
              导出 JSON
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            {!clip ? (
              <p className="text-sm text-subtle">还没有录音。打开设置里的调试模式后再通话。</p>
            ) : (
              <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
                <div className="rounded-md bg-surface-2 px-3 py-2 text-sm">
                  <p>
                    {clip.source} · {clip.category || "未分类"} · {clip.split || "未分"} · {clip.durationMs}ms
                    {clip.disagreement ? " · disagreement" : ""}
                    {clip.goldSource ? ` · ${clip.goldSource}` : " · 未确认"}
                    {clip.goldTier ? ` · tier ${clip.goldTier}` : ""}
                    {clip.mode ? ` · ${clip.mode}` : ""}
                    {clip.audioRoute ? ` · ${clip.audioRoute}` : ""}
                    {clip.storageBackend ? ` · ${clip.storageBackend}` : ""}
                  </p>
                  {clip.blobError ? <p className="mt-1 text-xs text-live">{clip.blobError}</p> : null}
                  {audioUrl ? (
                    <audio className="mt-2 w-full" controls src={audioUrl} />
                  ) : (
                    <p className="mt-2 text-xs text-subtle">正在取录音…</p>
                  )}
                </div>
                <Field label="STT 原文" value={clip.sttText} />
                <Field label="xAI STT" value={clip.xaiText} />
                <Field label="Hearing" value={clip.hearingText} />
                <Field label="Web Speech" value={clip.liveText} />
                {hearingPreview ? (
                  <pre className="max-h-40 overflow-auto rounded-md bg-surface-2 p-3 text-xs text-muted">
                    {hearingPreview}
                  </pre>
                ) : null}
                <label className="flex flex-col gap-1 text-sm">
                  gold_text
                  <Textarea value={goldText} onChange={(e) => setGoldText(e.target.value)} className="min-h-24" />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  gold_cues（JSON）
                  <Textarea
                    value={goldCuesText}
                    onChange={(e) => setGoldCuesText(e.target.value)}
                    className="min-h-32 font-mono text-xs"
                  />
                </label>
                <p className="text-xs text-subtle">emotion: {EMOTIONS.join(" / ")}</p>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input type="checkbox" checked={noiseOnly} onChange={(e) => setNoiseOnly(e.target.checked)} />
                  noise_only
                </label>
                {relabel ? null : (
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
                    skip
                  </label>
                )}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    onClick={async () => {
                      let cues: HearingCue[] = [];
                      try {
                        const parsed = JSON.parse(goldCuesText) as unknown;
                        cues = Array.isArray(parsed) ? (parsed as HearingCue[]) : [];
                      } catch {
                        setStatus("cues 不是合法 JSON。");
                        return;
                      }
                      await saveHearingGold({
                        data: {
                          password,
                          id: clip.id,
                          relabel,
                          goldText,
                          goldCues: cues,
                          noiseOnly,
                          skip,
                          utteranceEmotion: clip.utteranceEmotion as CueEmotion | null,
                        },
                      });
                      setStatus(relabel ? "重标已另存。" : "已保存标注。");
                      await load();
                    }}
                  >
                    保存
                  </Button>
                  {clip.turnId ? (
                    <Button type="button" variant="outline" onClick={() => setConfirmTurnId(clip.turnId)}>
                      确认文本
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    onClick={async () => {
                      if (!window.confirm("删掉这段录音？")) return;
                      await deleteHearingClip({ data: { password, id: clip.id } });
                      setStatus("已删除。");
                      await load();
                    }}
                  >
                    删除
                  </Button>
                </div>
                {status ? <p className="text-sm text-subtle">{status}</p> : null}
              </div>
            )}
          </div>
        </>
      )}

      <ConfirmTurn
        open={Boolean(confirmClip)}
        sttText={confirmClip?.sttText || confirmClip?.hearingText || confirmClip?.xaiText || ""}
        initialEmotion={(confirmClip?.utteranceEmotion as CueEmotion | null) ?? null}
        onClose={() => setConfirmTurnId(null)}
        onConfirm={async (gold, source, emotion) => {
          if (!confirmClip?.turnId) return;
          await confirmHearingClip({
            data: {
              turnId: confirmClip.turnId,
              goldText: gold,
              goldSource: source,
              utteranceEmotion: emotion,
            },
          });
          setConfirmTurnId(null);
          setStatus("已写入 eval set。");
          await load();
        }}
      />
    </div>
  );
}

function CoveragePanel({
  coverage,
}: {
  coverage: {
    totalTurns: number;
    coverage: {
      confirmed: number;
      edited: number;
      labeled: number;
      confirmationRate: number;
      byCategory: Record<string, { confirmed: number; edited: number; n: number }>;
      byMode: Record<string, { confirmed: number; edited: number; n: number }>;
      thinCategories: string[];
      dbBacked: number;
    };
  } | null;
}) {
  if (!coverage) {
    return <p className="px-4 text-sm text-subtle">正在统计…</p>;
  }
  const { coverage: stats, totalTurns } = coverage;
  const categories = SCRIPTED_CATEGORIES.map((c) => ({
    id: c.id,
    label: c.label,
    row: stats.byCategory[c.id] ?? { confirmed: 0, edited: 0, n: 0 },
  }));
  const extra = Object.keys(stats.byCategory).filter(
    (k) => !SCRIPTED_CATEGORIES.some((c) => c.id === k),
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
        <div className="rounded-md bg-surface-2 px-3 py-3 text-sm">
          <p>
            确认率 {(stats.confirmationRate * 100).toFixed(0)}% · 已确认 {stats.confirmed} · 已编辑 {stats.edited} ·
            总 turn {totalTurns}
          </p>
        </div>
        <div>
          <p className="mb-2 text-sm">按类别</p>
          <ul className="flex flex-col gap-2">
            {categories.map((c) => {
              const thin = c.row.n < 5;
              return (
                <li
                  key={c.id}
                  className={cn(
                    "flex items-center justify-between rounded-md px-3 py-2 text-sm",
                    thin ? "bg-live/15 text-live" : "bg-surface-2",
                  )}
                >
                  <span>
                    {c.label}
                    {thin ? " · 少于 5" : ""}
                  </span>
                  <span className="text-xs text-subtle">
                    确认 {c.row.confirmed} · 编辑 {c.row.edited}
                  </span>
                </li>
              );
            })}
            {extra.map((id) => {
              const row = stats.byCategory[id]!;
              const thin = row.n < 5;
              return (
                <li
                  key={id}
                  className={cn(
                    "flex items-center justify-between rounded-md px-3 py-2 text-sm",
                    thin ? "bg-live/15 text-live" : "bg-surface-2",
                  )}
                >
                  <span>
                    {id}
                    {thin ? " · 少于 5" : ""}
                  </span>
                  <span className="text-xs text-subtle">
                    确认 {row.confirmed} · 编辑 {row.edited}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <p className="mb-2 text-sm">按场景</p>
          <ul className="flex flex-col gap-2">
            {Object.entries(stats.byMode).map(([mode, row]) => (
              <li key={mode} className="flex items-center justify-between rounded-md bg-surface-2 px-3 py-2 text-sm">
                <span>{mode}</span>
                <span className="text-xs text-subtle">
                  确认 {row.confirmed} · 编辑 {row.edited}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-subtle">{label}</p>
      <p className={cn("text-sm", value ? "text-fg" : "text-subtle")}>{value || "（空）"}</p>
    </div>
  );
}
