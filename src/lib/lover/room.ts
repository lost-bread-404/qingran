import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import {
  applyMemoryCursor,
  lockedProfile,
  type ChatMessage,
  type Memory,
  type MessageKind,
  type Profile,
} from "./types";
import { sortConversation } from "./pair-messages";
import { parseAcousticTags, type AcousticTags } from "./hearing/tags.ts";

type Room = {
  profile: Profile;
  messages: ChatMessage[];
  memories: Memory[];
};

const EMPTY_ROOM: Room = {
  profile: lockedProfile(),
  messages: [],
  memories: [],
};

export const loadRoom = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const sql = await getSql();
    const [profileRow] = await sql<{ data: Profile | string }>`
      select data from qingran_profile where id = 1
    `;
    const messages = await sql<{
      id: string;
      role: ChatMessage["role"];
      body: string;
      created_at: number;
    }>`
      select id, role, body, created_at
      from qingran_messages
      order by created_at asc,
        case when role = 'user' then 0 else 1 end asc,
        id asc
    `;
    const memories = await sql<{
      id: string;
      body: string;
      created_at: number;
      updated_at: number;
    }>`
      select id, body, created_at, updated_at
      from qingran_memories
      order by updated_at asc
    `;

    const raw = profileRow?.data;
    const stored =
      typeof raw === "string" ? (safeJson(raw) as Partial<Profile> | null) : raw;
    const profile = lockedProfile(stored ?? {});
    return {
      profile,
      messages: sortConversation(
        applyMemoryCursor(
          messages.map((m) => decodeStoredMessage(m)),
          profile.memoryCursor,
        ),
      ),
      memories: memories.map((m) => ({
        id: m.id,
        text: m.body,
        createdAt: Number(m.created_at),
        updatedAt: Number(m.updated_at),
      })),
    } satisfies Room;
  } catch {
    return EMPTY_ROOM;
  }
});

export const saveRoomProfile = createServerFn({ method: "POST" })
  .validator((input: Profile) => input)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const profile = lockedProfile(data);
    await sql`
      insert into qingran_profile (id, data, updated_at)
      values (1, ${JSON.stringify(profile)}::jsonb, now())
      on conflict (id) do update
        set data = excluded.data, updated_at = now()
    `;
    return { ok: true as const };
  });

export const appendRoomMessage = createServerFn({ method: "POST" })
  .validator((input: ChatMessage) => input)
  .handler(async ({ data }) => {
    const sql = await getSql();
    await sql`
      insert into qingran_messages (id, role, body, created_at)
      values (${data.id}, ${data.role}, ${encodeStoredMessage(data).slice(0, 4000)}, ${data.createdAt})
      on conflict (id) do update
        set body = excluded.body
    `;
    await sql`
      delete from qingran_messages
      where id in (
        select id from qingran_messages
        order by created_at desc
        offset 240
      )
    `;
    return { ok: true as const };
  });

export const saveRoomMemories = createServerFn({ method: "POST" })
  .validator((input: Memory[]) => input)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const list = data.slice(-80);
    await sql`delete from qingran_memories`;
    for (const m of list) {
      await sql`
        insert into qingran_memories (id, body, created_at, updated_at)
        values (${m.id}, ${m.text.slice(0, 240)}, ${m.createdAt}, ${m.updatedAt})
      `;
    }
    return { ok: true as const };
  });

export const restoreRoomBackup = createServerFn({ method: "POST" })
  .validator((input: { profile: Profile; memories: Memory[]; messages: ChatMessage[] }) => input)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const profile = lockedProfile(data.profile);
    await sql`
      insert into qingran_profile (id, data, updated_at)
      values (1, ${JSON.stringify(profile)}::jsonb, now())
      on conflict (id) do update
        set data = excluded.data, updated_at = now()
    `;
    await sql`delete from qingran_memories`;
    const memories = data.memories.slice(-80);
    for (const m of memories) {
      await sql`
        insert into qingran_memories (id, body, created_at, updated_at)
        values (${m.id}, ${m.text.slice(0, 240)}, ${m.createdAt}, ${m.updatedAt})
      `;
    }
    await sql`delete from qingran_messages`;
    const messages = data.messages.slice(-240);
    for (const msg of messages) {
      await sql`
        insert into qingran_messages (id, role, body, created_at)
        values (${msg.id}, ${msg.role}, ${encodeStoredMessage(msg).slice(0, 4000)}, ${msg.createdAt})
      `;
    }
    return { ok: true as const };
  });

export const clearRoomMessages = createServerFn({ method: "POST" }).handler(
  async () => {
    const sql = await getSql();
    await sql`delete from qingran_messages`;
    return { ok: true as const };
  },
);

export const updateRoomMessage = createServerFn({ method: "POST" })
  .validator((input: ChatMessage) => input)
  .handler(async ({ data }) => {
    const sql = await getSql();
    await sql`
      update qingran_messages
      set body = ${encodeStoredMessage(data).slice(0, 4000)}
      where id = ${data.id}
    `;
    return { ok: true as const };
  });

export const deleteRoomMessages = createServerFn({ method: "POST" })
  .validator((input: { ids: string[] }) => input)
  .handler(async ({ data }) => {
    if (!data.ids.length) return { ok: true as const };
    const sql = await getSql();
    for (const id of data.ids) {
      await sql`delete from qingran_messages where id = ${id}`;
    }
    return { ok: true as const };
  });

export const markRoomMessagesScanned = createServerFn({ method: "POST" })
  .validator((input: { ids: string[] }) => input)
  .handler(async ({ data }) => {
    if (!data.ids.length) return { ok: true as const };
    const sql = await getSql();
    for (const id of data.ids) {
      const rows = await sql<{ body: string }>`
        select body from qingran_messages where id = ${id}
      `;
      const body = rows[0]?.body;
      if (!body || body.startsWith("⟦已扫⟧")) continue;
      await sql`
        update qingran_messages
        set body = ${`⟦已扫⟧${body}`.slice(0, 4000)}
        where id = ${id}
      `;
    }
    return { ok: true as const };
  });

function encodeStoredMessage(msg: ChatMessage): string {
  let text = msg.text;
  if (msg.kind === "steer") text = `⟦走向⟧${text}`;
  else if (msg.kind === "setting") text = `⟦设定⟧${text}`;
  else if (msg.kind === "unheard") text = `⟦未听⟧${text}`;
  if (msg.replyTo) text = `⟦回:${msg.replyTo}⟧${text}`;
  if (msg.predictedTags) {
    text = `⟦气:${msg.predictedTags.length}.${msg.predictedTags.contour}.${msg.predictedTags.voice}.${msg.predictedTags.event}⟧${text}`;
  }
  if (msg.voiceTurnId) {
    text =
      msg.hearingGold === "confirmed"
        ? `⟦听:${msg.voiceTurnId}:金⟧${text}`
        : `⟦听:${msg.voiceTurnId}⟧${text}`;
  }
  if (msg.scanned) text = `⟦已扫⟧${text}`;
  if (msg.interrupted) text = `⟦断⟧${text}`;
  return text;
}

function decodeStoredMessage(row: {
  id: string;
  role: ChatMessage["role"];
  body: string;
  created_at: number;
}): ChatMessage {
  let text = row.body;
  let scanned = false;
  let kind: MessageKind | undefined;
  let voiceTurnId: string | undefined;
  let hearingGold: ChatMessage["hearingGold"];
  let replyTo: string | undefined;
  let predictedTags: AcousticTags | undefined;
  let interrupted = false;
  if (text.startsWith("⟦断⟧")) {
    interrupted = true;
    text = text.slice("⟦断⟧".length);
  }
  if (text.startsWith("⟦已扫⟧")) {
    scanned = true;
    text = text.slice(4);
  }
  const hear = text.match(/^⟦听:([^⟧]+)⟧/);
  if (hear) {
    const raw = hear[1];
    if (raw.endsWith(":金")) {
      voiceTurnId = raw.slice(0, -2);
      hearingGold = "confirmed";
    } else {
      voiceTurnId = raw;
      hearingGold = "unconfirmed";
    }
    text = text.slice(hear[0].length);
  }
  const gas = text.match(/^⟦气:([^⟧]+)⟧/);
  if (gas) {
    const [length, contour, voice, event] = gas[1].split(".");
    predictedTags = parseAcousticTags({ length, contour, voice, event }) ?? undefined;
    text = text.slice(gas[0].length);
  }
  const reply = text.match(/^⟦回:([^⟧]+)⟧/);
  if (reply) {
    replyTo = reply[1];
    text = text.slice(reply[0].length);
  }
  if (text.startsWith("⟦走向⟧")) {
    kind = "steer";
    text = text.slice(4);
  } else if (text.startsWith("⟦设定⟧")) {
    kind = "setting";
    text = text.slice(4);
  } else if (text.startsWith("⟦未听⟧")) {
    kind = "unheard";
    text = text.slice(4);
  }
  return {
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    text,
    createdAt: Number(row.created_at),
    kind,
    scanned: scanned || undefined,
    voiceTurnId,
    hearingGold,
    replyTo,
    predictedTags,
    interrupted: interrupted || undefined,
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
