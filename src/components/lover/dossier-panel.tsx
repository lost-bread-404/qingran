import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  brainGetDossier,
  brainRollbackDossier,
  brainSaveDossier,
} from "@/lib/lover/brain/dossier-api";
import type { DossierRow, DossierVersion } from "@/lib/lover/brain/dossier";
import { clampDossierMaxChars, DOSSIER_MAX_CHARS_MAX, DOSSIER_MAX_CHARS_MIN } from "@/lib/lover/types";

function fmtTime(ms: number): string {
  if (!ms) return "还没有";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** What the night pass said it changed (kept with the version). */
function changesOf(ops: unknown): string {
  if (!ops || typeof ops !== "object") return "";
  const text = (ops as { changes?: unknown }).changes;
  return typeof text === "string" ? text : "";
}

const AUTHOR: Record<string, string> = {
  editor: "整理",
  night: "夜里整理",
  import: "导入",
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
  const [openId, setOpenId] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maxDraft, setMaxDraft] = useState(String(maxChars));

  function apply(next: { row: DossierRow; versions: DossierVersion[] }) {
    setRow(next.row);
    setVersions(next.versions);
    setBody(next.row.body);
  }

  useEffect(() => {
    let cancelled = false;
    void brainGetDossier()
      .then((res) => {
        if (!cancelled) apply(res);
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

  async function save(text: string) {
    if (text === (row?.body ?? "")) return;
    setBusy("save");
    setError(null);
    try {
      const res = await brainSaveDossier({ data: { body: text } });
      const versions = await brainGetDossier();
      apply({ row: res.row, versions: versions.versions });
    } catch (err) {
      setError(err instanceof Error ? err.message : "没记下。");
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
        <p className="text-sm">清然和 Rosie 现在</p>
        <p className="text-xs text-subtle">
          版本 {row?.version ?? 0}
          {" · "}
          上次整理 {fmtTime(row?.updatedAt ?? 0)}
        </p>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onBlur={() => void save(body)}
          placeholder={row ? "还在整理。" : ""}
          className="min-h-72 resize-none font-mono text-sm leading-relaxed"
          aria-label="清然和 Rosie 现在"
        />
        <label className="flex flex-col gap-2">
          <span className="text-xs text-subtle">字数上限（{DOSSIER_MAX_CHARS_MIN}–{DOSSIER_MAX_CHARS_MAX}）</span>
          <Input
            type="number"
            min={DOSSIER_MAX_CHARS_MIN}
            max={DOSSIER_MAX_CHARS_MAX}
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
                    {changesOf(version.ops) ? <span className="block text-xs text-subtle">{changesOf(version.ops)}</span> : null}
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
