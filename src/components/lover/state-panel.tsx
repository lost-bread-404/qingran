import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { brainExportState, brainImportState, brainImportStateMessages } from "@/lib/lover/brain/state-io";
import { STATE_KIND, STATE_MESSAGE_CHUNK, type StateFile, type StateMessage } from "@/lib/lover/brain/state-public";

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

/** 设置 → 数据: one file for export and import. Import = initialize (format: docs/state-format.md). */
export function StatePanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [armed, setArmed] = useState<File | null>(null);

  async function exportAll() {
    setProgress("正在导出…");
    try {
      let head: StateFile | null = null;
      const messages: StateMessage[] = [];
      let offset: number | null = 0;
      for (let i = 0; i < 200 && offset != null; i++) {
        const page: { head: string | null; messages: StateMessage[]; next: number | null } = await brainExportState({ data: { offset } });
        if (page.head) head = JSON.parse(page.head) as StateFile;
        messages.push(...page.messages);
        setProgress(`正在导出：${messages.length} 条消息…`);
        offset = page.next;
      }
      if (!head) throw new Error("no head");
      downloadJson(`qingran-state-${stamp(head.exportedAt)}.json`, { ...head, messages });
      setProgress(`导出完成：${messages.length} 条消息。`);
    } catch {
      setProgress("导出失败。");
    }
  }

  async function importFile(file: File) {
    setProgress("正在读文件…");
    try {
      const raw = JSON.parse(await file.text()) as StateFile;
      if (raw.kind !== STATE_KIND) {
        setProgress("不是清然的状态文件（kind 应该是 qingran-state）。");
        return;
      }
      const { messages = [], ...rest } = raw;
      setProgress("正在初始化…");
      const res = await brainImportState({ data: { state: rest as StateFile } });
      if (!res.ok) {
        setProgress(res.error ?? "导入失败。");
        return;
      }
      let written = 0;
      let skipped = 0;
      for (let i = 0; i < messages.length; i += STATE_MESSAGE_CHUNK) {
        const slice = messages.slice(i, i + STATE_MESSAGE_CHUNK);
        setProgress(`正在导入消息（${Math.min(i + slice.length, messages.length)}/${messages.length}）…`);
        const r = await brainImportStateMessages({ data: { messages: slice, timeZone: raw.timeZone } });
        written += r.written;
        skipped += r.skipped;
      }
      setProgress(`导入完成。换掉了：${res.done.join("、") || "（没有）"}。消息写入 ${written} 条，跳过 ${skipped} 条。刷新一下页面。`);
    } catch {
      setProgress("导入失败。文件可能不是合法的 JSON。");
    }
  }

  return (
    <div className="rounded-md bg-surface-2 px-3 py-3">
      <p className="text-sm">清然的状态</p>
      <p className="mt-1 text-xs text-subtle">
        导出和导入是同一种文件：设置、记得的、心里、打算、每天的时间线、今天的记录、指令和全部消息。导入就是初始化：文件里有的部分整块换掉，没有的部分不动；消息只会加上或按 id 更新，不会删。
      </p>
      <div className="mt-3 flex gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => void exportAll()}>
          导出
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          导入（初始化）
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) setArmed(file);
          }}
        />
      </div>
      {armed ? (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-xs text-subtle">用「{armed.name}」初始化？文件里有的部分会整块换掉。</p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                const file = armed;
                setArmed(null);
                void importFile(file);
              }}
            >
              确定导入
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setArmed(null)}>
              取消
            </Button>
          </div>
        </div>
      ) : null}
      {progress ? <p className="mt-2 text-xs text-subtle">{progress}</p> : null}
    </div>
  );
}
