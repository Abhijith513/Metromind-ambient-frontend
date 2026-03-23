import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import NoteEditor, { type SoapNote } from "./NoteEditor";

type RecorderStatus =
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  | "uploading_segment"
  | "finalizing"
  | "processing"
  | "error";

interface State {
  status: RecorderStatus;
  elapsedSeconds: number;
  errorMessage: string | null;
}

type Action =
  | { type: "STARTING" }
  | { type: "START" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "TICK" }
  | { type: "UPLOADING_SEGMENT" }
  | { type: "FINALIZING" }
  | { type: "PROCESS" }
  | { type: "ERROR"; message: string }
  | { type: "RESET" };

const initialState: State = {
  status: "idle",
  elapsedSeconds: 0,
  errorMessage: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "STARTING":
      return { ...initialState, status: "starting" };
    case "START":
      return { ...state, status: "recording", errorMessage: null };
    case "PAUSE":
      return { ...state, status: "paused" };
    case "RESUME":
      return { ...state, status: "recording" };
    case "TICK":
      return { ...state, elapsedSeconds: state.elapsedSeconds + 1 };
    case "UPLOADING_SEGMENT":
      return { ...state, status: "uploading_segment" };
    case "FINALIZING":
      return { ...state, status: "finalizing" };
    case "PROCESS":
      return { ...state, status: "processing" };
    case "ERROR":
      return { ...state, status: "error", errorMessage: action.message };
    case "RESET":
      return initialState;
    default:
      return state;
  }
}

function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

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

function Waveform({
  analyser,
  active,
}: {
  analyser: AnalyserNode | null;
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

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
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
      rafRef.current = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(dataArray);
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(220, 38, 38, 0.75)";
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.beginPath();

      const sliceWidth = W / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i += 1) {
        const v = dataArray[i] / 128.0;
        const y = (v * H) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }

      ctx.lineTo(W, H / 2);
      ctx.stroke();
    }

    draw();

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [analyser, active]);

  return <canvas ref={canvasRef} width={480} height={52} className="w-full h-full" />;
}

const BACKEND_BASE =
  import.meta.env.VITE_BACKEND_BASE_URL?.replace(/\/+$/, "") ||
  "https://metromind-ambient-api.onrender.com/api";

const SEGMENT_DURATION_MS = 30000;

export default function AudioCapture() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { status, elapsedSeconds, errorMessage } = state;

  const [noteData, setNoteData] = useState<SoapNote | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const activeRecorderRef = useRef<MediaRecorder | null>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const tickerRef = useRef<number | null>(null);
  const segmentTimerRef = useRef<number | null>(null);
  const currentSegmentChunksRef = useRef<Blob[]>([]);
  const segmentIndexRef = useRef<number>(0);
  const stoppingRef = useRef<boolean>(false);
  const pausedRef = useRef<boolean>(false);
  const currentMimeTypeRef = useRef<string>("audio/webm");

  const clearTimers = useCallback(() => {
    if (tickerRef.current !== null) {
      window.clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
    if (segmentTimerRef.current !== null) {
      window.clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }
  }, []);

  const teardownStream = useCallback(() => {
    clearTimers();
    activeStreamRef.current?.getTracks().forEach((t) => t.stop());
    activeStreamRef.current = null;
    activeRecorderRef.current = null;
    currentSegmentChunksRef.current = [];
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setAnalyser(null);
  }, [clearTimers]);

  useEffect(() => {
    return () => teardownStream();
  }, [teardownStream]);

  const createSession = useCallback(async (): Promise<string> => {
    const res = await fetch(`${BACKEND_BASE}/sessions`, {
      method: "POST",
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error ?? "Failed to create session.");
    }

    const json = (await res.json()) as { sessionId: string };
    return json.sessionId;
  }, []);

  const uploadSegment = useCallback(
    async (sessionId: string, blob: Blob, segmentIndex: number) => {
      const form = new FormData();
      const ext = blob.type.includes("ogg")
        ? "ogg"
        : blob.type.includes("mp4")
        ? "mp4"
        : "webm";

      form.append("audio", blob, `segment-${segmentIndex}.${ext}`);
      form.append("segmentIndex", String(segmentIndex));

      const res = await fetch(`${BACKEND_BASE}/sessions/${sessionId}/segments`, {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? "Failed to upload segment.");
      }
    },
    []
  );

  const finalizeSession = useCallback(async (sessionId: string) => {
    const res = await fetch(`${BACKEND_BASE}/sessions/${sessionId}/finalize`, {
      method: "POST",
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error ?? "Failed to finalize session.");
    }
  }, []);

  const pollForResult = useCallback(async (sessionId: string): Promise<SoapNote> => {
    for (;;) {
      const res = await fetch(`${BACKEND_BASE}/sessions/${sessionId}/result`);

      if (res.status === 409) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? "Failed to fetch result.");
      }

      return (await res.json()) as SoapNote;
    }
  }, []);

  const scheduleSegmentRotation = useCallback(() => {
    if (pausedRef.current || stoppingRef.current) return;

    segmentTimerRef.current = window.setTimeout(async () => {
      const sessionId = sessionIdRef.current;
      if (!sessionId || pausedRef.current || stoppingRef.current) return;

      try {
        dispatch({ type: "UPLOADING_SEGMENT" });
        await stopCurrentSegmentAndContinue(false);
        if (!pausedRef.current && !stoppingRef.current) {
          dispatch({ type: "START" });
          scheduleSegmentRotation();
        }
      } catch (error) {
        dispatch({
          type: "ERROR",
          message:
            error instanceof Error ? error.message : "Failed to rotate audio segment.",
        });
      }
    }, SEGMENT_DURATION_MS);
  }, []);

  const startTicker = useCallback(() => {
    if (tickerRef.current !== null) {
      window.clearInterval(tickerRef.current);
    }

    tickerRef.current = window.setInterval(() => {
      if (!pausedRef.current && !stoppingRef.current) {
        dispatch({ type: "TICK" });
      }
    }, 1000);
  }, []);

  const startSegmentRecorder = useCallback(
    async (stream: MediaStream, mimeType: string) => {
      currentSegmentChunksRef.current = [];

      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

      mr.ondataavailable = (e: BlobEvent) => {
        if (e.data.size > 0) {
          currentSegmentChunksRef.current.push(e.data);
        }
      };

      activeRecorderRef.current = mr;
      mr.start();
    },
    []
  );

  const pendingUploadsRef = useRef<Promise<void>[]>([]);

  const stopCurrentSegmentAndContinue = useCallback(
    async (finalSegment: boolean) => {
      const mr = activeRecorderRef.current;
      const sessionId = sessionIdRef.current;
      const mimeType = currentMimeTypeRef.current || "audio/webm";

      if (!mr || !sessionId) return;

      const currentIndex = segmentIndexRef.current;

      const blob = await new Promise<Blob>((resolve, reject) => {
        const prevOnStop = mr.onstop;
        const prevOnError = mr.onerror;

        mr.onstop = () => {
          try {
            const audioBlob = new Blob(currentSegmentChunksRef.current, {
              type: mimeType,
            });
            resolve(audioBlob);
          } catch (err) {
            reject(err);
          } finally {
            mr.onstop = prevOnStop;
            mr.onerror = prevOnError;
          }
        };

        mr.onerror = () => {
          reject(new Error("Segment recorder failed while stopping."));
          mr.onstop = prevOnStop;
          mr.onerror = prevOnError;
        };

        try {
          mr.stop();
        } catch (err) {
          reject(err);
        }
      });

    currentSegmentChunksRef.current = [];
    activeRecorderRef.current = null;

    // IMPORTANT: restart capture immediately before upload
    if (!finalSegment && activeStreamRef.current && !pausedRef.current && !stoppingRef.current) {
      await startSegmentRecorder(activeStreamRef.current, mimeType);
    }

    if (blob.size > 0) {
      const uploadPromise = uploadSegment(sessionId, blob, currentIndex)
        .then(() => {
          console.log(`Uploaded segment ${currentIndex}`);
        })
        .catch((error) => {
          console.error(`Failed to upload segment ${currentIndex}`, error);
          throw error;
        });

      pendingUploadsRef.current.push(uploadPromise);
      segmentIndexRef.current += 1;
    }
  },
  [startSegmentRecorder, uploadSegment]
);

  const handleStart = useCallback(async () => {
    try {
      dispatch({ type: "STARTING" });
      stoppingRef.current = false;
      pausedRef.current = false;
      segmentIndexRef.current = 0;
      currentSegmentChunksRef.current = [];

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      activeStreamRef.current = stream;

      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const an = audioCtx.createAnalyser();
      an.fftSize = 2048;
      source.connect(an);
      audioCtxRef.current = audioCtx;
      setAnalyser(an);

      const sessionId = await createSession();
      sessionIdRef.current = sessionId;

      const mimeType = getBestMimeType();
      currentMimeTypeRef.current = mimeType || "audio/webm";

      await startSegmentRecorder(stream, currentMimeTypeRef.current);
      dispatch({ type: "START" });
      startTicker();
      scheduleSegmentRotation();
    } catch (error) {
      teardownStream();
      dispatch({
        type: "ERROR",
        message:
          error instanceof Error
            ? error.message
            : "Microphone access denied or session failed to start.",
      });
    }
  }, [createSession, scheduleSegmentRotation, startSegmentRecorder, startTicker, teardownStream]);

  const handlePauseResume = useCallback(async () => {
    if (status === "recording") {
      pausedRef.current = true;
      clearTimers();

      try {
        dispatch({ type: "UPLOADING_SEGMENT" });
        await stopCurrentSegmentAndContinue(true);
        dispatch({ type: "PAUSE" });
      } catch (error) {
        dispatch({
          type: "ERROR",
          message: error instanceof Error ? error.message : "Failed to pause session.",
        });
      }

      return;
    }

    if (status === "paused") {
      try {
        if (!activeStreamRef.current) {
          throw new Error("Microphone stream is not available.");
        }

        pausedRef.current = false;
        await startSegmentRecorder(activeStreamRef.current, currentMimeTypeRef.current);
        dispatch({ type: "RESUME" });
        startTicker();
        scheduleSegmentRotation();
      } catch (error) {
        dispatch({
          type: "ERROR",
          message: error instanceof Error ? error.message : "Failed to resume session.",
        });
      }
    }
  }, [clearTimers, scheduleSegmentRotation, startSegmentRecorder, startTicker, status, stopAndUploadCurrentSegment]);

  const handleStop = useCallback(async () => {
    try {
      stoppingRef.current = true;
      clearTimers();

      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        throw new Error("Session not found.");
      }

      if (status === "recording" || status === "uploading_segment") {
        dispatch({ type: "UPLOADING_SEGMENT" });
        await stopCurrentSegmentAndContinue(true);
      }

      await Promise.allSettled(pendingUploadsRef.current);
      pendingUploadsRef.current = [];

      dispatch({ type: "FINALIZING" });
      await finalizeSession(sessionId);

      dispatch({ type: "PROCESS" });
      const note = await pollForResult(sessionId);
      setNoteData(note);
      teardownStream();
    } catch (error) {
      teardownStream();
      dispatch({
        type: "ERROR",
        message: error instanceof Error ? error.message : "Failed to stop session.",
      });
    }
  }, [clearTimers, finalizeSession, pollForResult, status, stopAndUploadCurrentSegment, teardownStream]);

  const handleReset = useCallback(() => {
    teardownStream();
    sessionIdRef.current = null;
    segmentIndexRef.current = 0;
    stoppingRef.current = false;
    pausedRef.current = false;
    setNoteData(null);
    dispatch({ type: "RESET" });
  }, [teardownStream]);

  if (noteData) {
    return <NoteEditor data={noteData} onNewSession={handleReset} />;
  }

  const isActive = status === "recording" || status === "paused";
  const isRecording = status === "recording";
  const isBusy =
    status === "starting" ||
    status === "uploading_segment" ||
    status === "finalizing" ||
    status === "processing";
  const isError = status === "error";
  const isIdle = status === "idle";

  const statusLabel =
    status === "starting"
      ? "Starting"
      : status === "recording"
      ? "Recording"
      : status === "paused"
      ? "Paused"
      : status === "uploading_segment"
      ? "Uploading segment"
      : status === "finalizing"
      ? "Finalizing session"
      : status === "processing"
      ? "Generating note"
      : status === "error"
      ? "Error"
      : "Ready";

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
      `}</style>

      <div className="audio-capture-root min-h-screen bg-[#f7f7f5] text-[#202321] flex items-center justify-center px-4">
        <div className="w-full max-w-2xl bg-white rounded-[28px] border border-[#e8e8e5] shadow-[0_8px_30px_rgba(0,0,0,0.04)] overflow-hidden">
          <div className="px-8 pt-8 pb-6 border-b border-[#ecece8] text-center">
            <img
              src="/metromind-logo.png"
              alt="Metro Mind"
              className="h-20 w-auto mx-auto mb-4"
            />

            <div className="text-[12px] tracking-[0.22em] font-[700] text-[#2b9da0] uppercase">
              Metro Mind • Clinical
            </div>

            <h1 className="mt-2 text-[28px] leading-[1.1] font-[500] text-[#2c3433]">
               Ambient AI Scribe
            </h1>
          </div>

          <div className="px-8 py-8">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="relative flex items-center justify-center w-4 h-4">
                  {isRecording ? (
                    <>
                      <span className="pulse-ring absolute w-3 h-3 rounded-full" />
                      <span className="relative w-3 h-3 rounded-full bg-red-600" />
                    </>
                  ) : (
                    <span className={`w-3 h-3 rounded-full ${isError ? "bg-red-500" : "bg-[#c9cbc7]"}`} />
                  )}
                </div>

                <div className={`text-[15px] font-[500] ${isError ? "text-red-700" : "text-[#2f3837]"}`}>
                  {statusLabel}
                  {isBusy && !isError ? <LoadingDots /> : null}
                </div>
              </div>

              <div className="mono text-[18px] tracking-[0.04em] text-[#b8bbb7]">
                {formatTime(elapsedSeconds)}
              </div>
            </div>

            <div className="mt-8 h-[72px] rounded-[20px] border border-[#ecece8] bg-[#fcfcfb] px-4 flex items-center">
              <Waveform analyser={analyser} active={isRecording} />
            </div>

            {isError && (
              <div className="mt-8 rounded-[20px] border border-red-200 bg-red-50 px-6 py-5">
                <div className="text-[16px] font-[600] text-red-800">Something went wrong</div>
                <div className="mt-2 text-[15px] leading-7 text-red-700">{errorMessage}</div>
              </div>
            )}

            <div className="mt-8 flex flex-col sm:flex-row gap-4">
              {isIdle || isError ? (
                <button
                  onClick={isError ? handleReset : handleStart}
                  className="flex-1 rounded-[18px] border border-[#dfdfda] bg-white px-6 py-4 text-[18px] font-[500] text-[#3a413f] hover:bg-[#fafaf8] transition"
                >
                  {isError ? "Try Again" : "Start Session"}
                </button>
              ) : (
                <>
                  <button
                    onClick={handlePauseResume}
                    disabled={isBusy}
                    className="flex-1 rounded-[18px] border border-[#dfdfda] bg-white px-6 py-4 text-[18px] font-[500] text-[#3a413f] hover:bg-[#fafaf8] transition disabled:opacity-50"
                  >
                    {status === "paused" ? "Resume" : "Pause"}
                  </button>

                  <button
                    onClick={handleStop}
                    disabled={isBusy && status !== "recording"}
                    className="flex-1 rounded-[18px] border border-transparent bg-[#2f3837] px-6 py-4 text-[18px] font-[500] text-white hover:opacity-95 transition disabled:opacity-50"
                  >
                    Stop & Generate Note
                  </button>
                </>
              )}
            </div>

            <div className="mt-8 text-[13px] leading-7 text-[#a5a8a3]">
              Audio is uploaded in rolling segments during the live consultation and then assembled
              into a final AI-generated draft for clinician review.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}