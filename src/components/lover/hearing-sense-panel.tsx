import { useState } from "react";
import { Button } from "@/components/ui/button";
import { previewHearingTone } from "@/lib/lover/hearing/store";
import {
  applyNoiseGear,
  applyRecordGear,
  DEFAULT_HEARING_SENSE,
  formatSenseLine,
  NOISE_PRESETS,
  RECORD_PRESETS,
  TONE_DEFAULTS,
  withNoiseFine,
  withRecordFine,
  type HearingSense,
  type SenseGear,
} from "@/lib/lover/hearing/sense";

const GEARS: Array<Exclude<SenseGear, "custom">> = ["low", "mid", "high"];
const GEAR_NAME: Record<Exclude<SenseGear, "custom">, string> = { low: "低", mid: "中", high: "高" };

function gearName(gear: SenseGear): string {
  return gear === "custom" ? "自定义" : GEAR_NAME[gear];
}

function GearSlider({
  label,
  gear,
  hint,
  onPick,
}: {
  label: string;
  gear: SenseGear;
  hint: string;
  onPick: (gear: Exclude<SenseGear, "custom">) => void;
}) {
  const value = gear === "low" ? 0 : gear === "high" ? 2 : 1;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm">{label}</p>
        <p className="text-sm">{gearName(gear)}</p>
      </div>
      <p className="mt-1 text-xs text-subtle">
        现在 {gearName(gear)} · 默认 中。{hint}
      </p>
      <input
        type="range"
        className="mt-1 h-11 w-full accent-accent"
        min={0}
        max={2}
        step={1}
        value={value}
        aria-label={label}
        onChange={(e) => {
          const next = GEARS[Number(e.target.value)];
          if (next) onPick(next);
        }}
      />
      <div className="grid grid-cols-3 gap-2">
        {GEARS.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={gear === id}
            onClick={() => onPick(id)}
            className={
              "min-h-11 rounded-md px-3 text-sm " + (gear === id ? "bg-accent text-accent-fg" : "bg-bg text-muted")
            }
          >
            {GEAR_NAME[id]}
          </button>
        ))}
      </div>
    </div>
  );
}

function Fine({
  label,
  value,
  def,
  min,
  max,
  step,
  hint,
  digits = 2,
  onChange,
}: {
  label: string;
  value: number;
  def: number;
  min: number;
  max: number;
  step: number;
  hint: string;
  digits?: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-3 text-sm">
        <span>{label}</span>
        <span className="tabular-nums">{value.toFixed(digits)}</span>
      </span>
      <span className="mt-1 block text-xs text-subtle">
        现在 {value.toFixed(digits)} · 默认 {def.toFixed(digits)} · {min.toFixed(digits)}–{max.toFixed(digits)}。{hint}
      </span>
      <input
        type="range"
        className="mt-1 h-11 w-full accent-accent"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function HearingSensePanel({
  sense,
  labPassword,
  onChange,
}: {
  sense: HearingSense;
  labPassword: string;
  onChange: (next: HearingSense) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const record = RECORD_PRESETS.mid;
  const noise = NOISE_PRESETS.mid;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-lg font-medium tracking-tight">听力灵敏度</p>
          <p className="mt-1 text-xs text-subtle">
            上面是档位，展开的是这一档实际用的数。改任何一个数，这一档就变成自定义，下一句就生效。
          </p>
          <p className="mt-1 text-xs text-subtle">{formatSenseLine(sense)}</p>
        </div>
        <button
          type="button"
          className="shrink-0 text-xs text-muted underline-offset-4 hover:underline"
          onClick={() => onChange(DEFAULT_HEARING_SENSE)}
        >
          恢复默认
        </button>
      </div>

      <section className="flex flex-col gap-3">
        <GearSlider
          label="录音灵敏度"
          gear={sense.recordGear}
          hint="调高，更轻的声音也会开始录，噪音也更容易被录进来。真正发不发给她，由下面的噪音过滤决定。细项一改，这里就变成自定义；再点低、中、高会盖掉细项。"
          onPick={(gear) => onChange(applyRecordGear(sense, gear))}
        />
        <Fine
          label="起始绝对门槛"
          value={sense.startMin}
          def={record.startMin}
          min={0.001}
          max={0.05}
          step={0.0005}
          digits={4}
          hint="音量至少要到这个值才算开口。调低，更轻的声音也能开始录。"
          onChange={(startMin) => onChange(withRecordFine(sense, { startMin }))}
        />
        <Fine
          label="起始倍数"
          value={sense.startMult}
          def={record.startMult}
          min={1}
          max={3}
          step={0.01}
          hint="开口音量要达到环境底噪的多少倍。调低，安静房间里的轻声更容易开口。"
          onChange={(startMult) => onChange(withRecordFine(sense, { startMult }))}
        />
        <Fine
          label="保持绝对门槛"
          value={sense.holdMin}
          def={record.holdMin}
          min={0.001}
          max={0.05}
          step={0.0005}
          digits={4}
          hint="已经在说时，低于这个就当成停了一下。调低，轻声中间不容易被切断。"
          onChange={(holdMin) => onChange(withRecordFine(sense, { holdMin }))}
        />
        <Fine
          label="保持倍数"
          value={sense.holdMult}
          def={record.holdMult}
          min={1}
          max={3}
          step={0.01}
          hint="保持音量要超过底噪的多少倍。调低，呢喃会一直被录着。"
          onChange={(holdMult) => onChange(withRecordFine(sense, { holdMult }))}
        />
        <Fine
          label="轻声开口门槛"
          value={sense.cueMin}
          def={record.cueMin}
          min={0.001}
          max={0.05}
          step={0.0005}
          digits={4}
          hint="比起始更轻时，要同时够清晰或够亮才开录。调低，气声和撒娇更容易被录上。"
          onChange={(cueMin) => onChange(withRecordFine(sense, { cueMin }))}
        />
        <Fine
          label="轻声开口倍数"
          value={sense.cueMult}
          def={record.cueMult}
          min={1}
          max={3}
          step={0.01}
          hint="轻声开口要超过底噪的多少倍。调低，安静里的轻声更容易开录。"
          onChange={(cueMult) => onChange(withRecordFine(sense, { cueMult }))}
        />
        <Fine
          label="清晰度门槛"
          value={sense.clarityCut}
          def={record.clarityCut}
          min={0.05}
          max={0.9}
          step={0.01}
          hint="走轻声开口时，清晰度至少要到这个。调低，含糊的声音也能开录。"
          onChange={(clarityCut) => onChange(withRecordFine(sense, { clarityCut }))}
        />
        <Fine
          label="明亮度门槛"
          value={sense.brightCut}
          def={record.brightCut}
          min={0.02}
          max={0.8}
          step={0.01}
          hint="走轻声开口时，明亮度到这个也算开口。调低，闷一点的声音也能开录。"
          onChange={(brightCut) => onChange(withRecordFine(sense, { brightCut }))}
        />
        <Fine
          label="最短有声"
          value={sense.minVoicedMs}
          def={record.minVoicedMs}
          min={0}
          max={800}
          step={10}
          digits={0}
          hint="连续有声多少毫秒才真正开录。0 是一有声就录。调高，短促的碰麦不会开录。"
          onChange={(minVoicedMs) => onChange(withRecordFine(sense, { minVoicedMs }))}
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm">说完等待</p>
          <p className="text-sm tabular-nums">{(sense.endWaitMs / 1000).toFixed(1)} 秒</p>
        </div>
        <p className="text-xs text-subtle">
          现在 {(sense.endWaitMs / 1000).toFixed(1)} 秒 · 默认 1.5 秒 · 0.8–3。停多久算一句话说完。调短，她接话更快，也更容易把一句切成两句。
        </p>
        <input
          type="range"
          className="h-11 w-full accent-accent"
          min={0.8}
          max={3}
          step={0.1}
          value={sense.endWaitMs / 1000}
          aria-label="说完等待"
          onChange={(e) => onChange({ ...sense, endWaitMs: Math.round(Number(e.target.value) * 1000) })}
        />
      </section>

      <section className="flex flex-col gap-3">
        <GearSlider
          label="噪音过滤"
          gear={sense.noiseGear}
          hint="调高更严格，只有检测到人声基频才发给她。调低更宽松。不再看音量，也不再因为 Apple 没出字就丢掉。白天夜里同一套。"
          onPick={(gear) => onChange(applyNoiseGear(sense, gear))}
        />
        <Fine
          label="人声占比"
          value={sense.voicedMin}
          def={noise.voicedMin}
          min={0}
          max={1}
          step={0.05}
          hint="稳定基频落在人声范围里的帧，占比低于这个就当噪音，只存录音不回复。调高，更严格。"
          onChange={(voicedMin) => onChange(withNoiseFine(sense, { voicedMin }))}
        />
        <Fine
          label="最短人声"
          value={sense.noiseMinMs}
          def={noise.noiseMinMs}
          min={0}
          max={2000}
          step={50}
          digits={0}
          hint="短于这个毫秒数就当噪音。调高，很短的一声会被丢掉。"
          onChange={(noiseMinMs) => onChange(withNoiseFine(sense, { noiseMinMs }))}
        />
      </section>

      <section className="flex flex-col gap-3">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            className="mt-1"
            checked={sense.toneOn}
            onChange={(e) => onChange({ ...sense, toneOn: e.target.checked })}
          />
          <span>
            <span className="block text-sm">自动加语气符号</span>
            <span className="block text-xs text-subtle">默认关。打开后才按下面的门槛加 ？ ～ … ！。关掉就一个符号都不加。</span>
          </span>
        </label>
        <Fine
          label="平缓区"
          value={sense.flatZone}
          def={TONE_DEFAULTS.flatZone}
          min={0}
          max={0.5}
          step={0.01}
          hint="音高从开头到结尾的变化在正负这个比例以内，就什么都不加，也不再判断其它符号。调高，更多句子保持平的。"
          onChange={(flatZone) => onChange({ ...sense, flatZone })}
        />
        <Fine
          label="问号上扬"
          value={sense.riseQuestion}
          def={TONE_DEFAULTS.riseQuestion}
          min={1}
          max={2}
          step={0.01}
          hint="结尾音高是开头的多少倍才加问号。调高，问号更少。"
          onChange={(riseQuestion) => onChange({ ...sense, riseQuestion })}
        />
        <Fine
          label="波浪滑动"
          value={sense.glideRatio}
          def={TONE_DEFAULTS.glideRatio}
          min={0}
          max={0.3}
          step={0.005}
          digits={3}
          hint="音高滑动幅度要到这个，并且够长，才加波浪号。调高，波浪号更少。"
          onChange={(glideRatio) => onChange({ ...sense, glideRatio })}
        />
        <Fine
          label="波浪最短时长"
          value={sense.waveMinSec}
          def={TONE_DEFAULTS.waveMinSec}
          min={0.1}
          max={1.5}
          step={0.01}
          hint="秒。和上面的滑动幅度两个都满足才加波浪号。调高，短的拐音不会加。"
          onChange={(waveMinSec) => onChange({ ...sense, waveMinSec })}
        />
        <Fine
          label="省略衰减"
          value={sense.fadeRatio}
          def={TONE_DEFAULTS.fadeRatio}
          min={0.3}
          max={1}
          step={0.01}
          hint="结尾音量降到开头的这个比例以下才加省略号。调低，省略号更少。"
          onChange={(fadeRatio) => onChange({ ...sense, fadeRatio })}
        />
        <Fine
          label="感叹峰值"
          value={sense.bangPeak}
          def={TONE_DEFAULTS.bangPeak}
          min={0.01}
          max={0.4}
          step={0.01}
          hint="音量峰值要到这个，并且够短，才加感叹号。调高，感叹号更少。"
          onChange={(bangPeak) => onChange({ ...sense, bangPeak })}
        />
        <Fine
          label="感叹最长时长"
          value={sense.bangDur}
          def={TONE_DEFAULTS.bangDur}
          min={0.05}
          max={1}
          step={0.01}
          hint="秒。超过这个时长就不加感叹号。调短，只有很冲的一声才会加。"
          onChange={(bangDur) => onChange({ ...sense, bangDur })}
        />
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={previewBusy || !labPassword.trim()}
          onClick={() => {
            setPreviewBusy(true);
            setPreview(null);
            void previewHearingTone({ data: { password: labPassword.trim(), sense } })
              .then((result) => {
                if (!result.ok) {
                  setPreview(result.error === "lab-locked" ? "密码不对。" : result.error);
                  return;
                }
                const pct = (n: number) => `${Math.round(n * 100)}%`;
                setPreview(
                  result.n
                    ? `最近 ${result.n} 条 · 加了符号 ${pct(result.markedRate)} · 和标注一致 ${pct(result.agreeRate)}`
                    : "还没有带韵律的标注，没法试。",
                );
              })
              .catch((err) => setPreview(err instanceof Error ? err.message : String(err)))
              .finally(() => setPreviewBusy(false));
          }}
        >
          {previewBusy ? "正在用已有录音试…" : "用已有录音试一次"}
        </Button>
        <p className="text-xs text-subtle">取最近 50 条已标注录音，只用存下来的韵律在本地重算，不调用接口。需要这一页下面的 lab 密码。</p>
        {preview ? <p className="text-xs text-fg">{preview}</p> : null}
      </section>
    </div>
  );
}
