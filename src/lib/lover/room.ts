import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { decodeStoredBody, encodeStoredMessage } from "./message-markup";
import {
  applyProfilePatch,
  emptyFieldRevs,
  listProfileVersions,
  readProfileSnapshot,
  restoreProfileVersion,
  writeProfileDocument,
  type FieldRevs,
} from "./profile-patch.ts";
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
  revs: FieldRevs;
  messages: ChatMessage[];
  memories: Memory[];
};

const EMPTY_ROOM: Room = {
  profile: lockedProfile(),
  revs: emptyFieldRevs(),
  messages: [],
  memories: [],
};

async function clientSource(): Promise<string> {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const ua = (getRequest()?.headers.get("user-agent") ?? "").replace(/\s+/g, " ").trim();
    const kind = /QingranNative/i.test(ua) ? "ios" : "web";
    return ua ? `${kind} ${ua}`.slice(0, 300) : kind;
  } catch {
    return "web";
  }
}

export const loadRoom = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const sql = await getSql();
    const [saved, messages, memories] = await Promise.all([
      readProfileSnapshot(),
      sql<{
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
      `,
      sql<{
        id: string;
        body: string;
        created_at: number;
        updated_at: number;
      }>`
        select id, body, created_at, updated_at
        from qingran_memories
        order by updated_at asc
      `,
    ]);
    const profile = saved.profile;
    return {
      profile,
      revs: saved.revs,
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
    return { ...EMPTY_ROOM, loadFailed: true as const };
  }
});

export const saveProfilePatch = createServerFn({ method: "POST" })
  .validator((input: { patch?: Partial<Profile>; baseRevs?: Partial<FieldRevs> }) => ({
    patch: input?.patch && typeof input.patch === "object" ? input.patch : {},
    baseRevs: input?.baseRevs && typeof input.baseRevs === "object" ? input.baseRevs : {},
  }))
  .handler(async ({ data }) => {
    const result = await applyProfilePatch({
      patch: data.patch,
      baseRevs: data.baseRevs,
      source: await clientSource(),
    });
    return result;
  });

export const loadProfileVersions = createServerFn({ method: "POST" })
  .validator((input: { field?: string }) => ({ field: String(input?.field ?? "") }))
  .handler(async ({ data }) => {
    const rows = await listProfileVersions(data.field);
    return { ok: true as const, rows };
  });

export const restoreProfileField = createServerFn({ method: "POST" })
  .validator((input: { id?: number }) => ({ id: Number(input?.id) }))
  .handler(async ({ data }) => {
    if (!Number.isFinite(data.id)) return { ok: false as const };
    const result = await restoreProfileVersion(data.id, await clientSource());
    if (!result) return { ok: false as const };
    return result;
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
    await writeProfileDocument(lockedProfile(data.profile), "backup");
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