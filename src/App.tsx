import { AuthProvider, useAuth } from "./AuthContext";
import Login from "./Login";
import AudioCapture from "./AudioCapture";
import { auth } from "./firebase";
import { signOut } from "firebase/auth";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_CONSULTATION_METADATA,
  type ConsultationMetadata,
} from "./consultation";

type AppPath = "/" | "/consultation" | "/recorder";

function normalizePath(pathname: string): AppPath {
  if (pathname === "/consultation") return "/consultation";
  if (pathname === "/recorder") return "/recorder";
  return "/";
}

function useAppPath() {
  const [path, setPath] = useState<AppPath>(() => normalizePath(window.location.pathname));

  useEffect(() => {
    const onPopState = () => setPath(normalizePath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next: AppPath) => {
    if (window.location.pathname !== next) {
      window.history.pushState({}, "", next);
    }
    setPath(next);
  }, []);

  return { path, navigate };
}

function LandingView({
  onStartConsultation,
  onOpenRecorder,
}: {
  onStartConsultation: () => void;
  onOpenRecorder: () => void;
}) {
  return (
    <div className="min-h-screen bg-[#f7f7f5] text-[#202321] flex items-center justify-center px-4">
      <div className="w-full max-w-2xl bg-white rounded-[28px] border border-[#e8e8e5] shadow-[0_8px_30px_rgba(0,0,0,0.04)] px-8 py-9">
        <div className="text-[12px] tracking-[0.22em] font-[700] text-[#2b9da0] uppercase">
          Metro Mind • Clinical
        </div>
        <h1 className="mt-2 text-[28px] leading-[1.1] font-[500] text-[#2c3433]">
          Consultation Workspace
        </h1>
        <p className="mt-4 text-[14px] leading-7 text-[#7b807c]">
          Start a new consultation and capture a short pre-session context before recording.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row gap-3">
          <button
            onClick={onStartConsultation}
            className="flex-1 rounded-[14px] border border-transparent bg-[#2f3837] px-5 py-3 text-[15px] font-[500] text-white hover:opacity-95 transition"
          >
            New Consultation
          </button>
          <button
            onClick={onOpenRecorder}
            className="flex-1 rounded-[14px] border border-[#dfdfda] bg-white px-5 py-3 text-[15px] font-[500] text-[#3a413f] hover:bg-[#fafaf8] transition"
          >
            Open Recorder Only
          </button>
        </div>
      </div>
    </div>
  );
}

function ConsultationWorkspace({
  onBack,
  onOpenRecorder,
  draftMetadata,
  onDraftChange,
}: {
  onBack: () => void;
  onOpenRecorder: () => void;
  draftMetadata: ConsultationMetadata;
  onDraftChange: (next: ConsultationMetadata) => void;
}) {
  return (
    <div className="min-h-screen bg-[#f7f7f5] text-[#202321] flex items-center justify-center px-4">
      <div className="w-full max-w-2xl bg-white rounded-[28px] border border-[#e8e8e5] shadow-[0_8px_30px_rgba(0,0,0,0.04)] px-8 py-9">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[22px] font-[500] text-[#2c3433]">Pre-session details</h2>
          <button
            onClick={onBack}
            className="text-[12px] font-[500] text-[#8a8d89] hover:text-[#2f3837] transition"
          >
            Back
          </button>
        </div>
        <div className="mt-6 space-y-4">
          <label className="block">
            <div className="text-[12px] text-[#8a8d89] mb-1.5">Patient name / placeholder</div>
            <input
              value={draftMetadata.patientName}
              onChange={(e) => onDraftChange({ ...draftMetadata, patientName: e.target.value })}
              placeholder="e.g., Patient A"
              className="w-full rounded-[12px] border border-[#dfdfda] px-3 py-2.5 text-[14px] focus:outline-none focus:ring-2 focus:ring-[#2b9da0]/20"
            />
          </label>
          <label className="block">
            <div className="text-[12px] text-[#8a8d89] mb-1.5">Chief complaint</div>
            <input
              value={draftMetadata.chiefComplaint}
              onChange={(e) => onDraftChange({ ...draftMetadata, chiefComplaint: e.target.value })}
              placeholder="e.g., Low mood and poor sleep"
              className="w-full rounded-[12px] border border-[#dfdfda] px-3 py-2.5 text-[14px] focus:outline-none focus:ring-2 focus:ring-[#2b9da0]/20"
            />
          </label>
          <label className="block">
            <div className="text-[12px] text-[#8a8d89] mb-1.5">Preferred language</div>
            <select
              value={draftMetadata.preferredLanguage}
              onChange={(e) =>
                onDraftChange({ ...draftMetadata, preferredLanguage: e.target.value })
              }
              className="w-full rounded-[12px] border border-[#dfdfda] px-3 py-2.5 text-[14px] bg-white focus:outline-none focus:ring-2 focus:ring-[#2b9da0]/20"
            >
              <option>English</option>
              <option>Spanish</option>
              <option>French</option>
              <option>Other</option>
            </select>
          </label>
        </div>
        <button
          onClick={onOpenRecorder}
          className="mt-7 w-full rounded-[14px] border border-transparent bg-[#2f3837] px-5 py-3 text-[15px] font-[500] text-white hover:opacity-95 transition"
        >
          Begin Consultation Recording
        </button>
      </div>
    </div>
  );
}

// The protected wrapper that adds a "Sign Out" button
function ProtectedRoute() {
  const { path, navigate } = useAppPath();
  const [consultationMetadata, setConsultationMetadata] =
    useState<ConsultationMetadata>(DEFAULT_CONSULTATION_METADATA);

  const metadataForRecorder = useMemo(
    () => ({
      patientName: consultationMetadata.patientName.trim(),
      chiefComplaint: consultationMetadata.chiefComplaint.trim(),
      preferredLanguage: consultationMetadata.preferredLanguage.trim(),
    }),
    [consultationMetadata]
  );

  return (
    <div className="relative">
      <button 
        onClick={() => signOut(auth)}
        className="absolute top-4 right-6 z-50 text-[12px] font-[500] text-[#888] hover:text-[#111] transition-colors bg-white/50 px-3 py-1.5 rounded-md border border-[#e8e8e5] backdrop-blur-sm"
      >
        Sign Out
      </button>
      {path === "/" && (
        <LandingView
          onStartConsultation={() => navigate("/consultation")}
          onOpenRecorder={() => navigate("/recorder")}
        />
      )}
      {path === "/consultation" && (
        <ConsultationWorkspace
          onBack={() => navigate("/")}
          onOpenRecorder={() => navigate("/recorder")}
          draftMetadata={consultationMetadata}
          onDraftChange={setConsultationMetadata}
        />
      )}
      {path === "/recorder" && <AudioCapture consultationMetadata={metadataForRecorder} />}
    </div>
  );
}

// The Gatekeeper: Shows AudioCapture IF logged in, otherwise shows Login
function MainGatekeeper() {
  const { currentUser } = useAuth();
  return currentUser ? <ProtectedRoute /> : <Login />;
}

export default function App() {
  return (
    <AuthProvider>
      <MainGatekeeper />
    </AuthProvider>
  );
}
