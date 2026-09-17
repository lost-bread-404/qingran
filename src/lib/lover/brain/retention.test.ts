import assert from "node:assert/strict";
import { test } from "node:test";
import { setClock } from "./clock.ts";
import { SESSION_GAP_MS } from "./config.ts";
import { openIsolatedSql } from "./eval-db.ts";
import { runRetention } from "./retention.ts";
import { appendBrainLog } from "./store.ts";
import { insertBrainTurn, appendMindHistory } from "./observability.ts";
import { recordSpend, resetSpendSnap } from "./spend/ledger.ts";
import { rememberBlock } from "./log-refs.ts";
import { patchMeta } from "./store.ts";

const TZ = "America/New_York";

test("retention trims high-freq text, rolls spend monthly, keeps last mind per session", async () => {
  const iso = await openIsolatedSql();
  resetSpendSnap();
  const nowMs = Date.UTC(2026, 8, 17, 16, 0, 0);
  try {
    setClock(() => nowMs);
    await patchMeta({ timeZone: TZ });

    // Recent high-freq row with copied inputs — one-shot legacy strip (not age-based).
    await appendBrainLog({
      step: "voice:x",
      ok: true,
      route: "voice",
      inputSystem: "SYSTEM",
      inputUser: "USER",
      outputText: "out",
    });

    // Old low-freq row — QR_LOG_TEXT_DAYS text trim.
    const duskId = await appendBrainLog({
      step: "dusk:x",
      ok: true,
      route: "dusk",
      inputSystem: "DUSK-SYS",
      inputUser: "DUSK-USER",
      outputText: "x".repeat(400),
    });
    const old = nowMs - 10 * 86_400_000;
    await iso.sql.query(`update brain_log set at = $1 where id = $2`, [old, duskId]);

    await insertBrainTurn({
      turnSeq: 1,
      userMsgId: "u1",
      localDay: "2026-09-07",
      sessionId: "s1",
    });
    await iso.sql.query(`update brain_turns set tail = 'TAIL', created_at = $1 where turn_seq = 1`, [old]);

    await appendMindHistory(1, { intent: "a" });
    await appendMindHistory(2, { intent: "b" });
    await iso.sql.query(`update qr_mind_history set created_at = $1`, [nowMs - 40 * 86_400_000]);
    await iso.sql.query(`update qr_mind_history set turn_seq = 11 where turn_seq = 1`);
    await iso.sql.query(`update qr_mind_history set turn_seq = 12 where turn_seq = 2`);
    await insertBrainTurn({
      turnSeq: 11,
      userMsgId: "u11",
      localDay: "2026-08-01",
      sessionId: "old-s",
    });
    await insertBrainTurn({
      turnSeq: 12,
      userMsgId: "u12",
      localDay: "2026-08-01",
      sessionId: "old-s",
    });
    await iso.sql.query(
      `update brain_turns set created_at = $1 where turn_seq in (11,12)`,
      [nowMs - 40 * 86_400_000],
    );

    setClock(() => nowMs - 100 * 86_400_000);
    await recordSpend({ kind: "llm", route: "dusk", usd: 0.5, model: "m", tokensIn: 10, tokensOut: 2 });
    setClock(() => nowMs);
    await rememberBlock("voice_longterm", "old-block");
    await iso.sql.query(`update qr_block_snapshots set last_seen = $1`, [nowMs - 100 * 86_400_000]);

    const r = await runRetention(nowMs);
    assert.ok(r.legacyHighFreq >= 1, `legacyHighFreq=${r.legacyHighFreq}`);
    assert.ok(r.tails >= 1, `tails=${r.tails}`);
    assert.ok(r.logText >= 1, `logText=${r.logText}`);
    const voice = await iso.sql.query<{ input_system: string | null; trimmed: boolean }>(
      `select input_system, trimmed from brain_log where route = 'voice'`,
    );
    assert.equal(voice[0]?.input_system, null);
    assert.equal(voice[0]?.trimmed, true);
    const dusk = await iso.sql.query<{ input_system: string | null; output_text: string | null; trimmed: boolean }>(
      `select input_system, output_text, trimmed from brain_log where route = 'dusk'`,
    );
    assert.equal(dusk[0]?.input_system, null);
    assert.equal(dusk[0]?.output_text, null);
    assert.equal(dusk[0]?.trimmed, true);
    const tails = await iso.sql.query<{ tail: string | null }>(`select tail from brain_turns where turn_seq = 1`);
    assert.equal(tails[0]?.tail, null);

    const minds = await iso.sql.query<{ turn_seq: number }>(
      `select turn_seq from qr_mind_history where turn_seq in (11,12) order by turn_seq`,
    );
    assert.deepEqual(minds.map((m) => Number(m.turn_seq)), [12]);

    const monthly = await iso.sql.query<{ usd: number }>(`select usd from spend_monthly where route = 'dusk'`);
    assert.ok(monthly.length >= 1);
    const events = await iso.sql.query<{ n: number }>(
      `select count(*)::int as n from spend_events where route = 'dusk'`,
    );
    assert.equal(Number(events[0]?.n), 0);

    const snaps = await iso.sql.query<{ n: number }>(`select count(*)::int as n from qr_block_snapshots`);
    assert.equal(Number(snaps[0]?.n), 0);
    void SESSION_GAP_MS;
  } finally {
    setClock(null);
    await iso.close();
  }
});
