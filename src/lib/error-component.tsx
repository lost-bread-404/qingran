import type { ErrorComponentProps } from "@tanstack/react-router";

export function AppErrorComponent({ error }: ErrorComponentProps) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-[#0c0b0a] px-6 text-center text-[#f2ece4]">
      <p className="font-display text-2xl">刚才卡住了</p>
      <p className="max-w-sm text-sm leading-relaxed text-[#9a9288]">
        {message || "房间打不开。点下面再进一次。"}
      </p>
      <button
        type="button"
        className="mt-2 rounded-full bg-[#cfc4b6] px-4 py-2 text-sm text-[#0c0b0a]"
        onClick={() => window.location.reload()}
      >
        重新进入
      </button>
    </main>
  );
}
