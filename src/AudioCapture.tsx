import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import NoteEditor, { type SoapNote } from "./NoteEditor";
import { type ConsultationMetadata } from "./consultation";

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
const SEGMENT_UPLOAD_CONCURRENCY = 2;
const MAX_QUEUED_SEGMENTS = 12;

interface FailedSegment {
  segmentIndex: number;
  message: string;
}

type SegmentUploadError = Error & { segmentIndex?: number };
type FinalizeSessionError = Error & { segmentEntries?: FailedSegment[] };

interface SessionProgress {
  sessionStatus: string | null;
  segmentsReceived: number | null;
  segmentsTranscribed: number | null;
  failedSegments: number | null;
}

const INITIAL_SESSION_PROGRESS: SessionProgress = {
  sessionStatus: null,
  segmentsReceived: null,
  segmentsTranscribed: null,
  failedSegments: null,
};

function collectSegmentIndices(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    .sort((a, b) => a - b);
}

function collectSegmentEntries(value: unknown, fallbackMessage: string): FailedSegment[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const candidate = entry as Record<string, unknown>;
      const segmentIndex =
        typeof candidate.segmentIndex === "number" && Number.isFinite(candidate.segmentIndex)
          ? candidate.segmentIndex
          : typeof candidate.index === "number" && Number.isFinite(candidate.index)
            ? candidate.index
            : null;

      if (segmentIndex === null) return null;

      const directMessage =
        typeof candidate.message === "string" && candidate.message.trim().length > 0
          ? candidate.message
          : null;
      const lastError =
        candidate.lastError && typeof candidate.lastError === "object"
          ? (candidate.lastError as Record<string, unknown>)
          : null;
      const lastErrorMessage =
        typeof lastError?.message === "string" && lastError.message.trim().length > 0
          ? lastError.message
          : null;

      return {
        segmentIndex,
        message: lastErrorMessage ?? directMessage ?? fallbackMessage,
      } satisfies FailedSegment;
    })
    .filter((entry): entry is FailedSegment => entry !== null)
    .sort((a, b) => a.segmentIndex - b.segmentIndex);
}

function buildFinalizeSessionError(body: unknown, statusCode: number): FinalizeSessionError {
  const response = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const rawError = response.error;

  if (statusCode === 409 && rawError && typeof rawError === "object") {
    const errorObj = rawError as Record<string, unknown>;
    const code = typeof errorObj.code === "string" ? errorObj.code : "";
    const backendMessage =
      typeof errorObj.message === "string" && errorObj.message.trim().length > 0
        ? errorObj.message
        : "Unable to finalize this consultation yet.";

    if (code === "SEGMENTS_PENDING") {
      const pendingIndices = collectSegmentIndices(errorObj.pendingSegmentIndices);
      const pendingEntries = collectSegmentEntries(
        errorObj.pendingSegments,
        "Still processing. Please wait a moment and try again."
      );
      const indices = pendingIndices.length
        ? pendingIndices
        : pendingEntries.map((entry) => entry.segmentIndex);
      const suffix = indices.length ? ` Pending segments: ${indices.map((i) => `#${i}`).join(", ")}.` : "";
      const error = new Error(`${backendMessage}${suffix}`) as FinalizeSessionError;
      error.segmentEntries =
        pendingEntries.length > 0
          ? pendingEntries
          : indices.map((segmentIndex) => ({
              segmentIndex,
              message: "Still processing. Please wait a moment and try again.",
            }));
      return error;
    }

    if (code === "SEGMENTS_FAILED") {
      const failedIndices = collectSegmentIndices(errorObj.failedSegmentIndices);
      const failedEntries = collectSegmentEntries(
        errorObj.failedSegments,
        "Segment failed processing and needs re-recording."
      );
      const indices = failedIndices.length
        ? failedIndices
        : failedEntries.map((entry) => entry.segmentIndex);
      const suffix = indices.length ? ` Failed segments: ${indices.map((i) => `#${i}`).join(", ")}.` : "";
      const error = new Error(`${backendMessage}${suffix}`) as FinalizeSessionError;
      error.segmentEntries =
        failedEntries.length > 0
          ? failedEntries
          : indices.map((segmentIndex) => ({
              segmentIndex,
              message: "Segment failed processing and needs re-recording.",
            }));
      return error;
    }
  }

  const legacyMessage =
    typeof rawError === "string"
      ? rawError
      : rawError &&
          typeof rawError === "object" &&
          typeof (rawError as Record<string, unknown>).message === "string"
        ? ((rawError as Record<string, unknown>).message as string)
        : null;

  return new Error(legacyMessage ?? "Failed to finalize session.");
}

function asCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function mapSessionProgress(payload: unknown): SessionProgress {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const progress =
    root.progress && typeof root.progress === "object"
      ? (root.progress as Record<string, unknown>)
      : {};

  return {
    sessionStatus:
      asText(root.status) ??
      asText(progress.status) ??
      asText(root.sessionStatus) ??
      asText(progress.sessionStatus),
    segmentsReceived:
      asCount(root.segmentsReceived) ??
      asCount(progress.segmentsReceived) ??
      asCount(root.receivedSegments) ??
      asCount(progress.receivedSegments),
    segmentsTranscribed:
      asCount(root.segmentsTranscribed) ??
      asCount(progress.segmentsTranscribed) ??
      asCount(root.transcribedSegments) ??
      asCount(progress.transcribedSegments),
    failedSegments:
      asCount(root.failedSegments) ??
      asCount(progress.failedSegments) ??
      asCount(root.segmentsFailed) ??
      asCount(progress.segmentsFailed),
  };
}

export default function AudioCapture({
  consultationMetadata,
}: {
  consultationMetadata?: ConsultationMetadata | null;
}) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const { status, elapsedSeconds, errorMessage } = state;

  const [noteData, setNoteData] = useState<SoapNote | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [failedSegments, setFailedSegments] = useState<FailedSegment[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionProgress, setSessionProgress] = useState<SessionProgress>(INITIAL_SESSION_PROGRESS);
  const [isRetryingFailedSegments, setIsRetryingFailedSegments] = useState(false);
  const [retryStatusMessage, setRetryStatusMessage] = useState<string | null>(null);
  const [waitingForRetryProcessing, setWaitingForRetryProcessing] = useState(false);

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
  const pendingUploadsRef = useRef<Set<Promise<void>>>(new Set());
  const queuedUploadsRef = useRef<
    Array<{ sessionId: string; blob: Blob; segmentIndex: number; resolve: () => void; reject: (error: unknown) => void }>
  >([]);
  const activeUploadCountRef = useRef<number>(0);
  const failedSegmentMessagesRef = useRef<Map<number, string>>(new Map());

  const recordFailedSegment = useCallback((segmentIndex: number, message: string) => {
    failedSegmentMessagesRef.current.set(segmentIndex, message);
    setFailedSegments((prev) => {
      const withoutCurrent = prev.filter((entry) => entry.segmentIndex !== segmentIndex);
      return [...withoutCurrent, { segmentIndex, message }].sort(
        (a, b) => a.segmentIndex - b.segmentIndex
      );
    });
  }, []);

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
    pendingUploadsRef.current = new Set();
    queuedUploadsRef.current = [];
    activeUploadCountRef.current = 0;
    failedSegmentMessagesRef.current = new Map();
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setAnalyser(null);
    setFailedSegments([]);
  }, [clearTimers]);

  useEffect(() => {
    return () => teardownStream();
  }, [teardownStream]);

  const createSession = useCallback(async (): Promise<string> => {
    const payload = {
      patientName: consultationMetadata?.patientName?.trim() ?? "",
      chiefComplaint: consultationMetadata?.chiefComplaint?.trim() ?? "",
      preferredLanguage: consultationMetadata?.preferredLanguage?.trim() ?? "",
    };

    const hasMetadata =
      payload.patientName.length > 0 ||
      payload.chiefComplaint.length > 0 ||
      payload.preferredLanguage.length > 0;

    const res = await fetch(`${BACKEND_BASE}/sessions`, {
      method: "POST",
      headers: hasMetadata ? { "Content-Type": "application/json" } : undefined,
      body: hasMetadata ? JSON.stringify(payload) : undefined,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error ?? "Failed to create session.");
    }

    const json = (await res.json()) as { sessionId: string };
    return json.sessionId;
  }, [consultationMetadata]);

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
        const structuredError = body?.error;
        const backendMessage =
          typeof structuredError?.message === "string" && structuredError.message.trim().length > 0
            ? structuredError.message
            : typeof structuredError === "string" && structuredError.trim().length > 0
              ? structuredError
              : "Failed to upload segment.";

        const uploadError = new Error(`${backendMessage} (HTTP ${res.status})`) as SegmentUploadError;
        if (typeof structuredError?.segmentIndex === "number") {
          uploadError.segmentIndex = structuredError.segmentIndex;
        } else if (typeof segmentIndex === "number") {
          uploadError.segmentIndex = segmentIndex;
        }

        throw uploadError;
      }
    },
    []
  );

  const processUploadQueue = useCallback(() => {
    while (
      activeUploadCountRef.current < SEGMENT_UPLOAD_CONCURRENCY &&
      queuedUploadsRef.current.length > 0
    ) {
      const job = queuedUploadsRef.current.shift();
      if (!job) return;

      activeUploadCountRef.current += 1;
      uploadSegment(job.sessionId, job.blob, job.segmentIndex)
        .then(() => {
          console.log(`Uploaded segment ${job.segmentIndex}`);
          job.resolve();
        })
        .catch((error) => {
          const uploadError = error as SegmentUploadError;
          const failedSegmentIndex =
            typeof uploadError.segmentIndex === "number"
              ? uploadError.segmentIndex
              : job.segmentIndex;
          const message =
            error instanceof Error ? error.message : "Failed to upload segment.";
          console.error(`Failed to upload segment ${failedSegmentIndex}`, error);
          recordFailedSegment(failedSegmentIndex, message);
          job.reject(new Error(`Segment ${failedSegmentIndex}: ${message}`));
        })
        .finally(() => {
          activeUploadCountRef.current = Math.max(0, activeUploadCountRef.current - 1);
          processUploadQueue();
        });
    }
  }, [recordFailedSegment, uploadSegment]);

  const enqueueSegmentUpload = useCallback(
    (sessionId: string, blob: Blob, segmentIndex: number): Promise<void> => {
      if (
        queuedUploadsRef.current.length + activeUploadCountRef.current >=
        MAX_QUEUED_SEGMENTS + SEGMENT_UPLOAD_CONCURRENCY
      ) {
        const message = `Upload queue is full (${MAX_QUEUED_SEGMENTS} waiting).`;
        recordFailedSegment(segmentIndex, message);
        return Promise.reject(new Error(`Segment ${segmentIndex}: ${message}`));
      }

      return new Promise<void>((resolve, reject) => {
        queuedUploadsRef.current.push({ sessionId, blob, segmentIndex, resolve, reject });
        processUploadQueue();
      });
    },
    [processUploadQueue, recordFailedSegment]
  );

  const finalizeSession = useCallback(async (sessionId: string) => {
    const res = await fetch(`${BACKEND_BASE}/sessions/${sessionId}/finalize`, {
      method: "POST",
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw buildFinalizeSessionError(body, res.status);
    }
  }, []);

  const retryFailedSegment = useCallback(async (activeSessionId: string, segmentIndex: number) => {
    const res = await fetch(
      `${BACKEND_BASE}/sessions/${activeSessionId}/segments/${segmentIndex}/retry`,
      {
        method: "POST",
      }
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const structuredError = body?.error;
      const message =
        typeof structuredError?.message === "string" && structuredError.message.trim().length > 0
          ? structuredError.message
          : typeof structuredError === "string" && structuredError.trim().length > 0
            ? structuredError
            : `Unable to retry segment #${segmentIndex}.`;
      throw new Error(message);
    }
  }, []);

  const fetchSessionStatus = useCallback(async (activeSessionId: string) => {
    const res = await fetch(`${BACKEND_BASE}/sessions/${activeSessionId}/status`);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error ?? "Failed to fetch session status.");
    }

    const payload = await res.json();
    setSessionProgress(mapSessionProgress(payload));
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

  const startSegmentRecorder = useCallback(async (stream: MediaStream, mimeType: string) => {
    currentSegmentChunksRef.current = [];

    const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    mr.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) {
        currentSegmentChunksRef.current.push(e.data);
      }
    };

    activeRecorderRef.current = mr;
    mr.start();
  }, []);

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

      if (!finalSegment && activeStreamRef.current && !pausedRef.current && !stoppingRef.current) {
        await startSegmentRecorder(activeStreamRef.current, mimeType);
      }

      if (blob.size > 0) {
        const uploadPromise = enqueueSegmentUpload(sessionId, blob, currentIndex);

        pendingUploadsRef.current.add(uploadPromise);
        uploadPromise.finally(() => {
          pendingUploadsRef.current.delete(uploadPromise);
        });
        segmentIndexRef.current += 1;
      }
    },
    [enqueueSegmentUpload, startSegmentRecorder]
  );

  const scheduleSegmentRotation = useCallback(() => {
    if (pausedRef.current || stoppingRef.current) return;

    segmentTimerRef.current = window.setTimeout(async () => {
      const sessionId = sessionIdRef.current;
      if (!sessionId || pausedRef.current || stoppingRef.current) return;

      try {
        await stopCurrentSegmentAndContinue(false);
        if (!pausedRef.current && !stoppingRef.current) {
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
  }, [stopCurrentSegmentAndContinue]);

  const handleStart = useCallback(async () => {
    try {
      dispatch({ type: "STARTING" });
      stoppingRef.current = false;
      pausedRef.current = false;
      segmentIndexRef.current = 0;
      currentSegmentChunksRef.current = [];
      pendingUploadsRef.current = new Set();
      queuedUploadsRef.current = [];
      activeUploadCountRef.current = 0;
      failedSegmentMessagesRef.current = new Map();
      setFailedSegments([]);
      setRetryStatusMessage(null);
      setWaitingForRetryProcessing(false);

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
      setSessionId(sessionId);
      setSessionProgress(INITIAL_SESSION_PROGRESS);

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
  }, [
    clearTimers,
    scheduleSegmentRotation,
    startSegmentRecorder,
    startTicker,
    status,
    stopCurrentSegmentAndContinue,
  ]);

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

      const uploadResults = await Promise.allSettled(Array.from(pendingUploadsRef.current));
      pendingUploadsRef.current = new Set();

      const failedUploads = uploadResults.filter((r) => r.status === "rejected");
      if (failedUploads.length > 0) {
        const failedDetails = Array.from(failedSegmentMessagesRef.current.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([segmentIndex, message]) => `#${segmentIndex}: ${message}`)
          .join(" | ");
        throw new Error(
          `Unable to finalize: ${failedUploads.length} segment upload(s) failed. ${failedDetails}`
        );
      }

      dispatch({ type: "FINALIZING" });
      await finalizeSession(sessionId);

      dispatch({ type: "PROCESS" });
      const note = await pollForResult(sessionId);
      console.log("FINAL SOAP RESULT:", note);

      if (!note || typeof note !== "object" || !("soap_note" in note)) {
        throw new Error("Backend returned an invalid SOAP note shape.");
      }

      setNoteData(note);
      setRetryStatusMessage(null);
      setWaitingForRetryProcessing(false);
      teardownStream();
    } catch (error) {
      const finalizeError = error as FinalizeSessionError;
      teardownStream();
      if (finalizeError.segmentEntries && finalizeError.segmentEntries.length > 0) {
        setFailedSegments(finalizeError.segmentEntries);
      }
      setRetryStatusMessage(null);
      setWaitingForRetryProcessing(false);
      dispatch({
        type: "ERROR",
        message: error instanceof Error ? error.message : "Failed to stop session.",
      });
    }
  }, [
    clearTimers,
    finalizeSession,
    pollForResult,
    status,
    stopCurrentSegmentAndContinue,
    teardownStream,
  ]);

  const handleReset = useCallback(() => {
    teardownStream();
    sessionIdRef.current = null;
    setSessionId(null);
    setSessionProgress(INITIAL_SESSION_PROGRESS);
    setRetryStatusMessage(null);
    setIsRetryingFailedSegments(false);
    setWaitingForRetryProcessing(false);
    segmentIndexRef.current = 0;
    stoppingRef.current = false;
    pausedRef.current = false;
    setNoteData(null);
    dispatch({ type: "RESET" });
  }, [teardownStream]);

  const handleRetryFailedSegments = useCallback(async () => {
    const activeSessionId = sessionIdRef.current ?? sessionId;
    if (!activeSessionId || failedSegments.length === 0) return;

    const uniqueIndices = Array.from(
      new Set(failedSegments.map((segment) => segment.segmentIndex))
    ).sort((a, b) => a - b);

    setIsRetryingFailedSegments(true);
    setRetryStatusMessage("Queueing retries for failed segments...");

    const retryFailures: FailedSegment[] = [];

    for (let i = 0; i < uniqueIndices.length; i += 1) {
      const segmentIndex = uniqueIndices[i];
      setRetryStatusMessage(`Retrying segment ${i + 1} of ${uniqueIndices.length}...`);
      try {
        await retryFailedSegment(activeSessionId, segmentIndex);
      } catch (error) {
        retryFailures.push({
          segmentIndex,
          message: error instanceof Error ? error.message : "Retry request failed.",
        });
      }
    }

    if (retryFailures.length > 0) {
      setFailedSegments(retryFailures);
      setRetryStatusMessage(
        `Some retries could not be queued (${retryFailures.length}/${uniqueIndices.length}).`
      );
      setWaitingForRetryProcessing(false);
      setIsRetryingFailedSegments(false);
      return;
    }

    setFailedSegments([]);
    setWaitingForRetryProcessing(true);
    setRetryStatusMessage("Retries queued. Waiting for segment processing to finish.");
    setIsRetryingFailedSegments(false);
  }, [failedSegments, retryFailedSegment, sessionId]);

  const handleTryFinalizeAgain = useCallback(async () => {
    const activeSessionId = sessionIdRef.current ?? sessionId;
    if (!activeSessionId) return;

    try {
      setRetryStatusMessage("Trying to finalize consultation...");
      dispatch({ type: "FINALIZING" });
      await finalizeSession(activeSessionId);

      dispatch({ type: "PROCESS" });
      const note = await pollForResult(activeSessionId);

      if (!note || typeof note !== "object" || !("soap_note" in note)) {
        throw new Error("Backend returned an invalid SOAP note shape.");
      }

      setNoteData(note);
      setRetryStatusMessage(null);
      setWaitingForRetryProcessing(false);
      teardownStream();
    } catch (error) {
      const finalizeError = error as FinalizeSessionError;
      if (finalizeError.segmentEntries && finalizeError.segmentEntries.length > 0) {
        setFailedSegments(finalizeError.segmentEntries);
      }
      setWaitingForRetryProcessing(true);
      dispatch({
        type: "ERROR",
        message: error instanceof Error ? error.message : "Unable to finalize session.",
      });
    }
  }, [finalizeSession, pollForResult, sessionId, teardownStream]);

  useEffect(() => {
    const shouldPoll =
      status === "recording" ||
      status === "uploading_segment" ||
      status === "finalizing" ||
      status === "processing" ||
      waitingForRetryProcessing;

    if (!shouldPoll || !sessionId) return;

    let cancelled = false;
    let timeoutId: number | null = null;

    const poll = async () => {
      try {
        await fetchSessionStatus(sessionId);
      } catch {
        // Keep status polling silent in UI; main recorder flow handles surfaced errors.
      } finally {
        if (!cancelled) {
          timeoutId = window.setTimeout(poll, 2500);
        }
      }
    };

    poll();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [fetchSessionStatus, sessionId, status, waitingForRetryProcessing]);

  if (noteData) {
    return <NoteEditor data={noteData} onNewSession={handleReset} />;
  }

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

  const patientLabel = consultationMetadata?.patientName?.trim() || "Not provided";
  const complaintLabel = consultationMetadata?.chiefComplaint?.trim() || "Not provided";
  const languageLabel = consultationMetadata?.preferredLanguage?.trim() || "Not provided";

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
          <div className="px-8 pt-8 pb-6 border-b border-[#ecece8]">
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

            {sessionId && !isIdle && !isError && (
              <div className="mt-4 rounded-[14px] border border-[#ecece8] bg-[#fcfcfb] px-4 py-3 text-[12px] text-[#69706c]">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div>
                    <div className="text-[#9aa09b] uppercase tracking-[0.08em] text-[10px]">Session</div>
                    <div className="text-[#3b4341] font-[500]">{sessionProgress.sessionStatus ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-[#9aa09b] uppercase tracking-[0.08em] text-[10px]">Received</div>
                    <div className="text-[#3b4341] font-[500]">{sessionProgress.segmentsReceived ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-[#9aa09b] uppercase tracking-[0.08em] text-[10px]">Transcribed</div>
                    <div className="text-[#3b4341] font-[500]">{sessionProgress.segmentsTranscribed ?? "—"}</div>
                  </div>
                  <div>
                    <div className="text-[#9aa09b] uppercase tracking-[0.08em] text-[10px]">Failed</div>
                    <div className="text-[#3b4341] font-[500]">{sessionProgress.failedSegments ?? "—"}</div>
                  </div>
                </div>
              </div>
            )}

            {isError && (
              <div className="mt-8 rounded-[20px] border border-red-200 bg-red-50 px-6 py-5">
                <div className="text-[16px] font-[600] text-red-800">Something went wrong</div>
                <div className="mt-2 text-[15px] leading-7 text-red-700">{errorMessage}</div>
                {retryStatusMessage && (
                  <div className="mt-2 text-[14px] text-red-700">{retryStatusMessage}</div>
                )}
                {failedSegments.length > 0 && (
                  <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-red-700">
                    {failedSegments.map((failure) => (
                      <li key={failure.segmentIndex}>
                        Segment #{failure.segmentIndex}: {failure.message}
                      </li>
                    ))}
                  </ul>
                )}
                {failedSegments.length > 0 && sessionId && (
                  <button
                    onClick={handleRetryFailedSegments}
                    disabled={isRetryingFailedSegments}
                    className="mt-4 rounded-[12px] border border-red-200 bg-white px-4 py-2 text-[14px] font-[500] text-red-700 hover:bg-red-100 transition disabled:opacity-60"
                  >
                    {isRetryingFailedSegments ? "Retrying failed segments..." : "Retry failed segments"}
                  </button>
                )}
                {sessionId && waitingForRetryProcessing && (
                  <button
                    onClick={handleTryFinalizeAgain}
                    className="mt-3 rounded-[12px] border border-red-200 bg-white px-4 py-2 text-[14px] font-[500] text-red-700 hover:bg-red-100 transition"
                  >
                    Try finalize again
                  </button>
                )}
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
            <div className="mt-3 rounded-[12px] border border-[#efefeb] bg-[#fcfcfb] px-4 py-2.5 text-[12px] text-[#808580]">
              <span className="font-[500] text-[#6e746f]">Consultation context:</span>{" "}
              Patient {patientLabel} · Complaint {complaintLabel} · Language {languageLabel}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
