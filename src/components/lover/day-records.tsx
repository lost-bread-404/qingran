import { useEffect, useState } from "react";
import { brainGetDays } from "@/lib/lover/brain/dossier-api";

type Day = { day: string; lines: string[] };

/** Read-only: what 清然 noted about each of your days. */
export function DayRecords() {
  const [days, setDays] = useState<Day[] | null>(null);
  useEffect(() => {
    void brainGetDays()
      .then((rows) => setDays(rows as Day[]))
      .catch(() => setDays([]));
  }, []);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">每天</p>
      <p className="text-xs text-subtle">每一天你的时间线：白天他在你沉默时记，凌晨整理时定稿。月报从这里算学习、休息、情绪和睡眠。</p>
      {days == null ? (
        <p className="text-sm text-subtle">正在读…</p>
      ) : days.length === 0 ? (
        <p className="text-sm text-subtle">还没有记录。</p>
      ) : (
        days.map((d) => (
          <div key={d.day} className="rounded-md bg-surface-2 px-3 py-2">
            <p className="text-sm">{d.day}</p>
            {d.lines.map((line, i) => (
              <p key={i} className="text-xs leading-relaxed text-muted">
                {line}
              </p>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
