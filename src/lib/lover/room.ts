import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { decodeStoredBody, encodeStoredMessage } from "./message-markup";
import {
  applyMemoryCursor,
  lockedProfile,
  type ChatMessage,
  type Memory,
  type Profile,
} from "./types";
import { sortConversation } from "./pair-messages";

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
      kind?: string;
    }>`
      select id, role, body, created_at, kind
      from qingran_messages
      where created_at > coalesce((select room_cleared_at from qingran_profile where id = 1), 0)
        and forgotten_at is null
      order by created_at desc,
        case when role = 'user' then 1 else 0 end desc,
        id desc
      limit 240
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
          messages.reverse().map((m) => decodeStoredMessage(m)),
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
    const kind = data.kind === "steer" || data.kind === "setting" ? data.kind : "say";
    const body = encodeStoredMessage(data);
    await sql`
      insert into qingran_messages (id, role, body, created_at, kind)
      values (${data.id}, ${data.role}, ${body}, ${data.createdAt}, ${kind})
      on conflict (id) do update
        set body = excluded.body, kind = excluded.kind
    `;
    return { ok: true as const };
  });

export const saveRoomMemories = createServerFn({ method: "POST" })
  .validator((input: Memory[]) => input)
  .handler(async ({ data }) => {
    const sql = await getSql();
    const list = data.slice(-80);
    for (const m of list) {
      await sql`
        insert into qingran_memories (id, body, created_at, updated_at)
        values (${m.id}, ${m.text.slice(0, 240)}, ${m.createdAt}, ${m.updatedAt})
        on conflict (id) do update set
          body = excluded.body, updated_at = excluded.updated_at
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
    const memories = data.memories.slice(-80);
    for (const m of memories) {
      await sql`
        insert into qingran_memories (id, body, created_at, updated_at)
        values (${m.id}, ${m.text.slice(0, 240)}, ${m.createdAt}, ${m.updatedAt})
        on conflict (id) do update set
          body = excluded.body, updated_at = excluded.updated_at
      `;
    }
    const messages = data.messages.slice(-240);
    for (const msg of messages) {
      const kind = msg.kind === "steer" || msg.kind === "setting" ? msg.kind : "say";
      await sql`
        insert into qingran_messages (id, role, body, created_at, kind)
        values (${msg.id}, ${msg.role}, ${encodeStoredMessage(msg)}, ${msg.createdAt}, ${kind})
        on conflict (id) do update
          set body = excluded.body, kind = excluded.kind
      `;
    }
    return { ok: true as const };
  });


export const clearRoomMessages = createServerFn({ method: "POST" }).handler(
  async () => {
    const { clearRecentConversation } = await import("./brain/store");
    await clearRecentConversation();
    return { ok: true as const };
  },
);

export const updateRoomMessage = createServerFn({ method: "POST" })
  .validator((input: ChatMessage) => input)
  .handler(async ({ data }) => {
    const kind = data.kind === "steer" || data.kind === "setting" ? data.kind : "say";
    const { updateMessageText } = await import("./brain/store");
    await updateMessageText(data.id, encodeStoredMessage(data), kind);
    return { ok: true as const };
  });

export const deleteRoomMessages = createServerFn({ method: "POST" })
  .validator((input: { ids: string[] }) => input)
  .handler(async ({ data }) => {
    if (!data.ids.length) return { ok: true as const };
    const sql = await getSql();
    const at = Date.now();
    for (const id of data.ids) {
      await sql`update qingran_messages set forgotten_at = coalesce(forgotten_at, ${at}) where id = ${id}`;
    }
    return { ok: true as const };
  });

export const markRoomMessagesScanned = createServerFn({ method: "POST" })
  .validator((input: { ids: string[] }) => input)
  .handler(async ({ data }) => {
    if (!data.ids.length) return { ok: true as const };
    const sql = await getSql();
    const now = Date.now();
    for (const id of data.ids) {
      await sql`update qingran_messages set archived_at = coalesce(archived_at, ${now}) where id = ${id}`;
    }
    return { ok: true as const };
  });

function decodeStoredMessage(row: {
  id: string;
  role: ChatMessage["role"];
  body: string;
  created_at: number;
  kind?: string;
}): ChatMessage {
  const decoded = decodeStoredBody(row.body, row.kind);
  return {
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    text: decoded.text,
    createdAt: Number(row.created_at),
    kind: decoded.kind,
    scanned: decoded.scanned || undefined,
    voiceTurnId: decoded.voiceTurnId,
    hearingGold: decoded.hearingGold,
    replyTo: decoded.replyTo,
    activeReply: decoded.activeReply,
    predictedTags: decoded.predictedTags,
    interrupted: decoded.interrupted || undefined,
    nightNoise: decoded.nightNoise || undefined,
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
