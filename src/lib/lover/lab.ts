import { createServerFn } from "@tanstack/react-start";

/**
 * The lab page (/lab: her feedback on his replies, and Eve's voice tags) has a second password on top of the site's:
 * HEARING_LAB_PASSWORD (named when the lab was for hearing), or "qingran" on a local copy without a database.
 */
function labSecret(): string {
  if (process.env.HEARING_LAB_PASSWORD) return process.env.HEARING_LAB_PASSWORD;
  if (!process.env.DATABASE_URL) return "qingran";
  return "";
}

export function assertLab(password: string) {
  const secret = labSecret();
  if (!secret || password !== secret) throw new Error("lab-locked");
}

export const unlockLab = createServerFn({ method: "POST" })
  .validator((input: { password: string }) => input)
  .handler(async ({ data }) => {
    const secret = labSecret();
    if (!secret) return { ok: false as const, error: "未设置 HEARING_LAB_PASSWORD。" };
    if (data.password !== secret) return { ok: false as const, error: "密码不对。" };
    return { ok: true as const };
  });
