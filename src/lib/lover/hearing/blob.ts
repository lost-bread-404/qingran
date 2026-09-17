export function hearingBlobPath(id: string): string {
  return `hearing/${id}.wav`;
}

export async function putHearingWav(id: string, bytes: Buffer): Promise<string | null> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  const pathname = hearingBlobPath(id);
  try {
    const { put } = await import("@vercel/blob");
    await put(pathname, bytes, {
      access: "private",
      contentType: "audio/wav",
      addRandomSuffix: false,
    });
    return pathname;
  } catch {
    return null;
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
