import { clearSessionCookieHeader } from "../../../src/lib/auth-lite/session.ts";

export default function logoutPost(): Response {
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/login",
      "Set-Cookie": clearSessionCookieHeader(),
    },
  });
}
