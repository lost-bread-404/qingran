import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  brainExportBackup,
  brainImportChunk,
  brainImportFinish,
} from "@/lib/lover/brain/api";
import {
  BACKUP_KIND,
  convertV1,
  IMPORT_ORDER,
  type BackupCursor,
  type BackupRow,
  type ExportPage,
  type V1Backup,
} from "@/lib/lover/brain/backup";

function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function stamp(at = Date.now()) {
  const d = new Date(at);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export function BrainBackupPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<string | null>(null);

  async function exportAll() {
    setProgress("正在导出…");
    try {
      const tables: Record<string, BackupRow[]> = {};
      let cursor: BackupCursor | null = null;
      let profile = undefined;
      let exportedAt = Date.now();
      for (let i = 0; i < 400; i++) {
        const page: ExportPage = await brainExportBackup({ data: { cursor } });
        if (page.profile) profile = page.profile;
        exportedAt = page.exportedAt || exportedAt;
        if (page.table && page.rows.length) {
          tables[page.table] ??= [];
          tables[page.table]!.push(...page.rows);
        }
        setProgress(`正在导出：${page.table || "收尾"}…`);
        if (page.done || !page.next) break;
        cursor = page.next;
      }
      downloadJson(`qingran-backup-${stamp(exportedAt)}.json`, {
        kind: BACKUP_KIND,
        version: 2,
        exportedAt,
        profile,
        tables,
      });
      setProgress("导出完成。");
    } catch {
      setProgress("导出失败。");
    }
  }

  async function importFile(file: File) {
    setProgress("正在读文件…");
    try {
      const raw = JSON.parse(await file.text()) as {
        kind?: string;
        version?: number;
        profile?: unknown;
        tables?: Record<string, Record<string, unknown>[]>;
      } & V1Backup;
      if (raw.kind !== BACKUP_KIND || (raw.version !== 1 && raw.version !== 2)) {
        setProgress("不是清然的备份文件。");
        return;
      }
      const v1 = raw.version === 1;
      const tables: Record<string, BackupRow[]> = {};
      let profile = raw.profile;
      if (v1) {
        const converted = convertV1(raw);
        profile = converted.profile;
        tables.qingran_messages = converted.tables.qingran_messages;
        tables.mem_notes = converted.tables.mem_notes;
      } else {
        Object.assign(tables, raw.tables ?? {});
      }
      const importId = `imp:${Date.now()}`;
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      for (const table of IMPORT_ORDER) {
        const rows = tables[table] ?? [];
        const chunkSize = 80;
        for (let i = 0; i < rows.length; i += chunkSize) {
          const slice = rows.slice(i, i + chunkSize);
          setProgress(`正在导入 ${table}（${Math.min(i + slice.length, rows.length)}/${rows.length}）…`);
          const r = await brainImportChunk({ data: { table, rows: slice, importId } });
          inserted += r.inserted;
          updated += r.updated;
          skipped += r.skipped;
        }
      }
      await brainImportFinish({
        data: {
          importId,
          v1,
          profile: profile as never,
        },
      });
      setProgress(`导入完成。写入 ${inserted}，更新 ${updated}，跳过 ${skipped}。`);
    } catch {
      setProgress("导入失败。文件可能损坏。");
    }
  }

  return (
    <div className="rounded-md bg-surface-2 px-3 py-3">
      <p className="text-sm">完整备份</p>
      <p className="mt-1 text-xs text-subtle">包含对话、笔记和日记。分块传输，可以重复导入。</p>
      <div className="mt-3 flex gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => void exportAll()}>
          导出完整备份
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          导入备份
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void importFile(file);
          }}
        />
      </div>
      {progress ? <p className="mt-2 text-xs text-subtle">{progress}</p> : null}
    </div>
  );
}
