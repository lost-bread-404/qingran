import { useEffect, useState } from "react";

export function useVisualViewportHeight(active = true) {
  const [box, setBox] = useState({ height: 800, offsetTop: 0 });

  useEffect(() => {
    if (!active) return;
    const sync = () => {
      const viewport = window.visualViewport;
      setBox({
        height: Math.round(viewport?.height ?? window.innerHeight),
        offsetTop: Math.round(viewport?.offsetTop ?? 0),
      });
    };
    sync();
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", sync);
    viewport?.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    return () => {
      viewport?.removeEventListener("resize", sync);
      viewport?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
    };
  }, [active]);

  const keyboardUp = typeof window !== "undefined" && window.innerHeight - box.height > 80;
  return { ...box, keyboardUp };
}

export function useVisualViewport() {
  const [pad, setPad] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => {
      const hidden = window.innerHeight - viewport.height - viewport.offsetTop;
      setPad(Math.max(0, hidden));
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
    };
  }, []);

  return pad;
}

const CARET_STYLE_KEYS = [
  "box-sizing",
  "width",
  "font",
  "font-size",
  "font-family",
  "font-weight",
  "font-style",
  "letter-spacing",
  "line-height",
  "text-transform",
  "word-spacing",
  "word-break",
  "overflow-wrap",
  "white-space",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-width",
] as const;

export function keepCaretVisible(el: HTMLTextAreaElement | null) {
  if (!el) return;
  const computed = getComputedStyle(el);
  const probe = document.createElement("div");
  for (const key of CARET_STYLE_KEYS) {
    probe.style.setProperty(key, computed.getPropertyValue(key));
  }
  probe.style.position = "absolute";
  probe.style.left = "-9999px";
  probe.style.top = "0";
  probe.style.height = "auto";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre-wrap";
  probe.style.wordWrap = "break-word";
  probe.style.overflow = "hidden";
  probe.style.width = `${el.clientWidth}px`;
  probe.textContent = el.value.slice(0, el.selectionEnd);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  probe.appendChild(marker);
  document.body.appendChild(probe);
  const caretTop = marker.offsetTop;
  probe.remove();
  const view = el.clientHeight;
  const pad = Math.min(64, Math.max(28, view * 0.28));
  if (caretTop < el.scrollTop + pad) el.scrollTop = Math.max(0, caretTop - pad);
  else if (caretTop > el.scrollTop + view - pad) el.scrollTop = caretTop - view + pad;
}