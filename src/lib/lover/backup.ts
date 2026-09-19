import { lockedProfile, type ChatMessage, type Memory, type Profile } from "./types.ts";

export const BACKUP_KIND = "qingran-backup";
export const BACKUP_VERSION = 1;

export type QingranBackup = {
  kind: typeof BACKUP_KIND;
  version: number;
  exportedAt: number;
  profile: Profile;
  memories: Memory[];
  messages: ChatMessage[];
};

export function makeBackup(input: {
  profile: Profile;
  memories: Memory[];
  messages: ChatMessage[];
  now?: number;
}): QingranBackup {
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: input.now ?? Date.now(),
    profile: lockedProfile(input.profile),
    memories: input.memories.slice(-80).map(cloneMemory),
    messages: input.messages.slice(-240).map(cloneMessage),
  };
}

export function parseBackup(raw: unknown): QingranBackup | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Partial<QingranBackup>;
  if (data.kind !== BACKUP_KIND) return null;
  if (data.version !== BACKUP_VERSION) return null;
  if (!Array.isArray(data.memories) || !Array.isArray(data.messages)) return null;
  const profile = lockedProfile(data.profile);
  const memories = data.memories.map(cloneMemory).filter((m) => m.id && m.text);
  const messages = data.messages.map(cloneMessage).filter((m) => m.id && m.role);
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: Number(data.exportedAt) || Date.now(),
    profile,
    memories,
    messages,
  };
}

export function backupFilename(at = Date.now()) {
  const d = new Date(at);
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("");
  return `qingran-backup-${stamp}.json`;
}

function cloneMemory(m: Memory): Memory {
  return {
    id: String(m.id ?? ""),
    text: String(m.text ?? "").slice(0, 240),
    createdAt: Number(m.createdAt) || 0,
    updatedAt: Number(m.updatedAt) || Number(m.createdAt) || 0,
  };
}

function cloneMessage(m: ChatMessage): ChatMessage {
  const role = m.role === "assistant" ? "assistant" : "user";
  const kind = m.kind === "steer" || m.kind === "setting" ? m.kind : undefined;
  return {
    id: String(m.id ?? ""),
    role,
    text: String(m.text ?? "").slice(0, 4000),
    createdAt: Number(m.createdAt) || 0,
    kind,
    scanned: m.scanned ? true : undefined,
    voiceTurnId: m.voiceTurnId ? String(m.voiceTurnId) : undefined,
    hearingGold: m.hearingGold === "confirmed" ? "confirmed" : m.hearingGold === "unconfirmed" ? "unconfirmed" : undefined,
  };
}
