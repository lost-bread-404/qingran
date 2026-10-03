import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { VOICE_IO } from "./brain/config";
import { readOne } from "./speak";
import { xaiFetch } from "./xai-auth";

/**
 * 设置 → 声音和听力 → 试听声线: every voice xAI offers, each reading the same Chinese line once. The recording is
 * kept (`qr_voice_samples`), so listening again costs nothing; a new line or a new voice is recorded on first play.
 */
export const SAMPLE_LINE =
  "你回来啦？今天是不是又没好好吃饭。过来，让我看看你。……哼，下次再这样，我可真的要生气了。";

/** xAI's own words for each built-in voice, in Chinese. A voice xAI lists that is not here just shows its name. */
const NOTES: Record<string, string> = {
  eve: "有活力、开朗（英式口音）",
  ara: "温暖、亲切",
  leo: "有威严、有力（英式口音）",
  rex: "自信、清楚",
  sal: "顺滑、平衡",
  carina: "柔和、共情、安抚人",
  zagan: "有力量、戏剧化",
  helix: "大胆、有冲劲",
  orion: "浑厚、有电影感",
  luna: "温柔、耐心、会照顾人",
  iris: "友好、明快、有魅力",
  altair: "优雅、讲究",
  zenith: "利落、专注",
  perseus: "坚定、自信、可靠",
  helios: "开朗、有精神",
  lux: "沉稳、平静、带点智慧",
  kepler: "有想法、有魅力",
  rigel: "精准、专业、冷静（澳洲口音）",
  cosmo: "明亮、好奇",
  celeste: "体贴、自信、让人安心",
  ursa: "友好、温暖、踏实",
  sirius: "机灵、俏皮",
  lumen: "温暖、口齿清楚",
  castor: "有魅力、接地气、随和",
  naksh: "温暖、有思想（印度口音）",
  atlas: "自信、有掌控感",
  aurora: "安静、稳定",
  liora: "冷静、踏实",
};

export type VoiceChoice = { id: string; name: string; note: string; recorded: boolean };

/** What xAI says it has now (custom voices included); the built-in list when it cannot be asked. */
async function xaiVoices(): Promise<Array<{ id: string; name: string }>> {
  try {
    const sent = await xaiFetch(`${VOICE_IO.ttsUrl}/voices`, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
    if (sent?.res.ok) {
      const body = (await sent.res.json()) as {
        voices?: Array<{ voice_id?: string; name?: string; language?: string }>;
      };
      const listed = (body.voices ?? [])
        .map((v) => ({
          id: String(v.voice_id ?? "").toLowerCase(),
          name: [v.name, v.language].filter(Boolean).join(" · "),
        }))
        .filter((v) => v.id);
      if (listed.length) return listed;
    }
  } catch {
    /* fall back to the known list */
  }
  return Object.keys(NOTES).map((id) => ({ id, name: id }));
}

export const listVoiceChoices = createServerFn({ method: "GET" }).handler(
  async (): Promise<VoiceChoice[]> => {
    const [voices, sql] = await Promise.all([xaiVoices(), getSql()]);
    const rows = await sql<{
      voice_id: string;
    }>`select voice_id from qr_voice_samples where line = ${SAMPLE_LINE}`;
    const recorded = new Set(rows.map((r) => r.voice_id));
    return voices.map((v) => ({
      id: v.id,
      name: v.name,
      note: NOTES[v.id] ?? "",
      recorded: recorded.has(v.id),
    }));
  },
);

function wav(pcm: Buffer): Buffer {
  const rate = VOICE_IO.sampleRate;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** The recording of this voice reading the line (recorded now if it is not there yet), as a WAV in base64. */
export const voiceSample = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => ({
    id: String(input.id ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 64),
  }))
  .handler(async ({ data }): Promise<{ ok: true; wav: string } | { ok: false; error: string }> => {
    if (!/^[\w-]+$/.test(data.id)) return { ok: false, error: "声线名不对" };
    const sql = await getSql();
    const kept = await sql<{
      wav: string;
    }>`select wav from qr_voice_samples where voice_id = ${data.id} and line = ${SAMPLE_LINE}`;
    if (kept[0]) return { ok: true, wav: kept[0].wav };
    const read = await readOne({ voice: data.id, text: SAMPLE_LINE }, 1);
    if (!read.ok) return { ok: false, error: read.error };
    const audio =
      read.audio.subarray(0, 4).toString("latin1") === "RIFF" ? read.audio : wav(read.audio);
    const b64 = audio.toString("base64");
    await sql`insert into qr_voice_samples (voice_id, line, wav, made_at) values (${data.id}, ${SAMPLE_LINE}, ${b64}, ${Date.now()})
      on conflict (voice_id) do update set line = excluded.line, wav = excluded.wav, made_at = excluded.made_at`;
    return { ok: true, wav: b64 };
  });
