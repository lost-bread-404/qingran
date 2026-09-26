import { useEffect, useState } from "react";

function editingField(): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return true;
  return active instanceof HTMLElement && active.isContentEditable;
}

function readViewportBox() {
  const viewport = window.visualViewport;
  const innerH = window.innerHeight || document.documentElement.clientHeight || 800;
  let height = Math.round(viewport?.height ?? innerH);
  let offsetTop = Math.round(viewport?.offsetTop ?? 0);
  // After a field blurs, iOS can leave visualViewport at the keyboard size or
  // with a leftover offsetTop. The room and settings then paint into that
  // hole, so the page looks empty until the next gesture.
  const keyboardLike = innerH - height > 160;
  if (height < 120 || (!editingField() && keyboardLike)) {
    return { height: innerH, offsetTop: 0 };
  }
  if (!editingField() && offsetTop > 0) offsetTop = 0;
  return { height, offsetTop: Math.max(0, offsetTop) };
}

/** Undo scroll iOS applies to the fixed shells while a field is focused. */
export function releaseStuckScroll() {
  window.scrollTo(0, 0);
  const nodes: Array<HTMLElement | null> = [
    document.documentElement,
    document.body,
    document.getElementById("app"),
    document.querySelector(".room-bg"),
  ];
  for (const node of nodes) {
    if (!node) continue;
    if (node.scrollTop) node.scrollTop = 0;
    if (node.scrollLeft) node.scrollLeft = 0;
  }
}

export function useVisualViewportHeight(active = true) {
  const [box, setBox] = useState({ height: 800, offsetTop: 0 });

  useEffect(() => {
    if (!active) return;
    const sync = () => setBox(readViewportBox());
    sync();
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", sync);
    viewport?.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    const timers: number[] = [];
    const settle = () => {
      releaseStuckScroll();
      for (const id of timers) window.clearTimeout(id);
      timers.length = 0;
      for (const ms of [0, 80, 360]) timers.push(window.setTimeout(sync, ms));
    };
    window.addEventListener("focusout", settle);
    window.addEventListener("focusin", sync);
    return () => {
      viewport?.removeEventListener("resize", sync);
      viewport?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
      window.removeEventListener("focusout", settle);
      window.removeEventListener("focusin", sync);
      for (const id of timers) window.clearTimeout(id);
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