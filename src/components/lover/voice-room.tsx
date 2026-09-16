import { Settings, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CallButton } from "@/components/lover/call-button";
import { MicButton } from "@/components/lover/mic-button";
import { SettingsDrawer } from "@/components/lover/settings-drawer";
import { Transcript } from "@/components/lover/transcript";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCall } from "@/hooks/use-call";
import { keepCaretVisible, useVisualViewportHeight } from "@/hooks/use-visual-viewport";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { base64ToBytes, concatBytes } from "@/lib/lover/audio";
import { addManualMemory, mergeFacts, replaceMemories, updateMemory } from "@/lib/lover/memory";
import { dropIncompleteReplies } from "@/lib/lover/pair-messages";
import {
  enqueuePlayback,
  getPlaybackElement,
  isPlaybackUnlocked,
  kickAudio,
  playMp3Bytes,
  resumeAudio,
  sealPlayback,
  stopPlayback,
  unlockPlayback,
  whenPlaybackIdle,
} from "@/lib/lover/playback";
import {
  appendRoomMessage,
  clearRoomMessages,
  deleteRoomMessages,
  loadRoom,
  markRoomMessagesScanned,
  saveRoomMemories,
  saveRoomProfile,
  updateRoomMessage,
} from "@/lib/lover/room";
import { consolidateMemories, rememberOverflow, speakAsLover } from "@/lib/lover/server";
import { stripSpeechTags } from "@/lib/lover/speech-tags";
import { nextVoiceRate, snapVoiceRate } from "@/lib/lover/tts";
import { newId } from "@/lib/lover/storage";
import { streamTalk } from "@/lib/lover/talk-client";
import {
  CONTEXT_WINDOW,
  DEFAULT_PROFILE,
  lockedProfile,
  type ChatMessage,
  type Memory,
  type Profile,
  type SessionStatus,
} from "@/lib/lover/types";
import { cn } from "@/lib/utils";

function lastUserSay(messages: ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "user" && msg.kind !== "steer" && msg.kind !== "setting") {
      return msg;
    }
  }
  return null;
}

export function VoiceRoom() {
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [draft, setDraft] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const busyRef = useRef(false);
  const turnRef = useRef(0);
  const memoriesRef = useRef<Memory[]>([]);
  const profileRef = useRef(profile);
  const chatRef = useRef<ChatMessage[]>([]);
  const settingsOpenRef = useRef(false);
  const holdingRef = useRef(false);
  const finishingHoldRef = useRef(false);
  const rememberLockRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const pendingIdsRef = useRef(new Set<string>());
  const inflightRef = useRef<{ id: string; createdAt: number; text: string } | null>(null);
  const callActiveRef = useRef(false);
  const hearRef = useRef<() => void>(() => undefined);
  const deafenRef = useRef<() => void>(() => undefined);
  const reviveRef = useRef<(gesture?: boolean) => void>(() => undefined);
  const spokenCacheRef = useRef(new Map<string, { bytes: Uint8Array<ArrayBuffer>; mimeType: string }>());
  const viewport = useVisualViewportHeight();
  const voice = useVoiceInput({ lang: "zh-CN", prompt: profile.systemPrompt });

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);
  useEffect(() => {
    memoriesRef.current = memories;
  }, [memories]);
  useEffect(() => {
    chatRef.current = messages;
  }, [messages]);
  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  useEffect(() => {
    const lock = () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    };
    const blockZoom = (event: Event) => event.preventDefault();
    lock();
    window.addEventListener("scroll", lock);
    document.addEventListener("gesturestart", blockZoom);
    document.addEventListener("gesturechange", blockZoom);
    document.addEventListener("gestureend", blockZoom);
    return () => {
      window.removeEventListener("scroll", lock);
      document.removeEventListener("gesturestart", blockZoom);
      document.removeEventListener("gesturechange", blockZoom);
      document.removeEventListener("gestureend", blockZoom);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadRoom()
      .then((room) => {
        if (cancelled) return;
        setProfile(lockedProfile(room.profile));
        setMessages(room.messages);
        setMemories(room.memories);
        setHydrated(true);
      })
      .catch(() => {
        if (cancelled) return;
        setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      void saveRoomProfile({ data: lockedProfile(profile) });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [hydrated, profile]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      void saveRoomMemories({ data: memories });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [hydrated, memories]);

  useEffect(() => {
    if (!hydrated || !profile.autoRemember) return;
    void sweepOverflow();
  }, [hydrated, messages.length, profile.autoRemember, profile.memoryCursor]);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setInterval(() => {
      if (busyRef.current || settingsOpenRef.current || holdingRef.current || callActiveRef.current) {
        return;
      }
      void loadRoom().then((room) => {
        setMessages((prev) => (room.messages.length > prev.length ? room.messages : prev));
      });
    }, 15000);
    return () => window.clearInterval(timer);
  }, [hydrated]);

  useEffect(() => {
    const persistInflight = () => {
      const cur = inflightRef.current;
      const display = cur ? stripSpeechTags(cur.text) : "";
      if (!cur || !display) return;
      void appendRoomMessage({
        data: {
          id: cur.id,
          role: "assistant",
          text: display,
          createdAt: cur.createdAt,
        },
      });
    };
    const wake = () => {
      if (document.visibilityState === "hidden") {
        persistInflight();
        return;
      }
      void kickAudio();
      reviveRef.current();
    };
    const onHide = () => persistInflight();
    const onGesture = () => {
      void kickAudio();
      reviveRef.current(true);
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("pointerdown", onGesture, { capture: true });
    document.addEventListener("touchstart", onGesture, { capture: true });
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("pointerdown", onGesture, { capture: true } as EventListenerOptions);
      document.removeEventListener("touchstart", onGesture, { capture: true } as EventListenerOptions);
    };
  }, []);

  async function sweepOverflow() {
    if (rememberLockRef.current || !profileRef.current.autoRemember) return;
    rememberLockRef.current = true;
    try {
      while (profileRef.current.autoRemember) {
        const chat = chatRef.current;
        const overflowAt = Math.max(0, chat.length - CONTEXT_WINDOW);
        if (overflowAt === 0) break;
        const overflow = chat.slice(0, overflowAt).filter((m) => !m.scanned);
        if (overflow.length < 10) break;
        const batch = overflow.slice(0, 24);
        const result = await rememberOverflow({
          data: {
            overflow: batch,
            lookahead: chat.slice(overflowAt, overflowAt + 10),
            memories: memoriesRef.current,
          },
        });
        if (!result.consumedIds.length) break;
        const marked = new Set(result.consumedIds);
        const nextChat = chatRef.current.map((m) =>
          marked.has(m.id) ? { ...m, scanned: true } : m,
        );
        chatRef.current = nextChat;
        setMessages(nextChat);
        void markRoomMessagesScanned({ data: { ids: result.consumedIds } });
        const cursor = result.consumedIds[result.consumedIds.length - 1];
        if (cursor) {
          const nextProfile = lockedProfile({ ...profileRef.current, memoryCursor: cursor });
          profileRef.current = nextProfile;
          setProfile(nextProfile);
        }
        if (result.fact) {
          const nextMem = mergeFacts(
            memoriesRef.current,
            [result.fact],
            result.at || Date.now(),
          );
          memoriesRef.current = nextMem;
          setMemories(nextMem);
        }
      }
    } finally {
      rememberLockRef.current = false;
    }
  }

  function resumeCallListen(turn: number) {
    if (!callActiveRef.current) return;
    window.setTimeout(() => {
      if (callActiveRef.current && turn === turnRef.current) hearRef.current();
    }, 420);
  }

  const playFull = useCallback(async (id: string, speech: string, turn: number) => {
    if (profileRef.current.muted) return;
    stopPlayback();
    setStatus("speaking");
    void unlockPlayback();
    void resumeAudio();
    if (callActiveRef.current) deafenRef.current();
    let clip = spokenCacheRef.current.get(id);
    if (clip && !streamAudioCovers([clip.bytes], stripSpeechTags(speech))) {
      spokenCacheRef.current.delete(id);
      clip = undefined;
    }
    if (!clip) {
      const spoken = await speakAsLover({
        data: { text: speech, speed: profileRef.current.voiceSpeed },
      });
      if (!spoken.ok || turn !== turnRef.current) return;
      clip = { bytes: base64ToBytes(spoken.audioBase64), mimeType: spoken.mimeType };
      spokenCacheRef.current.set(id, clip);
    }
    const ok = await playMp3Bytes(clip.bytes, clip.mimeType);
    if (turn !== turnRef.current) return;
    if (!ok) setBanner("声音被浏览器拦住了，点喇叭再听。");
    setStatus((s) => (s === "speaking" ? "idle" : s));
    resumeCallListen(turn);
  }, []);

  const cycleVoiceSpeed = () => {
    const next = nextVoiceRate(profileRef.current.voiceSpeed);
    const profile = lockedProfile({ ...profileRef.current, voiceSpeed: next.speed });
    profileRef.current = profile;
    setProfile(profile);
    spokenCacheRef.current.clear();
    if (status !== "speaking" && status !== "thinking") return;
    const live = inflightRef.current;
    const last = [...chatRef.current].reverse().find((m) => m.role === "assistant");
    const speech = (live?.text || last?.text || "").trim();
    const id = live?.id || last?.id;
    if (!speech || !id) return;
    abortRef.current?.abort();
    busyRef.current = false;
    const turn = ++turnRef.current;
    void playFull(id, speech, turn);
  };

  const sendTurn = useCallback(
    async (
      sayRaw: string,
      opts?: { history?: ChatMessage[]; existingUser?: ChatMessage },
    ) => {
      const say = sayRaw.trim();
      if (!say) return;
      if (!opts?.existingUser && busyRef.current) return;
      const turn = ++turnRef.current;
      busyRef.current = true;
      stopPlayback();
      if (callActiveRef.current) deafenRef.current();
      setBanner(null);
      setEditingId(null);
      voice.setError(null);

      const history = (opts?.history ?? chatRef.current).slice(-CONTEXT_WINDOW);
      const at = Date.now();
      const userMsg: ChatMessage = opts?.existingUser ?? {
        id: newId(),
        role: "user",
        text: say,
        createdAt: at,
        kind: "say",
      };
      const reply: ChatMessage = {
        id: newId(),
        role: "assistant",
        text: "",
        createdAt: (userMsg.createdAt || at) + 1,
      };
      if (opts?.existingUser) {
        setMessages([...history, userMsg, reply]);
      } else {
        setMessages((prev) => [...dropIncompleteReplies(prev, pendingIdsRef.current), userMsg, reply]);
        void appendRoomMessage({ data: userMsg });
      }
      pendingIdsRef.current.add(reply.id);
      inflightRef.current = { id: reply.id, createdAt: reply.createdAt, text: "" };
      setStatus("thinking");
      void kickAudio();

      let full = "";
      let gotAudio = false;
      const clips: Uint8Array<ArrayBuffer>[] = [];
      let clipMime = "audio/pcm;rate=24000";
      let persistAt = 0;
      let paintHandle = 0;
      let latestDisplay = "";
      const persistReply = (text: string) => {
        const display = stripSpeechTags(text);
        inflightRef.current = { id: reply.id, createdAt: reply.createdAt, text };
        if (!display) return;
        void appendRoomMessage({ data: { ...reply, text: display } });
      };
      const flushPaint = () => {
        paintHandle = 0;
        const display = latestDisplay;
        setMessages((prev) =>
          prev.map((m) => (m.id === reply.id ? { ...m, text: display } : m)),
        );
      };
      const paintText = (text: string, force = false) => {
        const display = stripSpeechTags(text);
        inflightRef.current = { id: reply.id, createdAt: reply.createdAt, text };
        latestDisplay = display;
        if (force) {
          if (paintHandle) cancelAnimationFrame(paintHandle);
          paintHandle = 0;
          flushPaint();
          persistReply(text);
          return;
        }
        if (!paintHandle) paintHandle = requestAnimationFrame(flushPaint);
        const now = Date.now();
        if (now - persistAt > 400) {
          persistAt = now;
          persistReply(text);
        }
      };
      try {
        await streamTalk(
          {
            text: say,
            profile: lockedProfile(profileRef.current),
            history,
            memories: memoriesRef.current,
            nowMs: Date.now(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          },
          (event) => {
            if (event.t === "text") {
              full += event.d;
              paintText(full);
              return;
            }
            if (event.t === "text_end") {
              full = event.speech || full;
              paintText(full, true);
              void kickAudio();
              return;
            }
            if (event.t === "done") {
              full = event.speech || full;
              paintText(full, true);
              persistReply(full);
              pendingIdsRef.current.delete(reply.id);
              if (inflightRef.current?.id === reply.id) inflightRef.current = null;
              const display = stripSpeechTags(full);
              const finalMsg = { ...reply, text: display };
              setMessages((prev) => prev.map((m) => (m.id === reply.id ? finalMsg : m)));
              if (turn === turnRef.current) sealPlayback();
              if (turn !== turnRef.current) return;
              if (clips.length && streamAudioCovers(clips, display)) {
                spokenCacheRef.current.set(reply.id, {
                  bytes: concatBytes(clips),
                  mimeType: clipMime,
                });
              } else {
                spokenCacheRef.current.delete(reply.id);
                if (display && !profileRef.current.muted) {
                  void playFull(reply.id, full, turn);
                }
              }
              return;
            }
            if (turn !== turnRef.current) return;
            if (event.t === "audio") {
              if (profileRef.current.muted) return;
              if (event.replace) {
                stopPlayback();
                clips.length = 0;
                void unlockPlayback();
                void resumeAudio();
              }
              gotAudio = true;
              setStatus("speaking");
              const bytes = base64ToBytes(event.b);
              clips.push(bytes);
              clipMime = event.m;
              enqueuePlayback(bytes, event.m);
            } else if (event.t === "err") {
              persistReply(full);
              pendingIdsRef.current.delete(reply.id);
              sealPlayback();
              setBanner(event.m);
              setStatus("error");
            }
          },
        );
      } catch (err) {
        persistReply(full);
        pendingIdsRef.current.delete(reply.id);
        if (turn !== turnRef.current) return;
        if ((err as { name?: string }).name === "AbortError") return;
        setBanner("线路有点不稳，稍后再说。");
        setStatus("error");
      } finally {
        pendingIdsRef.current.delete(reply.id);
        if (turn === turnRef.current) {
          busyRef.current = false;
          if (gotAudio) {
            await whenPlaybackIdle();
            if (turn === turnRef.current) {
              setStatus("idle");
              resumeCallListen(turn);
            }
          } else {
            setStatus((s) => (s === "thinking" || s === "speaking" ? "idle" : s));
            resumeCallListen(turn);
          }
        }
      }
    },
    [playFull, voice.setError],
  );

  const call = useCall({
    prompt: profile.systemPrompt,
    onUtterance: async (text) => {
      await sendTurn(text);
    },
  });

  useEffect(() => {
    callActiveRef.current = call.active;
    hearRef.current = call.hear;
    deafenRef.current = call.deafen;
    reviveRef.current = (gesture?: boolean) => {
      void call.revive(gesture ? { gesture: true } : undefined);
    };
  }, [call.active, call.hear, call.deafen, call.revive]);

  const finishHold = useCallback(async () => {
    if (finishingHoldRef.current) return;
    finishingHoldRef.current = true;
    try {
      stopPlayback();
      const text = await voice.stop();
      stopPlayback();
      const el = getPlaybackElement();
      el.muted = false;
      setStatus("idle");
      if (text) void sendTurn(text);
    } finally {
      finishingHoldRef.current = false;
    }
  }, [sendTurn, voice]);

  const holdStart = useCallback(async () => {
    if (callActiveRef.current || holdingRef.current || finishingHoldRef.current) return;
    if (voice.status === "transcribing") return;
    if (status === "thinking" || status === "speaking") return;
    holdingRef.current = true;
    const starting = voice.start();
    try {
      window.scrollTo(0, 0);
    } catch {
      /* ignore */
    }
    abortRef.current = null;
    turnRef.current += 1;
    busyRef.current = false;
    setEditingId(null);
    setComposerOpen(false);
    void unlockPlayback();
    if (!holdingRef.current) return;
    stopPlayback();
    const el = getPlaybackElement();
    el.muted = true;
    setBanner(null);
    setStatus("recording");
    await starting;
    if (!holdingRef.current) await finishHold();
  }, [finishHold, status, voice]);

  const holdEnd = useCallback(() => {
    holdingRef.current = false;
    void finishHold();
  }, [finishHold]);

  async function toggleCall() {
    if (call.active) {
      call.hangup();
      stopPlayback();
      turnRef.current += 1;
      busyRef.current = false;
      setStatus("idle");
      return;
    }
    if (voice.status === "recording") voice.cancel();
    if (!isPlaybackUnlocked()) await unlockPlayback();
    stopPlayback();
    setComposerOpen(false);
    setEditingId(null);
    setBanner(null);
    await call.start();
  }

  function bargeIn() {
    if (!call.active) return;
    if (status !== "speaking" && status !== "thinking") return;
    stopPlayback();
    turnRef.current += 1;
    busyRef.current = false;
    const cur = inflightRef.current;
    const display = cur ? stripSpeechTags(cur.text) : "";
    if (cur && display) {
      void appendRoomMessage({
        data: {
          id: cur.id,
          role: "assistant",
          text: display,
          createdAt: cur.createdAt,
        },
      });
    }
    setStatus("idle");
    call.hear();
  }

  async function submitComposer() {
    const say = draft.trim();
    if (!say) return;
    if (status === "thinking" || status === "speaking") return;
    stopPlayback();
    setDraft("");
    setComposerOpen(false);
    await sendTurn(say);
  }

  async function saveEdit() {
    const current = lastUserSay(chatRef.current);
    const text = editDraft.trim();
    if (!current || current.id !== editingId || !text) return;
    if (text === current.text.trim()) {
      setEditingId(null);
      if (call.active) call.hear();
      return;
    }
    abortRef.current?.abort();
    stopPlayback();
    busyRef.current = true;
    const idx = chatRef.current.findIndex((m) => m.id === current.id);
    if (idx < 0) return;
    const history = chatRef.current.slice(0, idx);
    const updated: ChatMessage = { ...current, text };
    const removed = chatRef.current.slice(idx + 1);
    setMessages([...history, updated]);
    setEditingId(null);
    void updateRoomMessage({ data: updated });
    if (removed.length) {
      void deleteRoomMessages({ data: { ids: removed.map((m) => m.id) } });
    }
    await sendTurn(text, { history, existingUser: updated });
  }

  const recording = voice.status === "recording";
  const transcribing = voice.status === "transcribing";
  const editable = lastUserSay(messages);
  const composing = composerOpen && !recording && !call.active;
  const statusLine = call.active
    ? call.phase === "speaking-you"
      ? "在听你"
      : call.phase === "transcribing"
        ? "听你说的话"
        : status === "thinking"
          ? "她在想"
          : status === "speaking"
            ? "清然在说 · 点灯可打断"
            : "你说，说完停两秒"
    : "";

  return (
    <div
      className="room-bg fixed inset-x-0 flex flex-col overflow-hidden"
      style={{ top: viewport.offsetTop, height: viewport.height }}
    >
      <div className="mx-auto flex h-full min-h-0 w-full max-w-lg flex-col overflow-hidden">
        <header className="relative z-10 flex shrink-0 items-center justify-between bg-bg/80 px-5 pb-2 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "lamp-orb size-10 rounded-full",
                status === "idle" && !recording && !call.active && "lamp-breathe",
              )}
              aria-hidden
              onClick={bargeIn}
            />
            <div>
              <p className="font-display text-lg font-medium leading-tight tracking-tight">清然</p>
              <p className="text-xs text-subtle">
                {call.active ? "通话中" : memories.length > 0 ? `记得 ${memories.length} 件事` : "在"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`语速 ${snapVoiceRate(profile.voiceSpeed).label}，点一下换一档`}
              className={cn(
                "text-xs",
                snapVoiceRate(profile.voiceSpeed).id !== "normal" && "text-live",
              )}
              onClick={cycleVoiceSpeed}
            >
              {snapVoiceRate(profile.voiceSpeed).label}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={profile.muted ? "打开声音" : "关闭声音"}
              onClick={() => setProfile((p) => ({ ...p, muted: !p.muted }))}
            >
              {profile.muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="设置"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="size-5" />
            </Button>
          </div>
        </header>

        {composing ? (
          <div className="flex min-h-0 flex-1 flex-col px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
            {(banner || voice.error) && (
              <p className="mb-2 text-center text-sm text-live">{banner || voice.error}</p>
            )}
            <Textarea
              autoFocus
              enterKeyHint="send"
              value={draft}
              onChange={(e) => {
                stopPlayback();
                setDraft(e.target.value);
                keepCaretVisible(e.currentTarget);
              }}
              onSelect={(e) => keepCaretVisible(e.currentTarget)}
              onFocus={(e) => {
                stopPlayback();
                const box = e.currentTarget;
                window.setTimeout(() => {
                  window.scrollTo(0, 0);
                  keepCaretVisible(box);
                }, 50);
              }}
              placeholder="写给她"
              className="min-h-0 flex-1 resize-none"
            />
            <div className="mt-3 flex shrink-0 items-center justify-between gap-3">
              <button
                type="button"
                className="text-xs text-muted underline-offset-4 hover:underline"
                onClick={() => setComposerOpen(false)}
              >
                收起
              </button>
              <Button type="button" size="pill" onClick={() => void submitComposer()}>
                送出
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Transcript
              messages={messages}
              partnerName="清然"
              statusLine={statusLine}
              thinking={status === "thinking" || transcribing || call.phase === "transcribing"}
              editableId={editable?.id ?? null}
              editingId={editingId}
              editDraft={editDraft}
              onPlay={(id, text) => {
                void unlockPlayback();
                void playFull(id, text, turnRef.current);
              }}
              onEditStart={(id) => {
                stopPlayback();
                abortRef.current?.abort();
                turnRef.current += 1;
                busyRef.current = false;
                if (call.active) call.deafen();
                const msg = messages.find((m) => m.id === id);
                if (!msg) return;
                setEditingId(id);
                setEditDraft(msg.text);
                setComposerOpen(false);
                setStatus("idle");
              }}
              onEditDraft={setEditDraft}
              onEditCancel={() => {
                setEditingId(null);
                if (call.active) call.hear();
              }}
              onEditSave={() => void saveEdit()}
            />

            {editingId ? null : (
            <footer className="relative z-10 shrink-0 bg-bg px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2">
              {(banner || voice.error || call.error) && (
                <p className="mb-3 text-center text-sm text-live">
                  {banner || voice.error || call.error}
                </p>
              )}
              <div className="flex flex-col items-center gap-3">
                {call.active ? (
                  <CallButton active onClick={() => void toggleCall()} />
                ) : (
                  <div className="flex items-end gap-7">
                    <MicButton
                      recording={recording}
                      busy={transcribing || status === "thinking"}
                      level={voice.level}
                      disabled={transcribing}
                      onHoldStart={() => void holdStart()}
                      onHoldEnd={holdEnd}
                    />
                    <CallButton
                      active={false}
                      disabled={recording || transcribing || status === "thinking"}
                      onClick={() => void toggleCall()}
                    />
                  </div>
                )}
                <p className="min-h-4 max-w-xs text-center text-xs text-subtle">
                  {call.active
                    ? status === "speaking"
                      ? "点灯打断 · 点按钮挂断"
                      : call.phase === "speaking-you"
                        ? "说完停两秒再发给她"
                        : call.error || "通话中"
                    : recording
                      ? voice.interim.trim() || "松开发送"
                      : transcribing
                        ? "听你说的话"
                        : "按住说话，或者打电话"}
                </p>
                {call.active ? null : (
                  <button
                    type="button"
                    className="text-xs text-muted underline-offset-4 hover:underline"
                    onClick={() => setComposerOpen(true)}
                  >
                    打字
                  </button>
                )}
              </div>
            </footer>
            )}
          </>
        )}

        <SettingsDrawer
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          profile={profile}
          memories={memories}
          onSave={(next) => setProfile(lockedProfile(next))}
          onAddMemory={(text, at) => setMemories((list) => addManualMemory(list, text, at))}
          onUpdateMemory={(id, text, at) => setMemories((list) => updateMemory(list, id, text, at))}
          onDeleteMemory={(id) => setMemories((list) => list.filter((m) => m.id !== id))}
          onConsolidateMemories={async () => {
            const result = await consolidateMemories({
              data: {
                memories: memoriesRef.current,
                nowMs: Date.now(),
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
              },
            });
            if (!result.ok || result.facts.length === 0) return;
            const next = replaceMemories(result.facts);
            memoriesRef.current = next;
            setMemories(next);
          }}
          onClearChat={() => {
            setMessages([]);
            setProfile((p) => lockedProfile({ ...p, memoryCursor: "" }));
            void clearRoomMessages();
          }}
        />
      </div>
    </div>
  );
}

function streamAudioCovers(chunks: Array<Uint8Array>, display: string) {
  let bytes = 0;
  for (const chunk of chunks) bytes += chunk.byteLength;
  const sec = bytes / 2 / 24_000;
  const chars = display.replace(/\s+/g, "").length;
  if (chars < 4) return sec >= 0.35;
  return sec >= Math.max(1, chars / 6.5);
}

