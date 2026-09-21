export type PutHearingResult = {
  pathname: string | null;
  error: string | null;
};

export function hearingBlobPath(id: string): string {
  return `hearing/${id}.wav`;
}

async function putOnce(pathname: string, bytes: Buffer): Promise<void> {
  const { put } = await import("@vercel/blob");
  await put(pathname, bytes, {
    access: "private",
    contentType: "audio/wav",
    addRandomSuffix: false,
  });
}

export async function putHearingWav(id: string, bytes: Buffer): Promise<PutHearingResult> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return { pathname: null, error: null };
  const pathname = hearingBlobPath(id);
  try {
    await putOnce(pathname, bytes);
    return { pathname, error: null };
  } catch (first) {
    try {
      await putOnce(pathname, bytes);
      return { pathname, error: null };
    } catch (second) {
      const message = second instanceof Error ? second.message : "blob_put_failed";
      return { pathname: null, error: message.slice(0, 500) };
    }
  }
}

export async function readHearingWav(pathname: string): Promise<string | null> {
  if (!pathname) return null;
  if (!process.env.BLOB_READ_WRITE_TOKEN && !process.env.BLOB_STORE_ID) return null;
  try {
    const { get } = await import("@vercel/blob");
    const result = await get(pathname, { access: "private" });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return streamToBase64(result.stream);
  } catch {
    return null;
  }
}

export async function deleteHearingWav(pathname: string | null | undefined): Promise<void> {
  if (!pathname) return;
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    const { del } = await import("@vercel/blob");
    await del(pathname);
  } catch {
    /* missing blob is fine */
  }
}

async function streamToBase64(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("base64");
}
