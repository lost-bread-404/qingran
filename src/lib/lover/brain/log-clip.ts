export const LOG_RECORD_LIMIT = 200 * 1024;
const MARK = "\n[truncated]";

export function clipLogRecord(row: {
  inputSystem?: string | null;
  inputUser?: string | null;
  outputText?: string | null;
}): {
  inputSystem: string | null;
  inputUser: string | null;
  outputText: string | null;
  truncated: boolean;
} {
  let inputSystem = row.inputSystem ?? null;
  let inputUser = row.inputUser ?? null;
  let outputText = row.outputText ?? null;
  const size = () => (inputSystem?.length ?? 0) + (inputUser?.length ?? 0) + (outputText?.length ?? 0);
  if (size() <= LOG_RECORD_LIMIT) {
    return { inputSystem, inputUser, outputText, truncated: false };
  }
  let left = size() - LOG_RECORD_LIMIT + MARK.length;
  const shrink = (text: string | null): string | null => {
    if (!text || left <= 0) return text;
    const cut = Math.min(text.length, left);
    left -= cut;
    const keep = Math.max(0, text.length - cut);
    return `${text.slice(0, keep)}${MARK}`;
  };
  inputUser = shrink(inputUser);
  inputSystem = shrink(inputSystem);
  outputText = shrink(outputText);
  return { inputSystem, inputUser, outputText, truncated: true };
}

export function clipLogJson(input: unknown): { value: string; truncated: boolean } {
  let text = "null";
  try {
    text = JSON.stringify(input ?? null) ?? "null";
  } catch {
    text = '"[unserializable]"';
  }
  if (text.length <= LOG_RECORD_LIMIT) return { value: text, truncated: false };
  const preview = text.slice(0, Math.max(0, LOG_RECORD_LIMIT - 64));
  return { value: JSON.stringify({ truncated: true, preview: `${preview}${MARK}` }), truncated: true };
}
