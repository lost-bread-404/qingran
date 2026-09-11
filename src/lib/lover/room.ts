import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import {
  loadBoard,
  decodeStoredMessage,
  encodeStoredMessage,
  withCursor,
} from "./memory/store";
import { writeJournal } from "./memory/journal";
import type { MemoryBoard } from "./memory/types";
import { lockedProfile, type ChatMessage, type Profile } from "./types";
import { sortConversation } from "./pair-messages";

type Room = {
  profile: Profile;
  messages: ChatMessage[];
} & MemoryBoard;

const EMPTY_ROOM: Room = {
  profile: lockedProfile(),
  messages: [],
  portrait: "",
  openEvents: [],
  items: [],
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
      scanned: boolean | null;
    }>`
      select id, role, body, created_at, scanned
      from qingran_messages
      order by created_at asc,
        case when role = 'user' then 0 else 1 end asc,
        id asc
    `;

    const raw = profileRow?.data;
    const stored =
      typeof raw === "string" ? (safeJson(raw) as Partial<Profile> | null) : raw;
    const profile = lockedProfile(stored ?? {});
    const board = await loadBoard();
    return {
      profile,
      messages: sortConversation(
        withCursor(
          messages.map((m) => decodeStoredMessage({ ...m, scanned: Boolean(m.scanned) })),
          profile.memoryCursor,
        ),
      ),
      ...board,
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
      insert into qingran_messages (id, role, body, created_at, scanned)
      values (
        ${data.id},
        ${data.role},
        ${encodeStoredMessage(data).slice(0, 4000)},
        ${data.createdAt},
        ${Boolean(data.scanned)}
      )
      on conflict (id) do update
        set body = excluded.body
    `;
    await writeJournal(
      "chat",
      { id: data.id, role: data.role, text: data.text },
      data.createdAt,
    );
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
      await sql`update qingran_messages set scanned = true where id = ${id}`;
    }
    return { ok: true as const };
  });

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
