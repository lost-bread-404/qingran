import { BookOpen, Settings, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CallButton } from "@/components/lover/call-button";
import { ConfirmTurn } from "@/components/lover/confirm-turn";
import { FlagReply } from "@/components/lover/flag-reply";
import { MicButton } from "@/components/lover/mic-button";
import { SettingsDrawer } from "@/components/lover/settings-drawer";
import { Transcript, type TranscriptHandle } from "@/components/lover/transcript";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCall } from "@/hooks/use-call";
import { keepCaretVisible, useVisualViewportHeight } from "@/hooks/use-visual-viewport";
import { useVoiceInput } from "@/hooks/use-voice-input";
import { base64ToBytes, concatBytes } from "@/lib/lover/audio";
import { addManualMemory, mergeFacts, replaceMemories, updateMemory } from "@/lib/lover/memory";
import { collapseReplyVariants, dropIncompleteReplies, skipsQingran, unselectedReplyIds } from "@/lib/lover/pair-messages";
import { planInterruptQingran } from "@/lib/lover/interrupt";
import {
  enqueuePlayback,
  getPlaybackElement,
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
  restoreRoomBackup,
  saveRoomMemories,
  saveRoomProfile,
  updateRoomMessage,
} from "@/lib/lover/room";
import { consolidateMemories, rememberOverflow, speakAsLover } from "@/lib/lover/server";
import { stripSpeechTags } from "@/lib/lover/speech-tags";
import { buildHearingContext, extractContextKeyterms, lastDialogueTurns, mergeKeyterms, stripHearingMarkup } from "@/lib/lover/hearing/context";
import { extractTfIdfTerms } from "@/lib/lover/hearing/keyterms";
import { detectAudioRoute } from "@/lib/lover/hearing/route";
import { nextVoiceRate, snapVoiceRate } from "@/lib/lover/tts";
import { newId } from "@/lib/lover/storage";
import { listenAppLifecycle } from "@/lib/lover/audio-session";
import { streamTalk } from "@/lib/lover/talk-client";
import { warmBrain } from "@/lib/lover/brain/warm-client";
import { classifyTalkException, TALK_FAIL, talkExceptionHint } from "@/lib/lover/talk-fail";
import { getHearingSession, setHearingSession } from "@/lib/lover/hearing/session";
import { stripAcousticTags } from "@/lib/lover/hearing/tags";
import { engineLineFromHeard } from "@/lib/lover/hearing/select";
import { formatCallAudioLog, installAudioTrace, subscribeCallAudioLog } from "@/lib/lover/call-audio-log";
import {
  confirmHearingClip,
  flagQingranReply,
  getHearingClipLabel,
  getHearingTurnAudio,
  hearingLabeledCount,
  patchHearingFinalText,
  patchHearingReplyId,
  patchHearingTurn,
  unlabelHearingByTurn,
} from "@/lib/lover/hearing/store";
import { markTurnInterruptedFn } from "@/lib/lover/brain/turn-trace-fn";
import { clipSaveBanner, UNRECOGNIZED_TEXT, voiceTurnIdForMessage, type HeardUtterance } from "@/lib/lover/hearing/heard";
import { nightNoiseReplyText } from "@/lib/lover/hearing/night-voice";
import { micActionForConfirmPanel, planOpenConfirmPanel, shouldAutoSpeakReply } from "@/lib/lover/hearing/confirm-call";
import { planConfirmSave, sliceAfterMessage } from "@/lib/lover/hearing/confirm-resend";
import type { AcousticTags, TagKey } from "@/lib/lover/hearing/tags";
import { POST_QINGRAN_MS } from "@/lib/lover/vad";
import {
  DEFAULT_PROFILE,
  formatVoiceInjectLine,
  lockedProfile,
  voiceInjectFromProfile,
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
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const busyRef = useRef(false);
  const turnRef = useRef(0);
  const memoriesRef = useRef<Memory[]>([]);
  const profileRef = useRef(profile);
  const chatRef = useRef<ChatMessage[]>([]);
  const userWriteRef = useRef<Promise<unknown>>(Promise.resolve());
  const settingsOpenRef = useRef(false);
  const holdingRef = useRef(false);
  const finishingHoldRef = useRef(false);
  const rememberLockRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const pendingIdsRef = useRef(new Set<string>());
  const inflightRef = useRef<{ id: string; createdAt: number; text: string } | null>(null);
  const speakingIdRef = useRef<string | null>(null);
  const callActiveRef = useRef(false);
  const hearRef = useRef<() => void>(() => undefined);
  const deafenRef = useRef<() => void>(() => undefined);
  const spokenCacheRef = useRef(new Map<string, { bytes: Uint8Array<ArrayBuffer>; mimeType: string }>());
  const transcriptRef = useRef<TranscriptHandle>(null);
  const viewport = useVisualViewportHeight();
  const voice = useVoiceInput({ lang: "zh-CN", prompt: profile.systemPrompt });
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmAudioUrl, setConfirmAudioUrl] = useState<string | null>(null);
  const [labeledCount, setLabeledCount] = useState(0);
  const confirmWasOpenRef = useRef(false);
  const confirmOpenRef = useRef(false);
  const skipAutoPlayRef = useRef(false);
  const [undoConfirmId, setUndoConfirmId] = useState<string | null>(null);
  const undoTimerRef = useRef(0);
  const [audioLog, setAudioLog] = useState("");
  const [confirmPredicted, setConfirmPredicted] = useState<AcousticTags | null>(null);
  const [confirmGoldTags, setConfirmGoldTags] = useState<Partial<AcousticTags> | null>(null);
  const [confirmNoise, setConfirmNoise] = useState(false);
  const [confirmMismatch, setConfirmMismatch] = useState(false);
  const [confirmNote, setConfirmNote] = useState("");
  const [confirmDraft, setConfirmDraft] = useState("");
  const [confirmStt, setConfirmStt] = useState("");
  const [flagTarget, setFlagTarget] = useState<{
    messageId: string;
    replyTo?: string;
    trigger: string;
    reply: string;
  } | null>(null);
  const [flagBusy, setFlagBusy] = useState(false);
  const [flagError, setFlagError] = useState<string | null>(null);
  const [praisedIds, setPraisedIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    warmBrain();
  }, []);

  const persistUser = (updated: ChatMessage) => {
    userWriteRef.current = userWriteRef.current
      .catch(() => undefined)
      .then(() => updateRoomMessage({ data: updated }));
    return userWriteRef.current;
  };

  const replyPick = messages
    .filter((m) => m.role === "user" && m.activeReply)
    .map((m) => `${m.id}:${m.activeReply}`)
    .join(",");

  useEffect(() => {
    profileRef.current = profile;
    const contextTurns = collapseReplyVariants(messages)
      .filter((m) => m.kind !== "steer" && m.kind !== "setting" && !skipsQingran(m))
      .map((m) => ({ role: m.role, text: m.text }));
    const context = buildHearingContext(contextTurns);
    const extraKeyterms = mergeKeyterms(
      extractTfIdfTerms(
        [{ text: profile.systemPrompt }, ...memoriesRef.current.map((m) => ({ text: m.text }))],
        50,
      ),
      extractContextKeyterms(context, 50),
    );
    setHearingSession({
      provider: "xai",
      capture: profile.debugHearing,
      debugHearing: profile.debugHearing,
      nbest: profile.hearingNbest,
      mode: callActiveRef.current ? "call" : "text",
      context,
      extraKeyterms,
      contextBefore: lastDialogueTurns(contextTurns),
      systemPrompt: profile.systemPrompt,
      silenceMs: profile.silenceMs,
      nightVoicedMin: profile.nightVoicedMin,
      nightMinMs: profile.nightMinMs,
      sense: profile.hearingSense,
      hearingInstruction: profile.hearingInstruction,
      sttKeyterms: profile.sttKeyterms,
    });
  }, [profile, messages.length, memories, replyPick, status]);
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
    if (!hydrated || !profile.debugHearing) return;
    void hearingLabeledCount({ data: {} }).then((result) => {
      if (result.ok) setLabeledCount(result.count);
    });
  }, [hydrated, profile.debugHearing]);

  useEffect(() => {
    if (!profile.debugHearing) return;
    setAudioLog(formatCallAudioLog());
    return subscribeCallAudioLog(() => setAudioLog(formatCallAudioLog()));
  }, [profile.debugHearing]);

  useEffect(() => {
    installAudioTrace();
    return () => {
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
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
  }, [hydrated, messages.length, profile.autoRemember, profile.memoryCursor, profile.historyWindow]);

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
    const stopLife = listenAppLifecycle({
      onBackground: () => {
        if (callActiveRef.current) return;
        stopPlayback();
        turnRef.current += 1;
        busyRef.current = false;
        setStatus((s) => (s === "speaking" || s === "thinking" ? "idle" : s));
      },
    });
    return () => {
      stopLife();
    };
  }, []);

  async function sweepOverflow() {
    if (rememberLockRef.current || !profileRef.current.autoRemember) return;
    rememberLockRef.current = true;
    try {
      while (profileRef.current.autoRemember) {
        const chat = chatRef.current;
        const overflowAt = Math.max(0, chat.length - profileRef.current.historyWindow);
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
      if (!callActiveRef.current || turn !== turnRef.current) return;
      if (confirmOpenRef.current) return;
      hearRef.current();
    }, POST_QINGRAN_MS);
  }

  const playFull = useCallback(async (id: string, speech: string, turn: number) => {
    if (profileRef.current.muted) return;
    speakingIdRef.current = id;
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
    if (speakingIdRef.current === id) speakingIdRef.current = null;
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

  useEffect(() => {
    void detectAudioRoute().then((route) => setHearingSession({ audioRoute: route }));
  }, [hydrated]);

  const sendTurn = useCallback(
    async (
      sayRaw: string,
      opts?: {
        history?: ChatMessage[];
        existingUser?: ChatMessage;
        keepReplies?: boolean;
        voiceTurnId?: string;
        skipQingran?: boolean;
        nightNoise?: boolean;
        endpointFired?: number;
        sttDoneAt?: number;
        predictedTags?: AcousticTags;
        engine?: string;
      },
    ) => {
      const tagged = sayRaw.trim();
      if (!tagged) return;
      if ((opts?.skipQingran || opts?.nightNoise) && !getHearingSession().debugHearing) return;
      const say = stripHearingMarkup(tagged).trim() || tagged;
      const at = Date.now();
      const injectLine = formatVoiceInjectLine(voiceInjectFromProfile(profileRef.current));
      const sttDoneAt = opts?.sttDoneAt ?? at;
      const hearMs =
        opts?.endpointFired && sttDoneAt >= opts.endpointFired ? sttDoneAt - opts.endpointFired : undefined;
      const userMsg: ChatMessage = opts?.existingUser ?? {
        id: newId(),
        role: "user",
        text: say,
        createdAt: at,
        kind: opts?.skipQingran ? "unheard" : "say",
        nightNoise: opts?.nightNoise || undefined,
        voiceTurnId: opts?.voiceTurnId,
        predictedTags: opts?.predictedTags,
        hearingGold: opts?.voiceTurnId ? "unconfirmed" : undefined,
        hearingTiming:
          hearMs != null || opts?.engine
            ? { hearMs, engine: opts?.engine }
            : undefined,
        injectLine,
      };
      if (opts?.existingUser && (hearMs != null || opts?.engine)) {
        userMsg.hearingTiming = { ...userMsg.hearingTiming, hearMs, engine: opts.engine ?? userMsg.hearingTiming?.engine };
      }
      userMsg.injectLine = injectLine;
      const commitChoice = async () => {
        const base = dropIncompleteReplies(chatRef.current, pendingIdsRef.current);
        const dropIds = unselectedReplyIds(base);
        if (!dropIds.length) {
          chatRef.current = base;
          return;
        }
        const drop = new Set(dropIds);
        chatRef.current = base.filter((m) => !drop.has(m.id));
        setMessages(chatRef.current);
        await deleteRoomMessages({ data: { ids: dropIds } });
      };
      if (opts?.skipQingran) {
        await commitChoice();
        chatRef.current = [...chatRef.current, userMsg];
        setMessages(chatRef.current);
        setBanner(null);
        void appendRoomMessage({ data: userMsg });
        if (opts.voiceTurnId) {
          void patchHearingFinalText({ data: { turnId: opts.voiceTurnId, finalText: "" } });
        }
        return;
      }
      if (!opts?.existingUser && busyRef.current) return;
      if (!opts?.existingUser) await commitChoice();
      const turn = ++turnRef.current;
      busyRef.current = true;
      skipAutoPlayRef.current = false;
      stopPlayback();
      if (callActiveRef.current) deafenRef.current();
      setBanner(null);
      setEditingId(null);
      voice.setError(null);

      const sourceHistory = opts?.history ?? chatRef.current;
      const siblingFloor = (opts?.keepReplies ? sourceHistory : []).reduce(
        (max, message) => (message.replyTo === userMsg.id ? Math.max(max, message.createdAt) : max),
        userMsg.createdAt || at,
      );
      const reply: ChatMessage = {
        id: newId(),
        role: "assistant",
        text: "",
        createdAt: Math.max(Date.now(), siblingFloor + 1),
        replyTo: userMsg.id,
      };
      if (opts?.existingUser && opts.keepReplies) {
        const shownUser: ChatMessage = { ...userMsg, activeReply: reply.id };
        setMessages((prev) => {
          const has = prev.some((m) => m.id === shownUser.id);
          const next = has
            ? prev.map((m) => (m.id === shownUser.id ? { ...m, text: shownUser.text, activeReply: reply.id } : m))
            : [...prev, shownUser];
          const withReply = [...next.filter((m) => m.id !== reply.id), reply];
          chatRef.current = withReply;
          return withReply;
        });
        void persistUser(shownUser);
      } else if (opts?.existingUser) {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === userMsg.id);
          if (idx < 0) return [...(opts.history ?? sourceHistory), userMsg, reply];
          return [...prev.slice(0, idx), userMsg, reply];
        });
      } else {
        chatRef.current = [...chatRef.current, userMsg, reply];
        setMessages(chatRef.current);
        void appendRoomMessage({ data: userMsg });
      }
      pendingIdsRef.current.add(reply.id);
      inflightRef.current = { id: reply.id, createdAt: reply.createdAt, text: "" };
      speakingIdRef.current = reply.id;
      setStatus("thinking");
      void kickAudio();
      if (opts?.voiceTurnId) {
        void patchHearingFinalText({ data: { turnId: opts.voiceTurnId, finalText: tagged } });
        void patchHearingReplyId({ data: { turnId: opts.voiceTurnId, replyMessageId: reply.id } });
      }
      const stampTiming = (partial: { grokMs?: number; ttsMs?: number; ttftMs?: number }) => {
        if (!profileRef.current.debugHearing) return;
        const next = { ...userMsg.hearingTiming, ...partial };
        userMsg.hearingTiming = next;
        setMessages((prev) => prev.map((m) => (m.id === userMsg.id ? { ...m, hearingTiming: next } : m)));
      };

      let full = "";
      let gotAudio = false;
      const clips: Uint8Array<ArrayBuffer>[] = [];
      let clipMime = "audio/pcm;rate=24000";
      let persistAt = 0;
      let paintHandle = 0;
      let latestDisplay = "";
      let grokDone = 0;
      let ttsFirst = 0;
      const hearingTurnId = getHearingSession().lastTurnId;
      const persistReply = (text: string) => {
        inflightRef.current = { id: reply.id, createdAt: reply.createdAt, text };
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
        const ac = new AbortController();
        abortRef.current = ac;
        await streamTalk(
          {
            text: tagged,
            userMsgId: userMsg.id,
            userCreatedAt: userMsg.createdAt || at,
            replyId: reply.id,
            replyCreatedAt: reply.createdAt,
            profile: lockedProfile(profileRef.current),
            nowMs: Date.now(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          },
          (event) => {
            if (turn !== turnRef.current) return;
            if (event.t === "timing" && event.k === "ttft_ms") {
              stampTiming({ ttftMs: event.ms });
              return;
            }
            if (event.t === "text") {
              if (userMsg.hearingTiming?.grokMs == null) stampTiming({ grokMs: Date.now() - sttDoneAt });
              full += event.d;
              paintText(full);
              return;
            }
            if (event.t === "text_end") {
              full = event.speech || full;
              grokDone = Date.now();
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
              const talkTrace = {
                status: event.status ?? null,
                finishReason: event.finishReason ?? null,
                ms: event.ms,
                chars: event.chars,
                ttftMs: event.ttftMs ?? userMsg.hearingTiming?.ttftMs,
              };
              const finalMsg = { ...reply, text: display, talkTrace };
              setMessages((prev) => prev.map((m) => (m.id === reply.id ? finalMsg : m)));
              if (!display.trim()) setBanner(TALK_FAIL.empty);
              if (turn === turnRef.current) sealPlayback();
              if (turn !== turnRef.current) return;
              if (clips.length && streamAudioCovers(clips, display)) {
                spokenCacheRef.current.set(reply.id, {
                  bytes: concatBytes(clips),
                  mimeType: clipMime,
                });
              } else {
                spokenCacheRef.current.delete(reply.id);
                if (display && shouldAutoSpeakReply({
                  muted: profileRef.current.muted,
                  skipAutoPlay: skipAutoPlayRef.current,
                })) {
                  void playFull(reply.id, full, turn);
                }
              }
              return;
            }
            if (turn !== turnRef.current) return;
            if (event.t === "audio") {
              if (!shouldAutoSpeakReply({
                muted: profileRef.current.muted,
                skipAutoPlay: skipAutoPlayRef.current,
              })) return;
              if (event.replace) {
                stopPlayback();
                clips.length = 0;
                void unlockPlayback();
                void resumeAudio();
              }
              gotAudio = true;
              if (!ttsFirst) {
                ttsFirst = Date.now();
                if (userMsg.hearingTiming?.ttsMs == null) stampTiming({ ttsMs: ttsFirst - sttDoneAt });
              }
              setStatus("speaking");
              const bytes = base64ToBytes(event.b);
              clips.push(bytes);
              clipMime = event.m;
              enqueuePlayback(bytes, event.m);
            } else if (event.t === "err") {
              persistReply(full);
              setBanner(
                event.code === "spend_breaker"
                  ? "今日（或本月）费用异常，已暂停。可在设置中确认后继续。"
                  : event.m,
              );
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === reply.id
                    ? {
                        ...m,
                        talkTrace: {
                          status: event.status ?? null,
                          finishReason: event.finishReason ?? null,
                          ms: event.ms,
                          chars: event.chars,
                        },
                      }
                    : m,
                ),
              );
              if (event.tts) {
                skipAutoPlayRef.current = true;
                return;
              }
              pendingIdsRef.current.delete(reply.id);
              sealPlayback();
              setStatus("error");
            }
          },
          ac.signal,
        );
      } catch (err) {
        if (turn === turnRef.current) persistReply(full);
        pendingIdsRef.current.delete(reply.id);
        if (turn !== turnRef.current) return;
        if ((err as { name?: string }).name === "AbortError") return;
        setBanner(talkExceptionHint(classifyTalkException(err).kind));
        setStatus("error");
      } finally {
        if (hearingTurnId) {
          void patchHearingTurn({
            data: {
              id: hearingTurnId,
              grok_done: grokDone || undefined,
              tts_first_audio: ttsFirst || undefined,
              cold_start_ms: getHearingSession().coldStartMs ?? undefined,
            },
          });
        }
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
    onUtterance: async (heard: HeardUtterance) => {
      if (heard.saveError) setBanner(clipSaveBanner(heard.saveError));
      await sendTurn(heard.text, {
        voiceTurnId: voiceTurnIdForMessage(heard),
        skipQingran: heard.skipQingran,
        nightNoise: heard.nightNoise,
        endpointFired: heard.endpointFired,
        sttDoneAt: heard.sttDoneAt,
        predictedTags: heard.predictedTags,
        engine: engineLineFromHeard(heard),
      });
    },
  });

  useEffect(() => {
    callActiveRef.current = call.active;
    hearRef.current = call.hear;
    deafenRef.current = call.deafen;
    setHearingSession({ mode: call.active ? "call" : "text" });
    if (call.active) {
      void detectAudioRoute().then((route) => setHearingSession({ audioRoute: route }));
    }
  }, [call.active, call.hear, call.deafen]);

  useEffect(() => {
    const open = Boolean(confirmId);
    confirmOpenRef.current = open;
    const action = micActionForConfirmPanel({
      panelOpen: open,
      wasOpen: confirmWasOpenRef.current,
      callActive: call.active,
      qingranSpeaking: status === "speaking" || status === "thinking",
    });
    confirmWasOpenRef.current = open;
    if (action === "deafen") call.deafen();
    else if (action === "hear") call.hear();
  }, [confirmId, call.active, call.deafen, call.hear, status]);

  useEffect(() => {
    if (!confirmId) {
      setConfirmAudioUrl((url) => {
        if (url) URL.revokeObjectURL(url);
        return null;
      });
      return;
    }
    const msg = chatRef.current.find((m) => m.id === confirmId);
    if (!msg?.voiceTurnId) return;
    let revoked = false;
    let url: string | null = null;
    setConfirmPredicted(msg.predictedTags ?? null);
    setConfirmGoldTags(null);
    setConfirmNoise(false);
    setConfirmMismatch(false);
    setConfirmNote("");
    setConfirmDraft(msg.text);
    setConfirmStt(msg.text);
    void getHearingTurnAudio({ data: { turnId: msg.voiceTurnId } }).then((result) => {
      if (!result.ok || revoked) return;
      const bytes = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
      setConfirmAudioUrl(url);
    });
    void getHearingClipLabel({ data: { turnId: msg.voiceTurnId } }).then((result) => {
      if (!result.ok || revoked) return;
      if (result.predictedTags) setConfirmPredicted(result.predictedTags);
      setConfirmGoldTags(result.goldTags);
      setConfirmNoise(Boolean(result.noiseOnly));
      setConfirmMismatch(Boolean(result.literalMismatch));
      setConfirmNote(result.toneNote ?? "");
      if (result.xaiText) setConfirmStt(result.xaiText);
      if (result.goldText) setConfirmDraft(result.goldText);
      else if (result.xaiText && msg.text === UNRECOGNIZED_TEXT) setConfirmDraft(result.xaiText);
    });
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [confirmId]);

  const finishHold = useCallback(async () => {
    if (finishingHoldRef.current) return;
    finishingHoldRef.current = true;
    try {
      stopPlayback();
      const heard = await voice.stop();
      stopPlayback();
      const el = getPlaybackElement();
      el.muted = false;
      setStatus("idle");
      if (heard.saveError) setBanner(clipSaveBanner(heard.saveError));
      if (heard.text) {
        void sendTurn(heard.text, {
          voiceTurnId: voiceTurnIdForMessage(heard),
          skipQingran: heard.skipQingran,
          nightNoise: heard.nightNoise,
          endpointFired: heard.endpointFired,
          sttDoneAt: heard.sttDoneAt,
          predictedTags: heard.predictedTags,
          engine: engineLineFromHeard(heard),
        });
      }
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
    stopPlayback();
    setComposerOpen(false);
    setEditingId(null);
    setBanner(null);
    await call.start();
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

  async function replyToNoise(id: string) {
    const current = chatRef.current.find((m) => m.id === id);
    if (!current?.nightNoise) return;
    const text = nightNoiseReplyText(current.text);
    const updated: ChatMessage = { ...current, text, kind: "say", nightNoise: false };
    await replayFrom(updated);
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
    const updated: ChatMessage = { ...current, text };
    setEditingId(null);
    abortRef.current?.abort();
    stopPlayback();
    const next = chatRef.current.map((m) => (m.id === updated.id ? updated : m));
    chatRef.current = next;
    setMessages(next);
    await persistUser(updated);
    await sendTurn(updated.text, {
      existingUser: updated,
      keepReplies: true,
      voiceTurnId: updated.voiceTurnId,
    });
  }

  function selectReply(userId: string, replyId: string) {
    const user = chatRef.current.find((m) => m.id === userId);
    if (!user || user.activeReply === replyId) return;
    const replies = chatRef.current.filter((m) => m.replyTo === userId);
    if (!replies.some((m) => m.id === replyId)) return;
    stopPlayback();
    const updated: ChatMessage = { ...user, activeReply: replyId };
    const next = chatRef.current.map((m) => (m.id === userId ? updated : m));
    chatRef.current = next;
    setMessages(next);
    void persistUser(updated);
  }

  async function replayFrom(updated: ChatMessage) {
    abortRef.current?.abort();
    stopPlayback();
    busyRef.current = true;
    const sliced = sliceAfterMessage(chatRef.current, updated.id);
    if (!sliced) {
      busyRef.current = false;
      return;
    }
    setMessages([...sliced.history, updated]);
    void updateRoomMessage({ data: updated });
    if (sliced.removed.length) {
      void deleteRoomMessages({ data: { ids: sliced.removed.map((m) => m.id) } });
    }
    await sendTurn(updated.text, {
      history: sliced.history,
      existingUser: updated,
      voiceTurnId: updated.voiceTurnId,
    });
  }

  async function saveConfirm(input: {
    goldText: string;
    source: "confirmed" | "edited";
    noiseOnly: boolean;
    literalMismatch: boolean;
    toneNote: string;
    goldTags: Partial<AcousticTags>;
    tagsTouched: TagKey[];
  }) {
    const msg = chatRef.current.find((m) => m.id === confirmId);
    if (!msg?.voiceTurnId) {
      confirmOpenRef.current = false;
      setConfirmId(null);
      return;
    }
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      const result = await confirmHearingClip({
        data: {
          turnId: msg.voiceTurnId,
          goldText: input.goldText,
          goldSource: input.source,
          noiseOnly: input.noiseOnly,
          literalMismatch: input.literalMismatch,
          toneNote: input.toneNote,
          goldTags: input.goldTags,
          tagsTouched: input.tagsTouched,
        },
      });
      if (!result.ok) {
        setConfirmError(result.error);
        return;
      }
      if (msg.hearingGold !== "confirmed") setLabeledCount((n) => n + 1);
      const plan = planConfirmSave(chatRef.current, msg, {
        goldText: input.goldText,
        noiseOnly: input.noiseOnly,
        events: input.goldTags.events,
      });
      const updated: ChatMessage = { ...plan.updated, hearingGold: "confirmed" };
      confirmOpenRef.current = false;
      setConfirmId(null);
      if (plan.shouldResend) {
        void replayFrom(updated);
      } else {
        if (plan.removed.length) {
          abortRef.current?.abort();
          abortRef.current = null;
          turnRef.current += 1;
          busyRef.current = false;
          stopPlayback();
          setStatus("idle");
          inflightRef.current = null;
          speakingIdRef.current = null;
          void deleteRoomMessages({ data: { ids: plan.removed.map((m) => m.id) } });
        }
        void updateRoomMessage({ data: updated });
        setMessages((prev) => {
          const drop = new Set(plan.removed.map((m) => m.id));
          return prev.filter((m) => !drop.has(m.id)).map((m) => (m.id === msg.id ? updated : m));
        });
      }
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirmBusy(false);
    }
  }

  async function saveConfirmQuick(id: string) {
    const msg = chatRef.current.find((m) => m.id === id);
    if (!msg?.voiceTurnId) return;
    setBanner(null);
    try {
      const result = await confirmHearingClip({
        data: {
          turnId: msg.voiceTurnId,
          goldText: msg.text,
          goldSource: "confirmed",
        },
      });
      if (!result.ok) {
        setBanner(result.error);
        return;
      }
      if (msg.hearingGold !== "confirmed") setLabeledCount((n) => n + 1);
      const updated: ChatMessage = { ...msg, hearingGold: "confirmed" };
      void updateRoomMessage({ data: updated });
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? updated : m)));
      armUndo(id);
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  function armUndo(id: string) {
    setUndoConfirmId(id);
    if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
    undoTimerRef.current = window.setTimeout(() => {
      setUndoConfirmId((cur) => (cur === id ? null : cur));
      undoTimerRef.current = 0;
    }, 5000);
  }

  async function undoConfirm(id: string) {
    const msg = chatRef.current.find((m) => m.id === id);
    if (!msg?.voiceTurnId) return;
    try {
      const result = await unlabelHearingByTurn({ data: { turnId: msg.voiceTurnId } });
      if (!result.ok) {
        setBanner(result.error);
        return;
      }
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = 0;
      setUndoConfirmId(null);
      if (msg.hearingGold === "confirmed") setLabeledCount((n) => Math.max(0, n - 1));
      const updated: ChatMessage = { ...msg, hearingGold: "unconfirmed" };
      void updateRoomMessage({ data: updated });
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? updated : m)));
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveReplyFlag(input: {
    messageId: string;
    replyTo?: string;
    note: string;
    rating: "up" | "down";
    tags: string[];
  }): Promise<boolean> {
    setFlagBusy(true);
    setFlagError(null);
    try {
      const result = await flagQingranReply({
        data: {
          messageId: input.messageId,
          replyToMessageId: input.replyTo,
          note: input.note,
          rating: input.rating,
          tags: input.tags,
        },
      });
      if (!result.ok) {
        if (input.rating === "up") setBanner(result.error);
        else setFlagError(result.error);
        return false;
      }
      if (input.rating === "down") setFlagTarget(null);
      return true;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (input.rating === "up") setBanner(text);
      else setFlagError(text);
      return false;
    } finally {
      setFlagBusy(false);
    }
  }

  function interruptQingran() {
    const plan = planInterruptQingran({
      speakingOrThinking: status === "speaking" || status === "thinking",
      callActive: call.active,
    });
    if (!plan) return;
    turnRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    if (plan.stopPlayback) stopPlayback();
    busyRef.current = false;
    setStatus("idle");
    const id = speakingIdRef.current ?? inflightRef.current?.id;
    const target =
      (id ? chatRef.current.find((m) => m.id === id) : undefined) ??
      [...chatRef.current].reverse().find((m) => m.role === "assistant");
    if (plan.markInterrupted && target?.role === "assistant") {
      pendingIdsRef.current.delete(target.id);
      const updated: ChatMessage = { ...target, interrupted: true };
      chatRef.current = chatRef.current.map((m) => (m.id === updated.id ? updated : m));
      setMessages(chatRef.current);
      void updateRoomMessage({ data: updated });
      void markTurnInterruptedFn({ data: { turnId: target.id } });
    }
    inflightRef.current = null;
    speakingIdRef.current = null;
    if (plan.hear) call.hear();
  }

  const recording = voice.status === "recording";
  const transcribing = voice.status === "transcribing";
  const editable = lastUserSay(messages);
  const composing = composerOpen && !recording && !call.active;
  const statusLine = call.active
    ? call.phase === "speaking-you"
      ? `在听你 · ${call.listenSec} 秒`
      : call.phase === "transcribing"
        ? "听你说的话"
        : status === "thinking"
          ? "她在想"
          : status === "speaking"
            ? "清然在说"
            : "你说，说完停两秒"
    : status === "thinking"
      ? "正在想"
      : "";

  return (
    <div
      className="room-bg fixed inset-x-0 flex flex-col overflow-hidden"
      style={{ top: viewport.offsetTop, height: viewport.height }}
    >
      <div className="mx-auto flex h-full min-h-0 w-full max-w-lg flex-col overflow-hidden">
        <header
          className="relative z-10 flex shrink-0 items-center justify-between bg-bg/80 px-5 pb-2 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-sm"
          onClick={() => transcriptRef.current?.pageUp()}
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <button
              type="button"
              aria-label={status === "speaking" || status === "thinking" ? "打断清然" : "清然"}
              className="grid size-11 shrink-0 place-items-center"
              onClick={(e) => {
                e.stopPropagation();
                interruptQingran();
              }}
            >
              <div
                className={cn(
                  "lamp-orb size-10 rounded-full",
                  status === "idle" && !recording && !call.active && "lamp-breathe",
                )}
                aria-hidden
              />
            </button>
            <button
              type="button"
              aria-label="往上看更早的对话"
              className="min-w-0 flex-1 text-left"
            >
              <p className="font-display text-lg font-medium leading-tight tracking-tight">清然</p>
              <p className="text-xs text-subtle">
                {profile.debugHearing
                  ? `已标 ${labeledCount} / 200`
                  : call.active
                    ? "通话中"
                    : "在"}
              </p>
              {profile.debugHearing ? (
                <p className="text-[10px] text-subtle/80">
                  {formatVoiceInjectLine(voiceInjectFromProfile(profile))}
                </p>
              ) : null}
              {profile.debugHearing && audioLog ? (
                <p className="max-w-[14rem] truncate text-[10px] text-subtle/80">{audioLog}</p>
              ) : null}
            </button>
          </div>
          <div
            className="flex items-center gap-1"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Button variant="ghost" size="icon" aria-label="日记" asChild>
              <Link to="/diary">
                <BookOpen className="size-5" />
              </Link>
            </Button>
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
              ref={transcriptRef}
              messages={messages}
              partnerName="清然"
              statusLine={statusLine}
              thinking={status === "thinking" || transcribing || call.phase === "transcribing"}
              editableId={editable?.id ?? null}
              editingId={editingId}
              editDraft={editDraft}
              debugHearing={profile.debugHearing}
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
                setEditDraft(stripAcousticTags(msg.text));
                setComposerOpen(false);
                setStatus("idle");
              }}
              onEditDraft={setEditDraft}
              onEditCancel={() => {
                setEditingId(null);
                if (call.active) call.hear();
              }}
              onEditSave={() => void saveEdit()}
              onSelectReply={selectReply}
              onConfirmStart={(id) => {
                const plan = planOpenConfirmPanel();
                skipAutoPlayRef.current = plan.skipAutoPlay;
                confirmOpenRef.current = true;
                if (plan.stopPlayback) stopPlayback();
                setConfirmError(null);
                setConfirmId(id);
              }}
              onConfirmQuick={(id) => void saveConfirmQuick(id)}
              onUndoConfirm={(id) => void undoConfirm(id)}
              undoConfirmId={undoConfirmId}
              onNoiseReply={(id) => void replyToNoise(id)}
              praisedIds={praisedIds}
              onFlagReply={(assistantId, replyToId, rating) => {
                if (rating === "up") {
                  if (flagBusy || praisedIds.has(assistantId)) return;
                  setPraisedIds((prev) => {
                    const next = new Set(prev);
                    next.add(assistantId);
                    return next;
                  });
                  void saveReplyFlag({
                    messageId: assistantId,
                    replyTo: replyToId,
                    note: "",
                    rating: "up",
                    tags: [],
                  }).then((ok) => {
                    if (ok) return;
                    setPraisedIds((prev) => {
                      const next = new Set(prev);
                      next.delete(assistantId);
                      return next;
                    });
                  });
                  return;
                }
                const reply = chatRef.current.find((m) => m.id === assistantId);
                const trigger = replyToId ? chatRef.current.find((m) => m.id === replyToId) : undefined;
                setFlagError(null);
                setFlagTarget({
                  messageId: assistantId,
                  replyTo: replyToId,
                  trigger: trigger?.text ?? "",
                  reply: reply?.text ?? "",
                });
              }}
            />

            {editingId ? null : (
            <footer className="relative z-10 shrink-0 bg-bg px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2">
              {(banner || voice.error || call.error) && (
                <p className="mb-3 text-center text-sm text-live">
                  {banner || voice.error || call.error}
                </p>
              )}
              {call.active || recording ? (
                <VolumeMeter
                  level={call.active ? call.level : voice.level}
                  threshold={call.active ? call.threshold : voice.threshold}
                />
              ) : null}
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
                      ? "点按钮挂断"
                      : call.phase === "speaking-you"
                        ? `在听 ${call.listenSec} 秒 · 音量 ${call.rms.toFixed(3)} / 保持 ${call.hold.toFixed(3)}`
                        : "通话中"
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

        <ConfirmTurn
          open={Boolean(confirmId)}
          sttText={confirmStt}
          initialDraft={confirmDraft}
          audioUrl={confirmAudioUrl}
          busy={confirmBusy}
          error={confirmError}
          initialPredicted={confirmPredicted}
          initialGoldTags={confirmGoldTags}
          initialNoise={confirmNoise}
          initialLiteralMismatch={confirmMismatch}
          initialToneNote={confirmNote}
          onClose={() => {
            confirmOpenRef.current = false;
            setConfirmId(null);
            setConfirmError(null);
          }}
          onConfirm={(input) => void saveConfirm(input)}
        />

        <FlagReply
          open={Boolean(flagTarget)}
          triggerText={flagTarget?.trigger}
          replyText={flagTarget?.reply}
          busy={flagBusy}
          error={flagError}
          onClose={() => {
            setFlagTarget(null);
            setFlagError(null);
          }}
          onSave={async ({ note, tags }) => {
            if (!flagTarget) return;
            await saveReplyFlag({
              messageId: flagTarget.messageId,
              replyTo: flagTarget.replyTo,
              note,
              rating: "down",
              tags,
            });
          }}
        />

        <SettingsDrawer
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          profile={profile}
          onSave={(next) => setProfile(lockedProfile(next))}
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

function VolumeMeter({ level, threshold }: { level: number; threshold: number }) {
  return (
    <div
      className="relative mb-3 h-1.5 w-full max-w-[12rem] overflow-hidden rounded-full bg-surface-2"
      aria-label="音量"
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-75"
        style={{ width: `${Math.min(100, Math.max(0, level * 100))}%` }}
      />
      <div
        className="absolute top-0 h-full w-0.5 bg-live"
        style={{ left: `${Math.min(100, Math.max(0, threshold * 100))}%` }}
        aria-label="阈值"
      />
    </div>
  );
}


