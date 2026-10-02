import { createFileRoute } from "@tanstack/react-router";
import { loadPhoto } from "@/lib/lover/photos";

/** A photo she sent, for the chat to show (`/api/photo?id=…`). Photos never change, so the phone keeps them. */
export const Route = createFileRoute("/api/photo")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const id = new URL(request.url).searchParams.get("id") ?? "";
        const photo = id ? await loadPhoto(id).catch(() => null) : null;
        if (!photo) return new Response("not found", { status: 404 });
        return new Response(new Uint8Array(Buffer.from(photo.data, "base64")), {
          headers: { "Content-Type": photo.mime, "Cache-Control": "private, max-age=31536000, immutable" },
        });
      },
    },
  },
});
