import { BookOpen, ImagePlus, Settings, Volume2, VolumeX, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CallButton } from "@/components/lover/call-button";
import { FlagReply } from "@/components/lover/flag-reply";
import { MicButton } from "@/components/lover/mic-button";
import { SettingsDrawer } from "@/components/lover/settings-drawer";
import { Transcript, type TranscriptHandle } from "@/components/lover/transcript";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCall } from "@/hooks/use-call";
import { useHold, type Held } from "@/hooks/use-hold";
import { keepCaretVisible, useVisualViewportHeight } from "@/hooks/use-visual-viewport";
import { base64ToBytes, blobToBase64, concatBytes } from "@/lib/lover/audio";
import { listenAppLifecycle } from "@/lib/lover/audio-session";
import { warmBrain } from "@/lib/lover/brain/warm-client";
import { flagQingranReply } from "@/lib/lover/brain/turn-feedback-fn";
import { stripSoundTags } from "@/lib/lover/message-meta";
import {
  listenNative,
  nativeAddToCall,
  nativeInterruptCall,
  nativePlayClip,
  nativeSpeakTurn,
  nativeSpeakerStop,
  nativeTalkTurn,
  shellHolds,
  type VoiceNote,
} from "@/lib/lover/native-shell";
import { collapseReplyVariants, dropIncompleteReplies, sliceAfterMessage, unselectedReplyIds } from "@/lib/lover/pair-messages";
import { shrinkPhoto } from "@/lib/lover/photo-client";
import {
  enqueuePlayback,
  isRawPcm,
  kickAudio,
  playMp3Bytes,
  resumeAudio,
  sealPlayback,
  stopPlayback,
  unlockPlayback,
  whenPlaybackIdle,
} from "@/lib/lover/playback";
import { registerNativePush } from "@/lib/lover/push-client";
import {
  appendRoomMessage,
  clearRoomMessages,
  deleteRoomMessages,
  correctHisReply,
  loadRoom,
  readRoomMessage,
  saveProfilePatch,
  updateRoomMessage,
  uploadPhoto,
} from "@/lib/lover/room";
import { speakAsLover } from "@/lib/lover/server";
import { stripSpeechTags } from "@/lib/lover/speech-tags";
import { newId } from "@/lib/lover/storage";
import { streamTalk } from "@/lib/lover/talk-client";
import { classifyTalkException, TALK_FAIL, talkExceptionHint } from "@/lib/lover/talk-fail";
import { nextVoiceRate, snapVoiceRate } from "@/lib/lover/tts";
import { DEFAULT_PROFILE, lockedProfile, type ChatMessage, type Profile, type SessionStatus } from "@/lib/lover/types";
import type { FieldRevs } from "@/lib/lover/profile-patch";
import { cn } from "@/lib/utils";

/** Photos in one message. */
const MAX_PHOTOS = 4;

function lastUserSay(messages: ChatMessage[]): ChatMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "user") return msg;
  }
  return null;
}

/**
 * Her spoken lines not yet answered aloud, and the answer being written for them (requirements 第 7 节「一轮一轮」).
 * Until his voice starts, a new line of hers drops that answer and he answers all of them again; once he is heard
 * (or read, when he is muted) the round is over.
 */
type Round = { lines: ChatMessage[]; replyId: string | null };

/** His voice that came while she was saying a line; `done` once his whole reply is in. */
type HeldVoice = { turn: number; chunks: Array<{ bytes: Uint8Array<ArrayBuffer>; mime: string }>; done: boolean };

type SendOpts = {
  history?: ChatMessage[];
  existingUser?: ChatMessage;
  keepReplies?: boolean;
  images?: string[];
  /** A line she said (or typed in a call): asked as a round, with her earlier lines of it. */
  round?: { earlier: ChatMessage[]; voice?: VoiceNote };
};

export function VoiceRoom() {
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [revs, setRevs] = useState<FieldRevs>({ systemPrompt: 0, intimateNotes: 0, identity: 0 });
  const revsRef = useRef(revs);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [status, setStatus] = useState<SessionStatus>("idle");
  /** Where the shell's own turn is (a line she held, or one it speaks): thinking, speaking, idle. */
  const [shellPhase, setShellPhase] = useState("idle");
  const shellPhaseRef = useRef("idle");
  shellPhaseRef.current = shellPhase;
  const [draft, setDraft] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  /** Photos she is about to send: shown from `preview`, uploaded as soon as picked (`id` once saved). */
  const [photos, setPhotos] = useState<Array<{ key: string; preview: string; id: string | null }>>([]);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const busyRef = useRef(false);
  const turnRef = useRef(0);
  const statusRef = useRef<SessionStatus>("idle");
  const profileRef = useRef(profile);
  const chatRef = useRef<ChatMessage[]>([]);
  const userWriteRef = useRef<Promise<unknown>>(Promise.resolve());
  const settingsOpenRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const pendingIdsRef = useRef(new Set<string>());
  const inflightRef = useRef<{ id: string; createdAt: number; text: string } | null>(null);
  const speakingIdRef = useRef<string | null>(null);
  const skipAutoPlayRef = useRef(false);
  const spokenCacheRef = useRef(new Map<string, { bytes: Uint8Array<ArrayBuffer>; mimeType: string }>());
  const transcriptRef = useRef<TranscriptHandle>(null);
  const viewport = useVisualViewportHeight();
  const roundRef = useRef<Round>({ lines: [], replyId: null });
  /** His voice for the current turn has started. */
  const voiceOnRef = useRef(false);
  /** She is saying a line (holding, its words still coming in, or mid-line in a call): his voice waits for it. */
  const herLineRef = useRef(false);
  const heldRef = useRef<HeldVoice | null>(null);
  /** Typed (or said) in a browser call while he was speaking: sent when he is done. */
  const queuedRef = useRef<Array<{ text: string; voice?: VoiceNote }>>([]);
  /** Tapped while she was saying a line in a browser call: goes on its end. */
  const suffixRef = useRef("");
  const sayLineRef = useRef<(text: string, voice?: VoiceNote) => Promise<void>>(async () => undefined);
  const heardRef = useRef<(held: Held) => void>(() => undefined);
  const liveRef = useRef<(text: string) => void>(() => undefined);
  /** The reply her thumbs-down is on, while 差在哪 is open. */
  const [faultTarget, setFaultTarget] = useState<{ messageId: string; replyTo?: string; trigger: string; reply: string } | null>(null);
  const [faultBusy, setFaultBusy] = useState(false);
  const [faultError, setFaultError] = useState<string | null>(null);
  const [praiseBusy, setPraiseBusy] = useState(false);
  const [praisedIds, setPraisedIds] = useState<ReadonlySet<string>>(() => new Set());

  const hold = useHold({
    keyterms: profile.sttKeyterms,
    muted: profile.muted,
    onHeard: (held) => heardRef.current(held),
    onError: (message) => setBanner(message),
  });
  /** She is holding, or the words of a line she let go of are still coming (outside the shell). */
  const holdActive = hold.active;
  const call = useCall({
    wait: profile.silenceMs,
    keyterms: profile.sttKeyterms,
    onLine: (text) => void sayLineRef.current(text, { mode: "call" }),
    onLive: (text) => liveRef.current(text),
    onError: (message) => setBanner(message),
  });
  const callRef = useRef(call);
  callRef.current = call;
  statusRef.current = status;

  useEffect(() => {
    warmBrain();
  }, []);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);
  useEffect(() => {
    chatRef.current = messages;
  }, [messages]);
  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  const persistUser = (updated: ChatMessage) => {
    userWriteRef.current = userWriteRef.current
      .catch(() => undefined)
      .then(() => updateRoomMessage({ data: updated }));
    return userWriteRef.current;
  };

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
        if ("loadFailed" in room && room.loadFailed) {
          setHydrated(true);
          return;
        }
        setProfile(lockedProfile(room.profile));
        revsRef.current = room.revs ?? { systemPrompt: 0, intimateNotes: 0, identity: 0 };
        setRevs(revsRef.current);
        setMessages(room.messages);
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
    const applyRoom = (room: Awaited<ReturnType<typeof loadRoom>>) => {
      if ("loadFailed" in room && room.loadFailed) return;
      const next = lockedProfile(room.profile);
      profileRef.current = next;
      revsRef.current = room.revs ?? { systemPrompt: 0, intimateNotes: 0, identity: 0 };
      setProfile(next);
      setRevs(revsRef.current);
      setMessages(room.messages);
    };
    // Not while he is answering or she is mid-round (here or in the shell): the server does not have it yet, and
    // replacing the screen with its copy would drop what is being written.
    const midTurn = () =>
      busyRef.current ||
      pendingIdsRef.current.size > 0 ||
      roundRef.current.replyId !== null ||
      herLineRef.current ||
      shellPhaseRef.current === "thinking" ||
      shellPhaseRef.current === "speaking";
    const reload = () => {
      if (midTurn()) return;
      void loadRoom()
        .then((room) => {
          if (midTurn()) return;
          applyRoom(room);
        })
        .catch(() => undefined);
    };
    const onToken = (event: Event) => {
      void registerNativePush((event as CustomEvent).detail);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reload();
    };
    window.addEventListener("qingran-push-token", onToken);
    window.addEventListener("qingran-push", reload);
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", onVisible);
    // The shell's own turns (its calls, and lines she held in it): her lines, his words, and answers taken back.
    const stopNative = listenNative((event) => {
      if (event.type === "heard" && event.id && event.text) {
        const { id, text } = event;
        const at = event.at || Date.now();
        // Each line of her round is its own message; the same id again only replaces its text.
        setMessages((prev) =>
          prev.some((m) => m.id === id)
            ? prev.map((m) => (m.id === id ? { ...m, text } : m))
            : [...prev, { id, role: "user", text, createdAt: at, kind: "say" }],
        );
      } else if (event.type === "retract" && event.id) {
        // She went on before his voice started (or tapped him, hung up): the answer is dropped; the round is asked
        // again under a new id. It may already be saved (its request finished while held): she never heard it.
        const id = event.id;
        setMessages((prev) => prev.filter((m) => m.id !== id));
        void deleteRoomMessages({ data: { ids: [id] } }).catch(() => undefined);
      } else if (event.type === "speakFail" && event.text) {
        setBanner(event.text);
      } else if (event.type === "error" && event.text) {
        setBanner(event.text);
      } else if (event.type === "reply" && event.id && event.text) {
        const { id, text, replyTo } = event;
        setMessages((prev) => {
          const index = prev.findIndex((m) => m.id === id);
          if (index >= 0) {
            const next = prev.slice();
            next[index] = { ...next[index]!, text };
            return next;
          }
          return [...prev, { id, role: "assistant", text, createdAt: Date.now(), replyTo }];
        });
      } else if (event.type === "phase") {
        setShellPhase(event.phase);
      }
    });
    return () => {
      window.removeEventListener("qingran-push-token", onToken);
      window.removeEventListener("qingran-push", reload);
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", onVisible);
      stopNative();
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setInterval(() => {
      if (busyRef.current || settingsOpenRef.current || herLineRef.current || callRef.current.active) return;
      if (roundRef.current.replyId) return;
      void loadRoom().then((room) => {
        if ("loadFailed" in room && room.loadFailed) return;
        setMessages((prev) => (room.messages.length > prev.length ? room.messages : prev));
      });
    }, 15000);
    return () => window.clearInterval(timer);
  }, [hydrated]);

  useEffect(
    () =>
      listenAppLifecycle({
        onBackground: () => {
          // The page stops in the background; a browser call goes on only while the page is open.
          if (callRef.current.active) return;
          stopPlayback();
          turnRef.current += 1;
          busyRef.current = false;
          voiceOnRef.current = false;
          heldRef.current = null;
          // His answer still being written is left to finish and be saved (it shows when she is back); what she says
          // next is a new round.
          roundRef.current = { lines: [], replyId: null };
          setStatus((s) => (s === "speaking" || s === "thinking" ? "idle" : s));
        },
      }),
    [],
  );

  /** His voice is over (or was stopped): a browser call listens again, and a line she typed meanwhile goes now. */
  const afterHim = useCallback(() => {
    voiceOnRef.current = false;
    callRef.current.deaf(false);
    const next = queuedRef.current.shift();
    if (next) void sayLineRef.current(next.text, next.voice);
  }, []);

  /** His voice for this turn starts: the round is answered, and a browser call stops sending her mic. */
  const voiceStarts = useCallback(() => {
    if (voiceOnRef.current) return;
    voiceOnRef.current = true;
    roundRef.current = { lines: [], replyId: null };
    setStatus("speaking");
    callRef.current.deaf(true);
  }, []);

  /**
   * Her line turned out to have no words (or she dropped it): his voice that waited for it goes on, unless she is
   * already holding the next one (or its words are still coming).
   */
  const releaseVoice = useCallback(() => {
    herLineRef.current = holdActive();
    if (herLineRef.current) return;
    const held = heldRef.current;
    if (!held) return;
    heldRef.current = null;
    if (held.turn !== turnRef.current) return;
    voiceStarts();
    for (const chunk of held.chunks) enqueuePlayback(chunk.bytes, chunk.mime);
    if (!held.done) return;
    sealPlayback();
    // His request is over already, so nothing else waits for this voice to end.
    void whenPlaybackIdle().then(() => {
      if (held.turn !== turnRef.current) return;
      setStatus((s) => (s === "speaking" ? "idle" : s));
      afterHim();
    });
  }, [afterHim, holdActive, voiceStarts]);

  /** His answer to her round, not heard yet, is dropped (she went on): off the screen, and not kept. */
  const retractReply = useCallback((id: string) => {
    turnRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    heldRef.current = null;
    busyRef.current = false;
    pendingIdsRef.current.delete(id);
    if (inflightRef.current?.id === id) inflightRef.current = null;
    if (speakingIdRef.current === id) speakingIdRef.current = null;
    roundRef.current.replyId = null;
    chatRef.current = chatRef.current.filter((m) => m.id !== id);
    setMessages((prev) => prev.filter((m) => m.id !== id));
    void deleteRoomMessages({ data: { ids: [id] } }).catch(() => undefined);
  }, []);

  /**
   * She stopped him (tapped him, or started talking over him). What she already heard of his reply is kept; a reply
   * he was only thinking for her round is dropped, and her lines wait for what she says next.
   */
  const stopHim = useCallback(() => {
    const round = roundRef.current;
    if (round.replyId && !voiceOnRef.current) {
      retractReply(round.replyId);
      setStatus("idle");
      return;
    }
    const id = speakingIdRef.current ?? inflightRef.current?.id;
    turnRef.current += 1;
    // Once his voice has started, his request is left to finish so his whole reply is saved; before that it stops.
    if (!voiceOnRef.current) abortRef.current?.abort();
    abortRef.current = null;
    stopPlayback();
    heldRef.current = null;
    busyRef.current = false;
    setStatus("idle");
    const target =
      (id ? chatRef.current.find((m) => m.id === id) : undefined) ??
      [...chatRef.current].reverse().find((m) => m.role === "assistant");
    if (target?.role === "assistant" && target.text.trim()) {
      pendingIdsRef.current.delete(target.id);
      const updated: ChatMessage = { ...target, interrupted: true };
      chatRef.current = chatRef.current.map((m) => (m.id === updated.id ? updated : m));
      setMessages(chatRef.current);
      void updateRoomMessage({ data: updated }).catch(() => undefined);
    }
    inflightRef.current = null;
    speakingIdRef.current = null;
    afterHim();
  }, [afterHim, retractReply]);

  /** His voice for one line: the clip already heard if it covers the line, otherwise spoken again. */
  const clipFor = useCallback(async (id: string, speech: string) => {
    let clip = spokenCacheRef.current.get(id);
    if (clip && !streamAudioCovers([clip.bytes], stripSpeechTags(speech))) {
      spokenCacheRef.current.delete(id);
      clip = undefined;
    }
    if (clip) return clip;
    const spoken = await speakAsLover({ data: { text: speech, speed: profileRef.current.voiceSpeed } });
    if (!spoken.ok) return null;
    clip = { bytes: base64ToBytes(spoken.audioBase64), mimeType: spoken.mimeType };
    spokenCacheRef.current.set(id, clip);
    return clip;
  }, []);

  /** She pressed play on one of his lines (or his streamed voice did not cover the reply). */
  const playFull = useCallback(
    async (id: string, speech: string, turn: number) => {
      if (profileRef.current.muted) return;
      // In the shell's call the shell owns the speaker and the mic: the line is handed to it to speak.
      if (callRef.current.active && callRef.current.shell) {
        const clip = await clipFor(id, speech);
        if (!clip || !isRawPcm(clip.bytes, clip.mimeType)) return;
        if (!nativePlayClip({ audio: await blobToBase64(new Blob([clip.bytes])), mime: clip.mimeType })) {
          setBanner("电话里重播要重新用 Xcode 装一次；挂断后可以直接点。");
        }
        return;
      }
      speakingIdRef.current = id;
      stopPlayback();
      nativeSpeakerStop();
      setStatus("speaking");
      void unlockPlayback();
      void resumeAudio();
      voiceOnRef.current = true;
      callRef.current.deaf(true);
      try {
        const clip = await clipFor(id, speech);
        if (!clip || turn !== turnRef.current) return;
        const ok = await playMp3Bytes(clip.bytes, clip.mimeType);
        if (turn !== turnRef.current) return;
        if (!ok) setBanner("声音被浏览器拦住了，点喇叭再听。");
      } finally {
        if (turn === turnRef.current) {
          if (speakingIdRef.current === id) speakingIdRef.current = null;
          setStatus((s) => (s === "speaking" ? "idle" : s));
          afterHim();
        }
      }
    },
    [afterHim, clipFor],
  );

  const cycleVoiceSpeed = () => {
    const next = nextVoiceRate(profileRef.current.voiceSpeed);
    const updated = lockedProfile({ ...profileRef.current, voiceSpeed: next.speed });
    profileRef.current = updated;
    setProfile(updated);
    spokenCacheRef.current.clear();
    void saveProfilePatch({ data: { patch: { voiceSpeed: next.speed } } })
      .then((result) => {
        if (!result?.ok) return;
        revsRef.current = result.revs;
        setRevs(result.revs);
      })
      .catch(() => undefined);
    if (status !== "speaking" || callRef.current.shell) return;
    // What he is saying now is said again at the new speed (his reply is complete or nearly).
    const live = inflightRef.current;
    const last = [...chatRef.current].reverse().find((m) => m.role === "assistant");
    const speech = (live?.text || last?.text || "").trim();
    const id = live?.id || last?.id;
    if (!speech || !id) return;
    const turn = ++turnRef.current;
    busyRef.current = false;
    void playFull(id, speech, turn);
  };

  /** Pages of replies she did not keep are dropped before she says something new. */
  const commitChoice = useCallback(async () => {
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
  }, []);

  const sendTurn = useCallback(
    async (sayRaw: string, opts: SendOpts = {}) => {
      const say = sayRaw.trim();
      const images = opts.images ?? opts.existingUser?.images;
      if (!say && !images?.length) return;
      const at = Date.now();
      const userMsg: ChatMessage = opts.existingUser ?? {
        id: newId(),
        role: "user",
        text: say,
        createdAt: at,
        kind: "say",
        images: images?.length ? images : undefined,
      };
      if (!opts.existingUser && busyRef.current) return;
      if (!opts.existingUser) await commitChoice();
      const turn = ++turnRef.current;
      busyRef.current = true;
      voiceOnRef.current = false;
      heldRef.current = null;
      skipAutoPlayRef.current = false;
      stopPlayback();
      setBanner(null);
      setEditingId(null);

      const sourceHistory = opts.history ?? chatRef.current;
      const siblingFloor = (opts.keepReplies ? sourceHistory : []).reduce(
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
      if (opts.existingUser && opts.keepReplies) {
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
      } else if (opts.existingUser) {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === userMsg.id);
          const next = idx < 0 ? [...(opts.history ?? sourceHistory), userMsg, reply] : [...prev.slice(0, idx), userMsg, reply];
          chatRef.current = next;
          return next;
        });
      } else {
        chatRef.current = [...chatRef.current, userMsg, reply];
        setMessages(chatRef.current);
        void appendRoomMessage({ data: userMsg });
      }
      if (opts.round) roundRef.current.replyId = reply.id;
      pendingIdsRef.current.add(reply.id);
      inflightRef.current = { id: reply.id, createdAt: reply.createdAt, text: "" };
      speakingIdRef.current = reply.id;
      setStatus("thinking");
      void kickAudio();

      const earlier = opts.round?.earlier.map((m) => ({ id: m.id, text: m.text, at: m.createdAt }));
      const turnInput = {
        text: say,
        userMsgId: userMsg.id,
        userCreatedAt: userMsg.createdAt || at,
        replyId: reply.id,
        replyCreatedAt: reply.createdAt,
      };
      const handedOff = () => {
        pendingIdsRef.current.delete(reply.id);
        if (inflightRef.current?.id === reply.id) inflightRef.current = null;
        speakingIdRef.current = null;
        busyRef.current = false;
        // The shell answers it; whether she heard it is the shell's to know, so the round is over here.
        if (opts.round) roundRef.current = { lines: [], replyId: null };
        setStatus("idle");
      };
      // The shell's call runs this turn; its reply fills this message as it streams, and its phases drive the status.
      if (callRef.current.active && callRef.current.shell && nativeTalkTurn(turnInput)) {
        handedOff();
        return;
      }
      // Outside a call the shell asks and speaks this turn, so it goes on when she leaves the app.
      if (
        !callRef.current.active &&
        !profileRef.current.muted &&
        // No round here: the shell stops a turn when the next one comes, and what she heard of it must stay saved.
        nativeSpeakTurn({
          ...turnInput,
          images: userMsg.images,
          voice: opts.round?.voice,
          profile: { voiceSpeed: profileRef.current.voiceSpeed, muted: false },
        })
      ) {
        handedOff();
        return;
      }
      // In the shell's call only the shell may make a sound (a voice played by the page would be heard as her).
      const pageQuiet = callRef.current.active && callRef.current.shell;
      if (pageQuiet) setBanner("电话里改过的话，回复只有文字：要用 Xcode 重新装一次 App 才有声音。");

      let full = "";
      let answered = false;
      /** His streamed voice did not cover the reply: it is spoken again in one piece, whose end ends his turn. */
      let replaying = false;
      const clips: Uint8Array<ArrayBuffer>[] = [];
      let clipMime = "audio/pcm;rate=24000";
      let persistAt = 0;
      let paintHandle = 0;
      let latestDisplay = "";
      const persistReply = (text: string) => {
        inflightRef.current = { id: reply.id, createdAt: reply.createdAt, text };
      };
      const flushPaint = () => {
        paintHandle = 0;
        const display = latestDisplay;
        setMessages((prev) => prev.map((m) => (m.id === reply.id ? { ...m, text: display } : m)));
      };
      const paintText = (text: string, force = false) => {
        latestDisplay = stripSpeechTags(text);
        inflightRef.current = { id: reply.id, createdAt: reply.createdAt, text };
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
      /** His voice: played, or kept back while she is saying something. */
      const voice = (bytes: Uint8Array<ArrayBuffer>, mime: string) => {
        if (herLineRef.current && !voiceOnRef.current) {
          const kept = heldRef.current;
          const held: HeldVoice = kept && kept.turn === turn ? kept : { turn, chunks: [], done: false };
          held.chunks.push({ bytes, mime });
          heldRef.current = held;
          return;
        }
        voiceStarts();
        enqueuePlayback(bytes, mime);
      };
      try {
        const ac = new AbortController();
        abortRef.current = ac;
        await streamTalk(
          {
            ...turnInput,
            images: userMsg.images,
            profile: lockedProfile(profileRef.current),
            nowMs: Date.now(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            earlier,
            voice: opts.round?.voice
              ? { ...opts.round.voice, sec: opts.round.voice.mode === "call" ? callRef.current.takeSeconds() : opts.round.voice.sec }
              : undefined,
          },
          (event) => {
            if (turn !== turnRef.current) return;
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
              pendingIdsRef.current.delete(reply.id);
              if (inflightRef.current?.id === reply.id) inflightRef.current = null;
              const display = stripSpeechTags(full);
              answered = Boolean(display.trim());
              setMessages((prev) => prev.map((m) => (m.id === reply.id ? { ...reply, text: display } : m)));
              if (!answered) setBanner(TALK_FAIL.empty);
              if (heldRef.current?.turn === turn) heldRef.current.done = true;
              else sealPlayback();
              if (clips.length && streamAudioCovers(clips, display)) {
                spokenCacheRef.current.set(reply.id, { bytes: concatBytes(clips), mimeType: clipMime });
              } else {
                spokenCacheRef.current.delete(reply.id);
                // His voice did not come through whole: the reply is spoken again in one piece.
                if (answered && !pageQuiet && !profileRef.current.muted && !skipAutoPlayRef.current && !herLineRef.current) {
                  replaying = true;
                  void playFull(reply.id, full, turn);
                }
              }
              return;
            }
            if (event.t === "audio") {
              if (pageQuiet || profileRef.current.muted || skipAutoPlayRef.current) return;
              if (event.replace) {
                stopPlayback();
                clips.length = 0;
                if (heldRef.current?.turn === turn) heldRef.current.chunks = [];
                void unlockPlayback();
                void resumeAudio();
              }
              const bytes = base64ToBytes(event.b);
              clips.push(bytes);
              clipMime = event.m;
              voice(bytes, event.m);
              return;
            }
            if (event.t === "err") {
              persistReply(full);
              setBanner(event.code === "spend_breaker" ? "今日（或本月）费用异常，已暂停。可在设置中确认后继续。" : event.m);
              if (event.tts) {
                // His words are fine, only his voice failed: she reads this one.
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
        pendingIdsRef.current.delete(reply.id);
        if (turn === turnRef.current) {
          busyRef.current = false;
          if (opts.round && roundRef.current.replyId === reply.id) {
            // Answered in words only (no voice came): she has read it, so the round is over. Failed: her lines
            // stay and go with what she says next.
            if (answered && !heldRef.current) roundRef.current = { lines: [], replyId: null };
            else if (!answered) roundRef.current.replyId = null;
          }
          if (replaying) {
            // Spoken again in one piece (playFull): the end of that lets her be heard again.
          } else if (voiceOnRef.current) {
            // All of his voice is in: the player is told so, and his turn ends when it has played.
            sealPlayback();
            await whenPlaybackIdle();
            if (turn === turnRef.current) {
              setStatus("idle");
              afterHim();
            }
          } else if (!heldRef.current) {
            setStatus((s) => (s === "thinking" || s === "speaking" ? "idle" : s));
          }
        }
      }
    },
    [afterHim, commitChoice, playFull, voiceStarts],
  );

  /** A line she said (held, or in a browser call), or typed during a browser call: it joins her round. */
  const sayLine = useCallback(
    async (text: string, voice?: VoiceNote) => {
      const said = (text.trim() + suffixRef.current).trim();
      suffixRef.current = "";
      if (!said) {
        releaseVoice();
        return;
      }
      // She may already be holding the next line: then his answer to this one waits for it too.
      herLineRef.current = holdActive();
      if (voiceOnRef.current && statusRef.current === "speaking") {
        // He is speaking (only a line typed meanwhile gets here): it goes when he is done, as the next round.
        queuedRef.current.push({ text: said, voice });
        return;
      }
      const round = roundRef.current;
      if (round.replyId) retractReply(round.replyId);
      else if (!round.lines.length) await commitChoice();
      const line: ChatMessage = { id: newId(), role: "user", text: said, createdAt: Date.now(), kind: "say" };
      roundRef.current.lines.push(line);
      chatRef.current = [...chatRef.current, line];
      setMessages(chatRef.current);
      await sendTurn(said, { existingUser: line, round: { earlier: roundRef.current.lines.slice(0, -1), voice } });
    },
    [commitChoice, holdActive, releaseVoice, retractReply, sendTurn],
  );
  sayLineRef.current = sayLine;

  heardRef.current = (held: Held) => {
    if (held.text.trim()) void sayLine(held.text, held.voice);
    else releaseVoice();
  };

  liveRef.current = (text: string) => {
    if (text) herLineRef.current = true;
    else releaseVoice();
  };

  /** Her press: what he is saying stops; what he is still thinking waits to see if her line has words. */
  function holdStart() {
    if (callRef.current.active) return;
    setBanner(null);
    setComposerOpen(false);
    setEditingId(null);
    try {
      window.scrollTo(0, 0);
    } catch {
      /* ignore */
    }
    void unlockPlayback();
    if (!shellHolds()) {
      if (voiceOnRef.current || statusRef.current === "speaking") stopHim();
      // A typed line he is still thinking about is not part of a round: stopped, as when she taps him.
      else if (busyRef.current && !roundRef.current.replyId) stopHim();
      herLineRef.current = true;
      // An older iPhone shell speaking a typed line.
      nativeSpeakerStop();
    } else if (!busyRef.current) {
      // A line of his she is replaying on the page.
      stopPlayback();
    }
    hold.start();
  }

  function holdEnd() {
    hold.end();
  }

  function holdCancel() {
    hold.cancel();
    if (!shellHolds()) releaseVoice();
  }

  async function toggleCall() {
    if (call.active) {
      if (!call.shell) {
        // An answer he was still thinking for her round (or whose voice waited for her) is dropped: she hung up
        // before hearing it. Done before the call stops, whose end of her line would otherwise let that voice play.
        const round = roundRef.current;
        if (round.replyId && !voiceOnRef.current) retractReply(round.replyId);
        heldRef.current = null;
        roundRef.current = { lines: [], replyId: null };
      }
      call.hangup();
      setShellPhase("idle");
      if (!call.shell) {
        stopPlayback();
        turnRef.current += 1;
        busyRef.current = false;
        voiceOnRef.current = false;
        heldRef.current = null;
        herLineRef.current = false;
        queuedRef.current = [];
        suffixRef.current = "";
        setStatus("idle");
      }
      return;
    }
    if (hold.holding) hold.cancel();
    // He stops first (as when she taps him), so his voice is never in the room while the call listens.
    if (busyRef.current || voiceOnRef.current) stopHim();
    stopPlayback();
    nativeSpeakerStop();
    setComposerOpen(false);
    setEditingId(null);
    setBanner(null);
    await call.start();
  }

  /** A browser call: a phrase beside the hang-up button goes on the end of what she is saying, or on its own. */
  function tapPhrase(text: string) {
    if (!text) return;
    if (call.shell) {
      nativeAddToCall(text, true);
      return;
    }
    if (herLineRef.current) suffixRef.current += text;
    else void sayLine(text);
  }

  async function submitComposer() {
    const say = draft.trim();
    if (!say && !photos.length) return;
    // In a call a typed line joins her round, like a line she said; it waits while he is speaking.
    // (Photos are not sent during a call: the photo button is hidden then.)
    if (call.active && say && (!call.shell || nativeAddToCall(say))) {
      if (!call.shell) void sayLine(say);
      setDraft("");
      setComposerOpen(false);
      return;
    }
    if (status === "thinking" || status === "speaking") return;
    if (photos.some((p) => !p.id)) {
      setBanner("照片还在传，等一下。");
      return;
    }
    const images = photos.map((p) => p.id!);
    stopPlayback();
    setDraft("");
    setPhotos([]);
    setComposerOpen(false);
    // A typed line is its own turn: lines of hers left from a round that failed are in the talk already.
    roundRef.current = { lines: [], replyId: null };
    await sendTurn(say, { images });
  }

  async function addPhotos(files: FileList | null) {
    // One pick at a time (the button is off until this one is done), so the count below holds.
    const picked = Array.from(files ?? []).slice(0, Math.max(0, MAX_PHOTOS - photos.length));
    if (!picked.length) return;
    setPhotoBusy(true);
    for (const file of picked) {
      const key = newId();
      const preview = await shrinkPhoto(file).catch(() => null);
      if (!preview) {
        setBanner("这张照片打不开，换一张试试。");
        continue;
      }
      setPhotos((prev) => [...prev, { key, preview, id: null }]);
      try {
        const saved = await uploadPhoto({ data: { dataUrl: preview } });
        if (!saved.ok) throw new Error(saved.error);
        setPhotos((prev) => prev.map((p) => (p.key === key ? { ...p, id: saved.id } : p)));
      } catch (err) {
        setPhotos((prev) => prev.filter((p) => p.key !== key));
        setBanner(err instanceof Error && /[一-鿿]/.test(err.message) ? err.message : "照片没传上去，再试一次。");
      }
    }
    setPhotoBusy(false);
  }

  async function saveEdit() {
    const his = chatRef.current.find((m) => m.id === editingId && m.role === "assistant");
    if (his) {
      await saveHisEdit(his);
      return;
    }
    const current = chatRef.current.find((m) => m.id === editingId && m.role === "user");
    const text = editDraft.trim();
    if (!current || (!text && !current.images?.length)) return;
    if (text === stripSoundTags(current.text).trim()) {
      setEditingId(null);
      return;
    }
    roundRef.current = { lines: [], replyId: null };
    if (current.id !== lastUserSay(chatRef.current)?.id) {
      await branchFrom(current, text);
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
    await sendTurn(updated.text, { existingUser: updated, keepReplies: true });
  }

  /**
   * She corrected one of his replies (a wrong word, a voice tag he got wrong and keeps copying). It is saved in place:
   * nothing is answered again, and from now on he sees, and his voice reads, what she wrote. The old text is kept in
   * the message's edit history, and the correction counts as a thumbs-down holding before and after.
   */
  async function saveHisEdit(his: ChatMessage) {
    const text = editDraft.trim();
    setEditingId(null);
    if (!text || text === his.text.trim()) return;
    const updated: ChatMessage = { ...his, text };
    const next = chatRef.current.map((m) => (m.id === his.id ? updated : m));
    chatRef.current = next;
    setMessages(next);
    spokenCacheRef.current.delete(his.id);
    try {
      await correctHisReply({ data: updated });
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * She changed an earlier line (like editing a message in Claude): the talk goes back to that point. The old line
   * and everything after it are forgotten (kept in the database, gone from the screen and from what he sees), and the
   * new line is said now, as a new message, so he answers it with the time as it is.
   */
  async function branchFrom(original: ChatMessage, text: string) {
    const sliced = sliceAfterMessage(chatRef.current, original.id);
    if (!sliced) return;
    setEditingId(null);
    abortRef.current?.abort();
    turnRef.current += 1;
    stopPlayback();
    busyRef.current = true;
    const said: ChatMessage = {
      ...original,
      id: newId(),
      text,
      createdAt: Date.now(),
      kind: "say",
      nightNoise: undefined,
      activeReply: undefined,
      scanned: undefined,
    };
    chatRef.current = [...sliced.history, said];
    setMessages(chatRef.current);
    try {
      // The new line first, so a failure in between never loses what she said.
      await appendRoomMessage({ data: said });
      await deleteRoomMessages({ data: { ids: [original.id, ...sliced.removed.map((m) => m.id)] } });
    } catch (err) {
      busyRef.current = false;
      setBanner(err instanceof Error ? err.message : String(err));
      return;
    }
    await sendTurn(said.text, { history: sliced.history, existingUser: said });
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

  /** Her thumbs-down with 差在哪 (turn_feedback, rating down). Complaints she says to him in the chat go to qr_feedback at night. */
  async function faultReply(note: string, tags: string[]): Promise<void> {
    if (!faultTarget) return;
    setFaultBusy(true);
    setFaultError(null);
    try {
      const result = await flagQingranReply({
        data: { messageId: faultTarget.messageId, note, rating: "down", tags },
      });
      if (result.ok) setFaultTarget(null);
      else setFaultError(result.error);
    } catch (err) {
      setFaultError(err instanceof Error ? err.message : String(err));
    } finally {
      setFaultBusy(false);
    }
  }

  /** Her thumbs-up: this reply was good (turn_feedback, rating up). */
  async function praiseReply(messageId: string): Promise<boolean> {
    setPraiseBusy(true);
    try {
      const result = await flagQingranReply({ data: { messageId, note: "", rating: "up", tags: [] } });
      if (!result.ok) setBanner(result.error);
      return result.ok;
    } catch (err) {
      setBanner(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setPraiseBusy(false);
    }
  }

  /** She tapped him. */
  function interruptQingran() {
    // The shell's own turns (its call, and lines she held in it) are stopped by the shell.
    if ((call.active && call.shell) || (shellHolds() && shellPhase !== "idle")) {
      nativeInterruptCall();
      return;
    }
    nativeSpeakerStop();
    if (status !== "speaking" && status !== "thinking") return;
    stopHim();
  }

  const shellBusy = !call.active && shellHolds() && (shellPhase === "thinking" || shellPhase === "speaking");
  const thinkingNow = call.active && call.shell ? call.phase === "thinking" : status === "thinking" || (shellBusy && shellPhase === "thinking");
  const speakingNow = call.active && call.shell ? call.phase === "speaking" : status === "speaking" || (shellBusy && shellPhase === "speaking");
  // In the shell's call she can type, and tap a phrase on either side of the hang-up button.
  const callAdds = call.active && (!call.shell || nativeAddToCall(null));
  const composing = composerOpen && !hold.holding && (!call.active || callAdds);
  const liveLine = hold.holding || hold.finishing ? hold.live : call.active && call.live ? call.live : null;
  const statusLine = call.active
    ? call.live
      ? ""
      : thinkingNow
        ? "她在想"
        : speakingNow
          ? "清然在说"
          : call.shell && call.phase === "transcribing"
            ? "听你说的话"
            : "你说，我在听"
    : hold.holding
      ? ""
      : thinkingNow
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
              aria-label={speakingNow || thinkingNow ? "打断清然" : "清然"}
              className="grid size-11 shrink-0 place-items-center"
              onClick={(e) => {
                e.stopPropagation();
                interruptQingran();
              }}
            >
              <div
                className={cn(
                  "lamp-orb size-10 rounded-full",
                  status === "idle" && !hold.holding && !call.active && !shellBusy && "lamp-breathe",
                )}
                aria-hidden
              />
            </button>
            <button type="button" aria-label="往上看更早的对话" className="min-w-0 flex-1 text-left">
              <p className="font-display text-lg font-medium leading-tight tracking-tight">清然</p>
              <p className="text-xs text-subtle">{call.active ? "通话中" : "在"}</p>
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
              className={cn("text-xs", snapVoiceRate(profile.voiceSpeed).id !== "normal" && "text-live")}
              onClick={cycleVoiceSpeed}
            >
              {snapVoiceRate(profile.voiceSpeed).label}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={profile.muted ? "打开声音" : "关闭声音"}
              onClick={() => {
                const muted = !profileRef.current.muted;
                const next = lockedProfile({ ...profileRef.current, muted });
                profileRef.current = next;
                setProfile(next);
                void saveProfilePatch({ data: { patch: { muted } } })
                  .then((result) => {
                    if (!result?.ok) return;
                    revsRef.current = result.revs;
                    setRevs(result.revs);
                  })
                  .catch(() => undefined);
              }}
            >
              {profile.muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
            </Button>
            <Button variant="ghost" size="icon" aria-label="设置" onClick={() => setSettingsOpen(true)}>
              <Settings className="size-5" />
            </Button>
          </div>
        </header>

        {composing ? (
          <div className="flex min-h-0 flex-1 flex-col px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
            {banner ? <p className="mb-2 text-center text-sm text-live">{banner}</p> : null}
            <Textarea
              autoFocus
              enterKeyHint="send"
              value={draft}
              onChange={(e) => {
                if (!call.active) stopPlayback();
                setDraft(e.target.value);
                keepCaretVisible(e.currentTarget);
              }}
              onSelect={(e) => keepCaretVisible(e.currentTarget)}
              onFocus={(e) => {
                if (!call.active) stopPlayback();
                const box = e.currentTarget;
                window.setTimeout(() => {
                  window.scrollTo(0, 0);
                  keepCaretVisible(box);
                }, 50);
              }}
              placeholder="写给她"
              className="min-h-0 flex-1 resize-none"
            />
            {photos.length ? (
              <div className="mt-3 flex shrink-0 gap-2 overflow-x-auto">
                {photos.map((p) => (
                  <div key={p.key} className="relative shrink-0">
                    <img
                      src={p.preview}
                      alt=""
                      className={cn("size-16 rounded-md object-cover", p.id ? "" : "opacity-50")}
                    />
                    <button
                      type="button"
                      aria-label="不发这张"
                      onClick={() => setPhotos((prev) => prev.filter((x) => x.key !== p.key))}
                      className="absolute -right-1.5 -top-1.5 grid size-6 place-items-center rounded-full bg-surface-2 text-muted"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <input
              ref={photoInputRef}
              type="file"
              accept="image/jpeg,image/png,image/heic,image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                void addPhotos(e.currentTarget.files);
                e.currentTarget.value = "";
              }}
            />
            <div className="mt-3 flex shrink-0 items-center justify-between gap-3">
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  className="text-xs text-muted underline-offset-4 hover:underline"
                  onClick={() => setComposerOpen(false)}
                >
                  收起
                </button>
                {call.active ? null : (
                  <button
                    type="button"
                    aria-label="发照片"
                    disabled={photoBusy || photos.length >= MAX_PHOTOS}
                    onClick={() => photoInputRef.current?.click()}
                    className="grid size-11 place-items-center text-muted transition-colors duration-150 hover:text-fg disabled:opacity-30"
                  >
                    <ImagePlus className="size-5" />
                  </button>
                )}
              </div>
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
              thinking={thinkingNow}
              liveLine={liveLine}
              editingId={editingId}
              editDraft={editDraft}
              onPlay={(id, text) => {
                void unlockPlayback();
                // What he is saying or still thinking stops first, as when she taps him: only this line is heard.
                if (busyRef.current || voiceOnRef.current) stopHim();
                void playFull(id, text, turnRef.current);
              }}
              onEditStart={(id) => {
                const msg = messages.find((m) => m.id === id);
                if (!msg) return;
                // One of his replies: only the editor opens, with the words and voice tags as stored (the page
                // keeps a fresh reply without its tags). A reply not saved yet (still coming) cannot be changed.
                if (msg.role === "assistant") {
                  void readRoomMessage({ data: { id } })
                    .then((stored) => {
                      if (!stored) {
                        setBanner("他这句还没说完，说完再改。");
                        return;
                      }
                      const next = chatRef.current.map((m) => (m.id === id ? { ...m, text: stored.text } : m));
                      chatRef.current = next;
                      setMessages(next);
                      setEditingId(id);
                      setEditDraft(stored.text);
                      setComposerOpen(false);
                    })
                    .catch((err) => setBanner(err instanceof Error ? err.message : String(err)));
                  return;
                }
                // Changing her last line takes back his answer to it now. An earlier line only opens the editor:
                // what he is saying goes on until she saves.
                if (id === lastUserSay(chatRef.current)?.id && (status === "thinking" || status === "speaking")) stopHim();
                setEditingId(id);
                setEditDraft(stripSoundTags(msg.text));
                setComposerOpen(false);
              }}
              onEditDraft={setEditDraft}
              onEditCancel={() => setEditingId(null)}
              onEditSave={() => void saveEdit()}
              onSelectReply={selectReply}
              praisedIds={praisedIds}
              onPraiseReply={(assistantId) => {
                if (praiseBusy || praisedIds.has(assistantId)) return;
                setPraisedIds((prev) => new Set(prev).add(assistantId));
                void praiseReply(assistantId).then((ok) => {
                  if (ok) return;
                  setPraisedIds((prev) => {
                    const next = new Set(prev);
                    next.delete(assistantId);
                    return next;
                  });
                });
              }}
              onFaultReply={(assistantId, replyToId) => {
                const reply = chatRef.current.find((m) => m.id === assistantId);
                const trigger = replyToId ? chatRef.current.find((m) => m.id === replyToId) : undefined;
                setFaultError(null);
                setFaultTarget({ messageId: assistantId, replyTo: replyToId, trigger: trigger?.text ?? "", reply: reply?.text ?? "" });
              }}
            />

            {editingId ? null : (
              <footer className="relative z-10 shrink-0 bg-bg px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-2">
                {banner ? <p className="mb-3 text-center text-sm text-live">{banner}</p> : null}
                <div className="flex flex-col items-center gap-3">
                  {call.active ? (
                    <div className="flex w-full items-center justify-center">
                      {callAdds ? <TapPhrase text={profile.tapLeft} onTap={tapPhrase} /> : null}
                      <CallButton active onClick={() => void toggleCall()} />
                      {callAdds ? <TapPhrase text={profile.tapRight} onTap={tapPhrase} /> : null}
                    </div>
                  ) : (
                    <div className="flex w-full items-center gap-3">
                      <MicButton
                        busy={hold.finishing}
                        level={hold.level}
                        onHoldStart={holdStart}
                        onHoldEnd={holdEnd}
                        onHoldCancel={holdCancel}
                      />
                      <CallButton active={false} disabled={hold.holding} onClick={() => void toggleCall()} />
                    </div>
                  )}
                  {call.active && !callAdds ? null : (
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

        <FlagReply
          open={Boolean(faultTarget)}
          triggerText={faultTarget?.trigger}
          replyText={faultTarget?.reply}
          busy={faultBusy}
          error={faultError}
          onClose={() => {
            setFaultTarget(null);
            setFaultError(null);
          }}
          onSave={({ note, tags }) => faultReply(note, tags)}
        />

        <SettingsDrawer
          open={settingsOpen}
          onOpenChange={(nextOpen) => {
            setSettingsOpen(nextOpen);
            if (!nextOpen) return;
            void loadRoom()
              .then((room) => {
                if ("loadFailed" in room && room.loadFailed) return;
                const next = lockedProfile(room.profile);
                profileRef.current = next;
                revsRef.current = room.revs ?? { systemPrompt: 0, intimateNotes: 0, identity: 0 };
                setProfile(next);
                setRevs(revsRef.current);
              })
              .catch(() => undefined);
          }}
          profile={profile}
          revs={revs}
          callPhase={call.active ? call.phase : null}
          onPatch={(patch) => {
            setProfile((prev) => {
              const next = lockedProfile({ ...prev, ...patch });
              profileRef.current = next;
              return next;
            });
          }}
          onApply={(next, nextRevs) => {
            profileRef.current = next;
            revsRef.current = nextRevs;
            setProfile(next);
            setRevs(nextRevs);
          }}
          onClearChat={() => {
            setMessages([]);
            roundRef.current = { lines: [], replyId: null };
            const next = lockedProfile({ ...profileRef.current, memoryCursor: "" });
            profileRef.current = next;
            setProfile(next);
            void saveProfilePatch({ data: { patch: { memoryCursor: "" } } });
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

/** The space beside the hang-up button: a tap adds her phrase to what she is saying (or sends it on its own). */
function TapPhrase({ text, onTap }: { text: string; onTap: (text: string) => void }) {
  return (
    <button
      type="button"
      disabled={!text}
      className="flex h-24 min-w-0 flex-1 items-center justify-center rounded-2xl px-2 text-sm text-subtle select-none active:bg-surface-2"
      onClick={() => onTap(text)}
    >
      <span className="truncate">{text}</span>
    </button>
  );
}
