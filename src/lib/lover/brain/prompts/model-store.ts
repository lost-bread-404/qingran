import { getSql } from "../../../db.ts";
import { lockPromptModels, type PromptModelPick } from "./models.ts";

export async function storedPromptModel(key: string): Promise<PromptModelPick | null> {
  try {
    const db = await getSql();
    const rows = await db.query<{ data: unknown }>("select data from qingran_profile where id = 1");
    const raw = rows[0]?.data;
    const data = (typeof raw === "string" ? JSON.parse(raw) : raw) as { promptModels?: unknown } | null;
    if (!data || typeof data !== "object") return null;
    const models = lockPromptModels(data.promptModels);
    return models[key as keyof typeof models] ?? null;
  } catch {
    return null;
  }
}
