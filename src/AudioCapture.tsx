/**
 * AudioCapture.tsx  (Asynchronous Polling + Wake Lock Update)
 *
 * Implements a "drop-off and pickup" polling architecture to bypass 
 * mobile browser timeout limits for long clinical recordings.
 * Uses the Screen Wake Lock API to prevent mobile devices from sleeping.
 */

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import NoteEditor, { type SoapNote } from "./NoteEditor";

// ─── Types ────────────────────────────────────────────────────────────────────

type RecorderStatus = "idle" | "recording" | "paused" | "processing" | "error";

interface State {
  status: RecorderStatus;
  elapsedSeconds: number;
  errorMessage: string | null;
}

type Action =
  | { type: "START" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "TICK" }
  | { type: "PROCESS" }
  | { type: "ERROR"; message: string }
  | { type: "RESET" };

// ─── Reducer ──────────────────────────────────────────────────────────────────

const initialState: State = {
  status: "idle",
  elapsedSeconds: 0,
  errorMessage: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "START":   return { ...initialState, status: "recording" };
    case "PAUSE":   return { ...state, status: "paused" };
    case "RESUME":  return { ...state, status: "recording" };
    case "TICK":    return { ...state, elapsedSeconds: state.elapsedSeconds + 1 };
    case "PROCESS": return { ...state, status: "processing" };
    case "ERROR":   return { ...state, status: "error", errorMessage: action.message };
    case "RESET":   return initialState;
    default:        return state;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function getBestMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

// ─── Loading Dots ─────────────────────────────────────────────────────────────

function LoadingDots() {
  return (
    <span className="inline-flex items-end gap-[3px] ml-1 mb-[1px]">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="block w-[3px] h-[3px] rounded-full bg-current animate-bounce"
          style={{ animationDelay: `${i * 0.15}s`, animationDuration: "0.9s" }}
        />
      ))}
    </span>
  );
}

// ─── Waveform ─────────────────────────────────────────────────────────────────

function Waveform({ analyser, active }: { analyser: AnalyserNode | null; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef    = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width;
    const H = canvas.height;

    if (!active || !analyser) {
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(180,180,175,0.35)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();
      return;
    }

    const bufferLength = analyser.frequencyBinCount;
    const dataArray    = new Uint8Array(bufferLength);

    function draw() {
      rafRef.current = requestAnimationFrame(draw);
      analyser!.getByteTimeDomainData(dataArray);
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(220, 38, 38, 0.75)";
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      const sliceWidth = W / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * H) / 2;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.lineTo(W, H / 2);
      ctx.stroke();
    }

    draw();
    return () => cancelAnimationFrame(rafRef.current);
  }, [analyser, active]);

  return <canvas ref={canvasRef} width={480} height={52} className="w-full h-full" />;
}

// ─── AudioCapture ─────────────────────────────────────────────────────────────

const API_BASE_URL = "https://metromind-ambient-api.onrender.com/api";

export default function AudioCapture() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { status, elapsedSeconds, errorMessage } = state;

  const [noteData, setNoteData] = useState<SoapNote | null>(null);

  // Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef        = useRef<Blob[]>([]);
  const streamRef        = useRef<MediaStream | null>(null);
  const tickerRef        = useRef<ReturnType<typeof setInterval>>();
  const pollIntervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLockRef      = useRef<any>(null);

  // Web Audio
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  // ── Wake Lock Management ────────────────────────────────────────────────────
  
  const requestWakeLock = async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        console.log("Screen Wake Lock active.");
      }
    } catch (err) {
      console.warn("Wake Lock denied or not supported.", err);
    }
  };

  const releaseWakeLock = async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
        console.log("Screen Wake Lock released.");
      } catch (err) {
        console.error(err);
      }
    }
  };

  // ── Cleanup ───────────────────────────────────────────────────────────────

  const teardownStream = useCallback(() => {
    if (tickerRef.current) clearInterval(tickerRef.current);
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    audioCtxRef.current?.close();
    releaseWakeLock();
    streamRef.current  = null;
    audioCtxRef.current = null;
    setAnalyser(null);
  }, []);

  useEffect(() => () => teardownStream(), [teardownStream]);

  // ── ASYNC: POST & Poll ────────────────────────────────────────────────────

  const submitAudio = useCallback(async (blob: Blob) => {
    dispatch({ type: "PROCESS" });
    try {
      const form = new FormData();
      const ext  = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "mp4" : "webm";
      form.append("audio", blob, `session.${ext}`);

      // 1. The Drop-off (Get Ticket)
      const res = await fetch(`${API_BASE_URL}/transcribe`, { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }

      const { jobId } = await res.json();
      if (!jobId) throw new Error("No Job ID returned from server.");
      
      console.log(`Audio dropped off successfully. Polling Job: ${jobId}`);

      // 2. The Pickup (Poll every 5 seconds)
      pollIntervalRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(`${API_BASE_URL}/job/${jobId}`);
          if (!statusRes.ok) throw new Error("Failed to check job status");

          const jobData = await statusRes.json();

          if (jobData.status === "completed") {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            console.log("✅ Psychiatric SOAP Note JSON:", jobData.result);
            setNoteData(jobData.result);
          } else if (jobData.status === "failed") {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            dispatch({ type: "ERROR", message: jobData.error || "AI processing failed. Please try again." });
          }
          // If status is "processing", we just wait for the next 5-second tick...
        } catch (err) {
          console.error("Polling error:", err);
          if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
          dispatch({ type: "ERROR", message: err instanceof Error ? err.message : "Polling failed." });
        }
      }, 5000);

    } catch (err) {
      dispatch({
        type: "ERROR",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, []);

  // ── Start ─────────────────────────────────────────────────────────────────

  const handleStart = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current  = stream;
      chunksRef.current  = [];

      await requestWakeLock(); // Prevent mobile screen from turning off

      const audioCtx = new AudioContext();
      const source   = audioCtx.createMediaStreamSource(stream);
      const an       = audioCtx.createAnalyser();
      an.fftSize = 2048;
      source.connect(an);
      audioCtxRef.current = audioCtx;
      setAnalyser(an);

      const mimeType = getBestMimeType();
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(250);
      mediaRecorderRef.current = mr;

      dispatch({ type: "START" });
      tickerRef.current = setInterval(() => dispatch({ type: "TICK" }), 1000);
    } catch {
      dispatch({ type: "ERROR", message: "Microphone access denied. Please allow microphone permissions." });
    }
  }, []);

  // ── Pause / Resume ────────────────────────────────────────────────────────

  const handlePauseResume = useCallback(() => {
    const mr = mediaRecorderRef.current;
    if (!mr) return;
    if (status === "recording") {
      mr.pause();
      if (tickerRef.current) clearInterval(tickerRef.current);
      dispatch({ type: "PAUSE" });
    } else if (status === "paused") {
      mr.resume();
      tickerRef.current = setInterval(() => dispatch({ type: "TICK" }), 1000);
      dispatch({ type: "RESUME" });
    }
  }, [status]);

  // ── Stop & Process ────────────────────────────────────────────────────────

  const handleStop = useCallback(() => {
    const mr = mediaRecorderRef.current;
    if (!mr) return;
    if (tickerRef.current) clearInterval(tickerRef.current);
    mr.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
      chunksRef.current = [];
      teardownStream();
      submitAudio(blob);
    };
    mr.stop();
  }, [submitAudio, teardownStream]);

  // ── Reset ─────────────────────────────────────────────────────────────────

  const handleReset = useCallback(() => {
    teardownStream();
    setNoteData(null);
    dispatch({ type: "RESET" });
  }, [teardownStream]);

  // ── Swap to NoteEditor once data arrives ──────────────────────────────────

  if (noteData) {
    return <NoteEditor data={noteData} onNewSession={handleReset} />;
  }

  // ── Derived booleans ──────────────────────────────────────────────────────

  const isActive     = status === "recording" || status === "paused";
  const isRecording  = status === "recording";
  const isProcessing = status === "processing";
  const isError      = status === "error";
  const isIdle       = status === "idle";

  // ── Render: recorder card ─────────────────────────────────────────────────

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&family=DM+Mono:wght@400;500&display=swap');
        .audio-capture-root * { font-family: 'DM Sans', sans-serif; }
        .mono { font-family: 'DM Mono', monospace; }
        @keyframes pulse-ring {
          0%   { transform: scale(1);   opacity: 0.6; }
          70%  { transform: scale(1.9); opacity: 0;   }
          100% { transform: scale(1);   opacity: 0;   }
        }
        .pulse-ring::before {
          content: '';
          position: absolute;
          inset: 0;
          border-radius: 9999px;
          background: #dc2626;
          animation: pulse-ring 1.4s ease-out infinite;
        }
        @keyframes fade-in-up {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .fade-in-up { animation: fade-in-up 0.35s ease both; }
        @keyframes shimmer {
          0%   { background-position: -200% center; }
          100% { background-position:  200% center; }
        }
        .shimmer-text {
          background: linear-gradient(90deg, #6b7280 30%, #111 50%, #6b7280 70%);
          background-size: 200% auto;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
          animation: shimmer 2.2s linear infinite;
        }
      `}</style>

      <div className="audio-capture-root min-h-screen bg-[#f9f9f8] flex items-center justify-center p-6">
        <div className="w-full max-w-md fade-in-up">
          <div className="bg-white border border-[#e8e8e5] rounded-2xl shadow-[0_2px_24px_rgba(0,0,0,0.06)] overflow-hidden">

            {/* Header */}
            <div className="px-7 pt-7 pb-5 border-b border-[#f0f0ed]">
              <p className="text-[10px] font-bold tracking-[0.2em] text-[#179ea1] uppercase mb-1">
                Metro Mind • Clinical
              </p>
              <h1 className="text-[1.35rem] font-[500] text-[#2c3d3a] leading-snug">
                Ambient AI Scribe
              </h1>
            </div>

            {/* Body */}
            <div className="px-7 py-6 space-y-6">

              {/* Status row */}
              <div className="flex items-center justify-between h-7">
                <div className="flex items-center gap-2.5">
                  {isRecording ? (
                    <span className="relative flex items-center justify-center w-3 h-3 pulse-ring">
                      <span className="relative block w-3 h-3 rounded-full bg-[#dc2626]" />
                    </span>
                  ) : (
                    <span className={`block w-2.5 h-2.5 rounded-full transition-colors duration-300 ${
                      status === "paused" ? "bg-amber-400"            :
                      isError             ? "bg-red-500"               :
                      isProcessing       ? "bg-blue-400 animate-pulse":
                      "bg-[#d4d4cf]"
                    }`} />
                  )}
                  <span className={`text-[13px] font-[450] tracking-wide ${
                    isRecording         ? "text-[#dc2626]"  :
                    status === "paused" ? "text-amber-600"  :
                    isError             ? "text-red-600"    :
                    isProcessing        ? "text-blue-600"   :
                    "text-[#9b9b93]"
                  }`}>
                    {isRecording         && "Recording"}
                    {status === "paused" && "Paused"}
                    {isIdle              && "Ready"}
                    {isProcessing        && "Processing"}
                    {isError             && "Error"}
                  </span>
                </div>
                <span className={`mono text-[1.2rem] font-[500] tabular-nums transition-colors duration-300 ${
                  isRecording ? "text-[#111]" : isActive ? "text-[#555]" : "text-[#ccc]"
                }`}>
                  {formatTime(elapsedSeconds)}
                </span>
              </div>

              {/* Waveform */}
              <div className={`rounded-xl h-14 overflow-hidden transition-all duration-500 ${
                isActive
                  ? "bg-[#fdf1f1] border border-[#fad0d0]"
                  : "bg-[#f5f5f3] border border-[#ebebea]"
              }`}>
                <Waveform analyser={analyser} active={isRecording} />
              </div>

              {/* Processing banner */}
              {isProcessing && (
                <div className="fade-in-up rounded-xl bg-[#f5f7ff] border border-[#dde3ff] px-5 py-4">
                  <p className="text-[13px] font-[500] text-[#3d4eac] flex items-center">
                    <span className="shimmer-text">Analyzing clinical context</span>
                    <LoadingDots />
                  </p>
                  <p className="text-[11.5px] text-[#8b93c9] mt-1 leading-relaxed">
                    Generating structured SOAP note via Gemini. Long sessions may
                    take a few minutes — please keep this window open.
                  </p>
                </div>
              )}

              {/* Error banner */}
              {isError && (
                <div className="fade-in-up rounded-xl bg-[#fff4f4] border border-[#fecaca] px-5 py-4">
                  <p className="text-[13px] font-[500] text-[#b91c1c]">Something went wrong</p>
                  <p className="text-[11.5px] text-[#d97b7b] mt-1 break-words">{errorMessage}</p>
                </div>
              )}

              {/* Controls */}
              <div className="flex items-center gap-2.5 pt-1">
                {isIdle && (
                  <button
                    onClick={handleStart}
                    className="fade-in-up flex-1 flex items-center justify-center gap-2 bg-gradient-to-r from-[#179ea1] to-[#4bcba2] hover:from-[#14898c] hover:to-[#41af8c] shadow-md shadow-[#179ea1]/20 text-white text-[13px] font-[600] tracking-wide rounded-xl h-11 transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#179ea1]"
                  >
                    <MicIcon /> Start Recording
                  </button>
                )}
                {isActive && (
                  <button
                    onClick={handlePauseResume}
                    className={`flex items-center justify-center gap-2 text-[13px] font-[500] tracking-wide rounded-xl h-11 w-36 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 border ${
                      isRecording
                        ? "border-[#e8e8e5] text-[#555] hover:bg-[#f5f5f3] focus:ring-[#aaa]"
                        : "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 focus:ring-amber-300"
                    }`}
                  >
                    {isRecording ? <><PauseIcon /> Pause</> : <><MicIcon /> Resume</>}
                  </button>
                )}
                {isActive && (
                  <button
                    onClick={handleStop}
                    className="flex-1 flex items-center justify-center gap-2 bg-[#dc2626] hover:bg-[#b91c1c] text-white text-[13px] font-[500] tracking-wide rounded-xl h-11 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-400"
                  >
                    <StopIcon /> Stop &amp; Process
                  </button>
                )}
                {isError && (
                  <button
                    onClick={handleReset}
                    className="fade-in-up flex-1 flex items-center justify-center gap-2 border border-[#e8e8e5] text-[#555] hover:bg-[#f5f5f3] text-[13px] font-[500] tracking-wide rounded-xl h-11 transition-colors duration-150 focus:outline-none"
                  >
                    Try Again
                  </button>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="px-7 pb-5">
              <p className="text-[10.5px] text-[#bbb] leading-relaxed">
                Audio is processed securely via background polling. Screen wake lock is active to prevent session interruption.
              </p>
            </div>
          </div>

          {isActive && (
            <p className="fade-in-up mono text-center text-[11px] text-[#b0b0a8] mt-4 tabular-nums">
              Session in progress · {formatTime(elapsedSeconds)} elapsed
            </p>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" y1="19" x2="12" y2="23"/>
      <line x1="8"  y1="23" x2="16" y2="23"/>
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="1"/>
      <rect x="14" y="4" width="4" height="16" rx="1"/>
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2"/>
    </svg>
  );
}