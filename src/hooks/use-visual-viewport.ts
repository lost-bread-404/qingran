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
    // When the keyboard goes away, iOS can leave the page panned and not report the last resize; then the frame
    // stays small or pushed down and the screen looks empty. Once no field has focus, put the page back at the top
    // and measure again after the keyboard has finished closing.
    const timers: number[] = [];
    const settle = () => {
      for (const delay of [60, 350, 700]) {
        timers.push(
          window.setTimeout(() => {
            const active = document.activeElement;
            if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
            if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
            sync();
          }, delay),
        );
      }
    };
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", sync);
    viewport?.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    document.addEventListener("focusout", settle);
    return () => {
      viewport?.removeEventListener("resize", sync);
      viewport?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
      document.removeEventListener("focusout", settle);
      for (const t of timers) window.clearTimeout(t);
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

export type CaretField = HTMLTextAreaElement | HTMLInputElement;

function focusedField(): CaretField | null {
  const active = typeof document === "undefined" ? null : document.activeElement;
  return active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active : null;
}

/**
 * For every editable field in the app: when it gets focus, and whenever the keyboard moves the visible area,
 * the field (and the caret in it) is scrolled back above the keyboard. Panels that hold fields follow the visible
 * area (top / height from useVisualViewportHeight), so there is always room to scroll into.
 */
export function useKeepFocusedFieldVisible() {
  useEffect(() => {
    const timers: number[] = [];
    let frame = 0;
    const reveal = () => {
      const field = focusedField();
      if (field) keepCaretVisible(field);
    };
    const soon = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reveal);
    };
    const onFocus = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)) return;
      // Once when it gets focus, again as the keyboard finishes coming up.
      for (const delay of [60, 320, 650]) timers.push(window.setTimeout(reveal, delay));
    };
    const viewport = window.visualViewport;
    document.addEventListener("focusin", onFocus);
    viewport?.addEventListener("resize", soon);
    return () => {
      document.removeEventListener("focusin", onFocus);
      viewport?.removeEventListener("resize", soon);
      cancelAnimationFrame(frame);
      for (const t of timers) window.clearTimeout(t);
    };
  }, []);
}

export function KeyboardGuard() {
  useKeepFocusedFieldVisible();
  return null;
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

export function keepCaretVisible(el: CaretField | null) {
  if (!el) return;
  let caretTop = 0;
  if (el instanceof HTMLTextAreaElement) caretTop = scrollCaretInside(el);
  revealAboveKeyboard(el, caretTop);
}

function selectionEndOf(el: CaretField) {
  try {
    return el.selectionEnd ?? el.value.length;
  } catch {
    return el.value.length;
  }
}

function scrollCaretInside(el: HTMLTextAreaElement) {
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
  probe.textContent = el.value.slice(0, selectionEndOf(el));
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
  return caretTop;
}

function revealAboveKeyboard(el: CaretField, caretTop: number) {
  const vv = window.visualViewport;
  const floor = (vv ? vv.offsetTop + vv.height : window.innerHeight) - 12;
  const ceiling = vv ? vv.offsetTop + 8 : 8;
  const rect = el.getBoundingClientRect();
  const viewH = floor - ceiling;
  let top = rect.top;
  let bottom = rect.bottom;
  if (el instanceof HTMLTextAreaElement && rect.height > viewH) {
    const computed = getComputedStyle(el);
    const line = parseFloat(computed.lineHeight);
    const padTop = parseFloat(computed.paddingTop) || 0;
    const borderTop = parseFloat(computed.borderTopWidth) || 0;
    const caretY = rect.top + borderTop + padTop + caretTop - el.scrollTop;
    const lineH = Number.isFinite(line) && line > 0 ? line : 22;
    top = caretY;
    bottom = caretY + lineH;
  }
  let delta = 0;
  if (bottom > floor) delta = bottom - floor;
  else if (top < ceiling) delta = top - ceiling;
  if (Math.abs(delta) < 1) return;
  scrollOverflowAncestor(el, delta);
}

function scrollOverflowAncestor(el: HTMLElement, delta: number) {
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    const oy = style.overflowY;
    if ((oy === "auto" || oy === "scroll" || oy === "overlay") && node.scrollHeight > node.clientHeight + 1) {
      node.scrollTop += delta;
      return;
    }
    node = node.parentElement;
  }
}
