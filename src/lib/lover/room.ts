import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { chatFromRow, metaOfChat } from "./message-meta";
import {
  applyProfilePatch,
  emptyFieldRevs,
  listProfileVersions,
  readProfileSnapshot,
  restoreProfileVersion,
  type FieldRevs,
} from "./profile-patch.ts";
import {
  applyMemoryCursor,
  lockedProfile,
  type ChatMessage,
  type Profile,
} from "./types";
import { sortConversation } from "./pair-messages";

type Room = {
  profile: Profile;
  revs: FieldRevs;
  messages: ChatMessage[];
  build?: string;
};

const EMPTY_ROOM: Room = {
  profile: lockedProfile(),
  revs: emptyFieldRevs(),
  messages: [],
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
    const [saved, messages] = await Promise.all([
      readProfileSnapshot(),
      sql<{
        id: string;
        role: ChatMessage["role"];
        body: string;
        meta: unknown;
        created_at: number;
        kind?: string;
      }>`
        select id, role, body, meta, created_at, kind
        from qingran_messages
        where created_at > coalesce((select room_cleared_at from qingran_profile where id = 1), 0)
          and forgotten_at is null
        order by created_at desc,
          case when role = 'user' then 1 else 0 end desc,
          id desc
        limit 240
      `,
    ]);
    const profile = saved.profile;
    return {
      profile,
      revs: saved.revs,
      /** The deploy this came from: the page reloads itself onto a new one when she is at the bottom of the chat. */
      build: process.env.VERCEL_GIT_COMMIT_SHA || "dev",
      messages: sortConversation(
        applyMemoryCursor(
          messages.reverse().map((m) => chatFromRow(m)),
          profile.memoryCursor,
        ),
      ),
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
    const meta = JSON.stringify(metaOfChat(data));
    await sql`
      insert into qingran_messages (id, role, body, meta, created_at, kind)
      values (${data.id}, ${data.role}, ${data.text}, ${meta}::jsonb, ${data.createdAt}, 'say')
      on conflict (id) do update
        set body = excluded.body, meta = qingran_messages.meta || excluded.meta
    `;
    return { ok: true as const };
  });

export const uploadPhoto = createServerFn({ method: "POST" })
  .validator((input: { dataUrl: string }) => ({ dataUrl: String(input?.dataUrl ?? "") }))
  .handler(async ({ data }) => {
    const { savePhoto } = await import("./photos");
    return savePhoto(data.dataUrl);
  });

export const clearRoomMessages = createServerFn({ method: "POST" }).handler(
  async () => {
    const { clearRecentConversation } = await import("./brain/store");
    await clearRecentConversation();
    return { ok: true as const };
  },
);

/** One message as stored: his replies with the voice tags the page leaves out of what it shows. Null until saved. */
export const readRoomMessage = createServerFn({ method: "POST" })
  .validator((input: { id: string }) => ({ id: String(input?.id ?? "") }))
  .handler(async ({ data }) => {
    const { getMessage } = await import("./brain/store");
    const msg = await getMessage(data.id);
    return msg ? { text: msg.text } : null;
  });

/**
 * She corrected one of his replies: saved in place, and counted as a thumbs-down on it (turn_feedback, rating down)
 * whose note holds the reply before and after, so a review sees what he got wrong and what she wanted.
 */
export const correctHisReply = createServerFn({ method: "POST" })
  .validator((input: ChatMessage) => input)
  .handler(async ({ data }) => {
    const { getMessage, updateMessage } = await import("./brain/store");
    const { insertTurnFeedback } = await import("./brain/turn-feedback");
    const before = (await getMessage(data.id))?.text ?? "";
    await updateMessage(data.id, data.text, metaOfChat(data));
    if (before && before !== data.text) {
      await insertTurnFeedback({
        id: `edit-${Date.now()}-${data.id}`,
        turnId: data.id,
        messageId: data.id,
        rating: "down",
        note: `她改了这条回复。\n改之前：${before}\n改之后：${data.text}`,
      });
    }
    return { ok: true as const };
  });

export const updateRoomMessage = createServerFn({ method: "POST" })
  .validator((input: ChatMessage) => input)
  .handler(async ({ data }) => {
    const { updateMessage } = await import("./brain/store");
    // The kind stays as it was (a message he wrote first stays his).
    await updateMessage(data.id, data.text, metaOfChat(data));
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
