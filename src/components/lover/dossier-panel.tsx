import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  brainEditDossierNow,
  brainEnableDossier,
  brainGetDossier,
  brainRollbackDossier,
  brainSaveDossier,
  brainSeedDossier,
} from "@/lib/lover/brain/dossier-api";
import type { DossierRow, DossierVersion } from "@/lib/lover/brain/dossier";
import { clampDossierMaxChars } from "@/lib/lover/types";
import { DEFAULT_DOSSIER } from "@/lib/lover/brain/dossier-text";

function fmtTime(ms: number): string {
  if (!ms) return "还没有";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const AUTHOR: Record<string, string> = {
  editor: "整理",
  rosie: "你改的",
  seed: "初版",
  compact: "压缩",
};

type Props = {
  maxChars: number;
  onMaxChars: (n: number) => void;
  footer?: ReactNode;
};

export function DossierPanel({ maxChars, onMaxChars, footer }: Props) {
  const [row, setRow] = useState<DossierRow | null>(null);
  const [versions, setVersions] = useState<DossierVersion[]>([]);
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maxDraft, setMaxDraft] = useState(String(maxChars));

  function apply(next: { row: DossierRow; versions: DossierVersion[] }) {
    setRow(next.row);
    setVersions(next.versions);
    setBody(next.row.body.trim() ? next.row.body : DEFAULT_DOSSIER);
  }

  useEffect(() => {
    let cancelled = false;
    void brainGetDossier()
      .then((res) => {
        if (cancelled) return;
        apply(res);
        const newest = res.versions[0];
        if (newest?.author === "seed" && newest.body.trim() && newest.body !== res.row.body) {
          setDraft(newest.body);
        }
      })
      .catch(() => {
        if (!cancelled) setError("没读出来。");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setMaxDraft(String(maxChars));
  }, [maxChars]);

  async function save() {
    setBusy("save");
    setError(null);
    try {
      const res = await brainSaveDossier({ data: { body } });
      const versions = await brainGetDossier();
      apply({ row: res.row, versions: versions.versions });
    } catch (err) {
      setError(err instanceof Error ? err.message : "没记下。");
    } finally {
      setBusy(null);
    }
  }

  async function seed() {
    setBusy("seed");
    setError(null);
    try {
      const res = await brainSeedDossier();
      setDraft(res.draft.body);
      const loaded = await brainGetDossier();
      apply(loaded);
      setDraft(res.draft.body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "没生成。");
    } finally {
      setBusy(null);
    }
  }

  async function enable(text: string) {
    setBusy("enable");
    setError(null);
    try {
      const res = await brainEnableDossier({ data: { body: text } });
      const loaded = await brainGetDossier();
      apply({ row: res.row, versions: loaded.versions });
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "没启用。");
    } finally {
      setBusy(null);
    }
  }

  async function editNow() {
    setBusy("edit");
    setError(null);
    try {
      const res = await brainEditDossierNow();
      apply(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "这次没整理完。");
    } finally {
      setBusy(null);
    }
  }

  async function rollback(id: number) {
    setBusy(`roll-${id}`);
    setError(null);
    try {
      const res = await brainRollbackDossier({ data: { id } });
      const loaded = await brainGetDossier();
      apply({ row: res.row, versions: loaded.versions });
    } catch (err) {
      setError(err instanceof Error ? err.message : "没退回去。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] [touch-action:pan-y]">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <p className="text-xs text-subtle">
          {row?.active
            ? "说话时她眼前就是这一份。启用之前还是旧的「我自己 / 我们 / 画像」。"
            : "还没启用。说话和内心仍用旧的「我自己 / 我们 / 画像」。审过初版再启用。"}
        </p>
        <p className="text-xs text-subtle">
          版本 {row?.version ?? 0}
          {" · "}
          上次整理 {fmtTime(row?.updatedAt ?? 0)}
          {" · "}
          距上次整理 {row?.turnsSinceEdit ?? 0} 轮
          {row?.active ? " · 已启用" : " · 未启用"}
        </p>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="min-h-72 resize-none font-mono text-sm leading-relaxed"
          aria-label="我记得的"
        />
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={busy != null} onClick={() => void save()}>
            {busy === "save" ? "正在记下…" : "保存"}
          </Button>
          <Button type="button" variant="outline" disabled={busy != null} onClick={() => void editNow()}>
            {busy === "edit" ? "正在整理…" : "现在整理"}
          </Button>
          <Button type="button" variant="outline" disabled={busy != null} onClick={() => void seed()}>
            {busy === "seed" ? "正在生成…" : "从旧记忆生成初版"}
          </Button>
        </div>
        {draft != null ? (
          <div className="flex flex-col gap-2 rounded-md bg-surface-2 px-3 py-3">
            <p className="text-sm">初版草稿</p>
            <p className="text-xs text-subtle">还没写进正在用的文档。改完再启用。</p>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-64 resize-none font-mono text-sm leading-relaxed"
              aria-label="初版草稿"
            />
            <Button type="button" disabled={busy != null || !draft.trim()} onClick={() => void enable(draft)}>
              {busy === "enable" ? "正在启用…" : "启用"}
            </Button>
          </div>
        ) : !row?.active ? (
          <Button type="button" variant="outline" disabled={busy != null || !body.trim()} onClick={() => void enable(body)}>
            {busy === "enable" ? "正在启用…" : "启用这一份"}
          </Button>
        ) : null}
        <label className="flex flex-col gap-2">
          <span className="text-xs text-subtle">字数上限（2000–8000）</span>
          <Input
            type="number"
            min={2000}
            max={8000}
            value={maxDraft}
            onChange={(e) => setMaxDraft(e.target.value)}
            onBlur={() => {
              const n = clampDossierMaxChars(maxDraft, maxChars);
              setMaxDraft(String(n));
              if (n !== maxChars) onMaxChars(n);
            }}
          />
        </label>
        <div className="flex flex-col gap-2">
          <p className="text-sm">版本历史</p>
          {versions.length === 0 ? (
            <p className="text-sm text-subtle">还没有版本。</p>
          ) : (
            versions.map((version) => (
              <div key={version.id} className="rounded-md bg-surface-2 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="min-h-11 text-left text-sm"
                    onClick={() => setOpenId((cur) => (cur === version.id ? null : version.id))}
                  >
                    v{version.version} · {AUTHOR[version.author] ?? version.author} · {fmtTime(version.createdAt)}
                  </button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy != null}
                    onClick={() => void rollback(version.id)}
                  >
                    {busy === `roll-${version.id}` ? "…" : "回滚"}
                  </Button>
                </div>
                {openId === version.id ? (
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">
                    {version.body}
                    {version.ops != null ? `\n\nops\n${JSON.stringify(version.ops, null, 2)}` : ""}
                  </pre>
                ) : null}
              </div>
            ))
          )}
        </div>
        {error ? <p className="text-sm text-live">{error}</p> : null}
        {footer}
      </div>
    </div>
  );
}
