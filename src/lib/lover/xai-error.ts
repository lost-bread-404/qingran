export const QUOTA_HINT = "xAI 额度用完了，去 console.x.ai 充值后再说。";

export function isXaiQuotaFail(status: number, body = ""): boolean {
  if (status === 402) return true;
  const text = body.toLowerCase();
  if (!text) return false;
  if (
    text.includes("insufficient_quota") ||
    text.includes("insufficient quota") ||
    text.includes("exceeded your current quota") ||
    (text.includes("credits") && (text.includes("exhaust") || text.includes("deplet")))
  ) {
    return true;
  }
  return false;
}

export function xaiFailHint(status: number, body = ""): string {
  if (isXaiQuotaFail(status, body)) return QUOTA_HINT;
  if (status === 429) return "说得太密了，等几秒再开口。";
  if (!status) return "这会儿连不上。";
  return `想你的时候卡住了（${status}）。`;
}

export async function readXaiFail(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return xaiFailHint(res.status, body);
}

export function isQuotaHint(message: string | null | undefined): boolean {
  return Boolean(message) && message === QUOTA_HINT;
}
