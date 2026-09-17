import { onUnauthorized } from "./on-unauthorized.ts";

declare global {
  interface Window {
    __qrFetchPatched?: boolean;
  }
}

if (typeof window !== "undefined" && !window.__qrFetchPatched) {
  window.__qrFetchPatched = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await orig(input, init);
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.includes("/api/warm")) return res;
    onUnauthorized(res);
    return res;
  };
}
