"use client";

import { useCallback, useRef, useState } from "react";
import { Mic, Loader2, Volume2 } from "lucide-react";
import type { AiBookContext } from "@pk-literature/contracts";
import { clientFetch } from "@/lib/api/client-fetch";
import { postAiAsr, postAiChat } from "@/lib/api/ai-bookseller";

// Spec: "~15-20s client-side cap ... Auto-stop and send if held past
// the cap, with a visible timer/progress ring."
const MAX_RECORDING_MS = 18_000;

// Same fallback line the backend itself returns on a circuit-breaker/
// service failure (ai-bookseller.service.ts) - used here only for a
// *frontend*-side failure (network error, thrown ApiError) the backend
// never got a chance to respond to at all.
const FALLBACK_LINE =
  "மன்னிக்கவும், இப்போது கொஞ்சம் புத்தகக்கடையில் கூட்டம் அதிகமாகிவிட்டது 😄. சிறிது நேரம் கழித்து மீண்டும் முயற்சி செய்யுங்கள்.";

type VoiceState = "idle" | "listening" | "thinking" | "speaking";

/**
 * Press-and-hold mic control for one /feed slide (ReelBookSlide) —
 * spec's "WhatsApp-style voice note pattern". Rendered only when this
 * slide is the one centered in the viewport (isActive, gated by
 * ReelsFeed's own IntersectionObserver) — every other slide's mic is
 * fully unmounted, not just disabled, per spec's "Availability" rule.
 *
 * Audio-in/audio-out only: no transcript, no chat bubble. The LLM's
 * text response is read aloud via the browser's Web Speech API
 * (speechSynthesis) — no server-side TTS model, matching spec's
 * explicit non-goal.
 *
 * NOT verified in a real browser from this sandbox (no way to exercise
 * MediaRecorder/getUserMedia/speechSynthesis here) - the state machine,
 * fetch calls, and cleanup are correct by inspection and mirror the
 * spec's exact API contracts, but the actual recording/playback
 * experience (especially Tamil speechSynthesis voice availability,
 * which spec itself calls "browser/OS-dependent... weaker on iOS
 * Safari") needs a real device pass before shipping.
 */
export function VoiceControl({ book, isActive }: { book: AiBookContext; isActive: boolean }) {
  const [state, setState] = useState<VoiceState>("idle");
  const [recordingMs, setRecordingMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  // One id per slide mount, resent with every /chat call so the (stateless)
  // Lambda/AI service can be handed a stable conversation_id — spec:
  // "Conversation memory: stateless server-side; frontend holds last
  // 6-8 turns and resends each request." History itself is NOT tracked
  // here yet (every request currently sends `history: []`): audio-only
  // interaction has no transcript to accumulate from without adding
  // speech-to-text-only round trips purely to build history the MVP's
  // one-shot "ask, get an answer" flow doesn't otherwise need. A
  // deliberate, spec-compatible simplification, not an oversight - the
  // request shape already supports passing real history whenever a
  // later phase wants multi-turn.
  const conversationIdRef = useRef(crypto.randomUUID());

  const cleanupStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const stopRecording = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop(); // onstop below does the rest
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (state !== "idle") return;
    setError(null);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access denied");
      return;
    }
    streamRef.current = stream;

    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };

    recorder.onstop = () => {
      cleanupStream();
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      void handleRecordingComplete(blob);
    };

    recorder.start();
    startedAtRef.current = Date.now();
    setState("listening");
    setRecordingMs(0);

    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      setRecordingMs(elapsed);
      if (elapsed >= MAX_RECORDING_MS) {
        stopRecording(); // auto-stop-and-send past the cap
      }
    }, 100);
  }, [state, cleanupStream, stopRecording]);

  async function handleRecordingComplete(blob: Blob) {
    setState("thinking");
    try {
      // Spec: "Never send failed/empty ASR output to the LLM."
      const asrResult = await postAiAsr(blob);
      if (asrResult.fallback || !asrResult.text) {
        speak(FALLBACK_LINE);
        return;
      }

      const chatResult = await postAiChat(clientFetch, {
        message: asrResult.text,
        book,
        conversationId: conversationIdRef.current,
        history: [],
      });

      speak(chatResult.response ?? FALLBACK_LINE);
    } catch {
      speak(FALLBACK_LINE);
    }
  }

  function speak(text: string) {
    setState("speaking");
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ta-IN";
    utterance.rate = 0.95;
    utterance.onend = () => setState("idle");
    utterance.onerror = () => setState("idle");
    window.speechSynthesis.cancel(); // clear anything queued from a fast repeat tap
    window.speechSynthesis.speak(utterance);
  }

  if (!isActive) return null; // fully unmounted, not just hidden - spec's own wording

  const progress = Math.min(recordingMs / MAX_RECORDING_MS, 1);
  const isBusy = state === "thinking" || state === "speaking";

  return (
    <div className="relative flex h-11 w-11 items-center justify-center">
      {state === "listening" && (
        <svg className="pointer-events-none absolute inset-0 -rotate-90" viewBox="0 0 44 44" aria-hidden="true">
          <circle cx="22" cy="22" r="20" fill="none" strokeWidth="2.5" className="stroke-background/40" />
          <circle
            cx="22"
            cy="22"
            r="20"
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={2 * Math.PI * 20}
            strokeDashoffset={2 * Math.PI * 20 * (1 - progress)}
            className="stroke-brand transition-[stroke-dashoffset] duration-100"
          />
        </svg>
      )}

      <button
        type="button"
        onMouseDown={startRecording}
        onMouseUp={stopRecording}
        onMouseLeave={() => state === "listening" && stopRecording()}
        onTouchStart={(event) => {
          event.preventDefault();
          void startRecording();
        }}
        onTouchEnd={stopRecording}
        disabled={isBusy}
        aria-label={
          state === "listening"
            ? "Recording — release to send"
            : state === "thinking"
              ? "Thinking"
              : state === "speaking"
                ? "Speaking"
                : "Hold to ask the bookseller"
        }
        className={`flex h-11 w-11 items-center justify-center rounded-full shadow-md backdrop-blur disabled:cursor-not-allowed ${
          state === "listening" ? "bg-brand text-brand-foreground" : "bg-background/90 text-foreground"
        }`}
      >
        {state === "thinking" ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : state === "speaking" ? (
          <Volume2 className="h-5 w-5" />
        ) : (
          <Mic className="h-5 w-5" />
        )}
      </button>

      {error && (
        <div className="absolute right-full mr-2 whitespace-nowrap rounded-md bg-background px-2 py-1 text-xs text-destructive shadow-md">
          {error}
        </div>
      )}
    </div>
  );
}
