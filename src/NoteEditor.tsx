/**
 * NoteEditor.tsx
 *
 * Renders an AI-generated psychiatric SOAP note with Metro Mind branding,
 * Auth integration for automatic signature, and "Print to PDF" functionality.
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useAuth } from "./AuthContext";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Diagnosis {
  icd10_code: string | null;
  description: string | null;
  status: "primary" | "secondary" | "rule_out" | null;
}

export interface Medication {
  name: string | null;
  dose: string | null;
  frequency: string | null;
  instructions: string | null;
  action: "start" | "continue" | "adjust" | "discontinue" | null;
}

export interface PsychometricAnalysis {
  scale_name: string | null;
  relevance_to_session: string | null;
  symptoms_mapped_to_scale: string[] | null;
  narrative_severity_estimate: string | null;
  missing_domains_to_evaluate: string[] | null;
}

export interface SoapNote {
  soap_note: {
    subjective: {
      hpi: {
        chief_complaint: string | null;
        onset: string | null;
        duration: string | null;
        precipitating_factors: string[] | null;
        symptoms: string[] | null;
        psychiatric_history: string | null;
        substance_use: string | null;
        social_history: string | null;
        family_psychiatric_history: string | null;
        medications: string[] | null;
        allergies: string[] | null;
      };
    };
    objective: {
      mental_status_exam: {
        appearance: string | null;
        behavior: string | null;
        speech: string | null;
        mood: string | null;
        affect: string | null;
        thought_process: string | null;
        thought_content: string | null;
        perceptual_disturbances: string | null;
        cognition: string | null;
        insight: string | null;
        judgment: string | null;
      };
    };
    assessment: {
      diagnoses: Diagnosis[] | null;
      risk_assessment: {
        suicidal_ideation: {
          present: string | null;
          plan: string | null;
          intent: string | null;
          protective_factors: string[] | null;
        } | null;
        homicidal_ideation: { present: string | null; detail: string | null } | null;
        self_harm: { present: string | null; detail: string | null } | null;
        overall_risk_level: "low" | "moderate" | "high" | "imminent" | null;
        clinical_rationale: string | null;
      };
      psychometric_analysis?: PsychometricAnalysis[] | null;
    };
    plan: {
      medications: Medication[] | null;
      psychotherapy: string | null;
      safety_plan: string | null;
      referrals: string[] | null;
      labs_or_diagnostics: string[] | null;
      patient_education: string | null;
      follow_up: string | null;
      disposition: string | null;
    };
  };
  transcription_confidence: "high" | "medium" | "low" | null;
  clinician_review_required: boolean;
  disclaimer: string | null;
}

interface NoteEditorProps {
  data: SoapNote;
  onNewSession?: () => void;
}

// ─── Auto-expanding textarea ──────────────────────────────────────────────────

interface AutoTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  value: string;
}

function AutoTextarea({ value, onChange, className, ...rest }: AutoTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={onChange}
      rows={1}
      className={[
        "w-full resize-none overflow-hidden bg-transparent leading-relaxed",
        "focus:outline-none focus:ring-0",
        "placeholder:text-[#c8c8c2]",
        "print:border-none print:resize-none print:overflow-visible print:placeholder-transparent",
        className,
      ].filter(Boolean).join(" ")}
      {...rest}
    />
  );
}

// ─── Field primitives ─────────────────────────────────────────────────────────

function Field({ label, value, onChange, placeholder, mono }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; }) {
  return (
    <div className="group print:break-inside-avoid">
      <p className="text-[9.5px] font-[600] tracking-[0.14em] uppercase text-[#a8a8a0] mb-[5px] select-none print:text-black">{label}</p>
      <AutoTextarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "—"}
        className={[
          "text-[13.5px] text-[#1a1a18] font-[350]",
          "border-b border-transparent group-hover:border-[#e4e4e0] focus:border-[#c0bfba] transition-colors duration-150 pb-[3px]",
          mono ? "font-mono" : "",
        ].join(" ")}
      />
    </div>
  );
}

function ListField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; }) {
  return (
    <div className="group print:break-inside-avoid">
      <p className="text-[9.5px] font-[600] tracking-[0.14em] uppercase text-[#a8a8a0] mb-[5px] select-none print:text-black">
        {label} <span className="normal-case font-normal tracking-normal text-[#c0c0ba] print:hidden">(one per line)</span>
      </p>
      <AutoTextarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "—"}
        className="text-[13.5px] text-[#1a1a18] font-[350] border-b border-transparent group-hover:border-[#e4e4e0] focus:border-[#c0bfba] transition-colors duration-150 pb-[3px]"
      />
    </div>
  );
}

// ─── Section wrappers ─────────────────────────────────────────────────────────

const SECTION_ACCENTS: Record<string, string> = { S: "#179ea1", O: "#4bcba2", A: "#14898c", P: "#41af8c" };

function Section({ letter, title, subtitle, children }: { letter: string; title: string; subtitle?: string; children: React.ReactNode; }) {
  const accent = SECTION_ACCENTS[letter] ?? "#888";
  return (
    <section className="relative pl-6 py-1 print:mb-6" style={{ borderLeft: `2.5px solid ${accent}` }}>
      <div className="mb-5">
        <div className="flex items-baseline gap-2.5">
          <span className="text-[10px] font-[700] tracking-[0.2em] uppercase print:text-black" style={{ color: accent }}>{letter}</span>
          <h2 className="text-[18px] font-lora font-[600] text-[#111] leading-tight print:text-black">{title}</h2>
        </div>
        {subtitle && <p className="text-[11px] text-[#a8a8a0] mt-0.5 ml-[22px] print:text-black">{subtitle}</p>}
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function Sub({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="print:break-inside-avoid">
      <p className="text-[11px] font-[600] text-[#888880] mb-3 uppercase tracking-[0.1em] print:text-black">{title}</p>
      <div className="space-y-4 pl-0">{children}</div>
    </div>
  );
}

function FieldGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">{children}</div>;
}

// ─── EHR plain-text formatter ─────────────────────────────────────────────────

function toEhrText(note: SoapNote["soap_note"], verified: boolean, docName: string, regId: string): string {
  const s = note.subjective.hpi;
  const o = note.objective.mental_status_exam;
  const a = note.assessment;
  const p = note.plan;

  const line = (label: string, val: string | null | undefined) => val ? `${label}: ${val}` : "";
  const list = (label: string, arr: string[] | null | undefined) => arr?.length ? `${label}:\n${arr.map((x) => `  • ${x}`).join("\n")}` : "";

  const lines = [
    "═══════════════════════════════════════════════",
    "METRO MIND CLINICAL NOTE",
    `Generated: ${new Date().toLocaleString()}`,
    "═══════════════════════════════════════════════",
    "",
    "S — SUBJECTIVE / HPI",
    "───────────────────────────────────────────────",
    line("Chief Complaint", s.chief_complaint),
    line("Onset", s.onset),
    line("Duration", s.duration),
    list("Precipitating Factors", s.precipitating_factors),
    list("Symptoms", s.symptoms),
    line("Psychiatric History", s.psychiatric_history),
    line("Substance Use", s.substance_use),
    line("Social History", s.social_history),
    line("Family Psychiatric History", s.family_psychiatric_history),
    list("Current Medications", s.medications),
    list("Allergies", s.allergies),
    "",
    "O — OBJECTIVE / MENTAL STATUS EXAM",
    "───────────────────────────────────────────────",
    line("Appearance", o.appearance),
    line("Behavior", o.behavior),
    line("Speech", o.speech),
    line("Mood", o.mood),
    line("Affect", o.affect),
    line("Thought Process", o.thought_process),
    line("Thought Content", o.thought_content),
    line("Perceptual Disturbances", o.perceptual_disturbances),
    line("Cognition", o.cognition),
    line("Insight", o.insight),
    line("Judgment", o.judgment),
    "",
    "A — ASSESSMENT",
    "───────────────────────────────────────────────",
    ...(a.diagnoses?.map((d, i) => `Dx ${i + 1} [${d.status?.toUpperCase() ?? ""}]: ${d.icd10_code ?? ""} — ${d.description ?? ""}`) ?? []),
    "",
    "RISK ASSESSMENT",
    `Overall Risk Level: ${a.risk_assessment.overall_risk_level?.toUpperCase() ?? "—"}`,
    `Suicidal Ideation: ${a.risk_assessment.suicidal_ideation?.present ?? "—"}`,
    line("  Plan", a.risk_assessment.suicidal_ideation?.plan),
    line("  Intent", a.risk_assessment.suicidal_ideation?.intent),
    list("  Protective Factors", a.risk_assessment.suicidal_ideation?.protective_factors),
    `Homicidal Ideation: ${a.risk_assessment.homicidal_ideation?.present ?? "—"}`,
    line("  Detail", a.risk_assessment.homicidal_ideation?.detail),
    `Self-Harm: ${a.risk_assessment.self_harm?.present ?? "—"}`,
    line("  Detail", a.risk_assessment.self_harm?.detail),
    line("Clinical Rationale", a.risk_assessment.clinical_rationale),
    "",
  ];

  if (a.psychometric_analysis && a.psychometric_analysis.length > 0) {
    lines.push("PSYCHOMETRIC ANALYSIS (AI CO-PILOT)");
    a.psychometric_analysis.forEach((psy) => {
      lines.push(`• Scale: ${psy.scale_name ?? "Unknown"} (Relevance: ${psy.relevance_to_session ?? "—"}, Severity: ${psy.narrative_severity_estimate ?? "—"})`);
      if (psy.symptoms_mapped_to_scale?.length) {
        lines.push(`  Mapped Symptoms:`);
        psy.symptoms_mapped_to_scale.forEach(sym => lines.push(`    - ${sym}`));
      }
      if (psy.missing_domains_to_evaluate?.length) {
        lines.push(`  Missing Domains (Requires clinician assessment):`);
        psy.missing_domains_to_evaluate.forEach(dom => lines.push(`    - ${dom}`));
      }
    });
    lines.push("");
  }

  lines.push(
    "P — PLAN",
    "───────────────────────────────────────────────",
    ...(p.medications?.map((m) => `[${m.action?.toUpperCase() ?? ""}] ${m.name ?? ""} ${m.dose ?? ""} ${m.frequency ?? ""} — ${m.instructions ?? ""}`) ?? []),
    line("Psychotherapy", p.psychotherapy),
    line("Safety Plan", p.safety_plan),
    list("Referrals", p.referrals),
    list("Labs / Diagnostics", p.labs_or_diagnostics),
    line("Patient Education", p.patient_education),
    line("Follow-Up", p.follow_up),
    line("Disposition", p.disposition),
    ""
  );

  if (verified) {
    lines.push(
      "VERIFICATION & SIGNATURE",
      "───────────────────────────────────────────────",
      `Electronically Verified By: ${docName || "[Name Not Provided]"}`,
      `Registration ID: ${regId || "[ID Not Provided]"}`,
      `Date: ${new Date().toLocaleDateString()}`,
      ""
    );
  }

  lines.push(
    "═══════════════════════════════════════════════",
    "AI-generated draft. Must be reviewed and co-signed by a licensed clinician.",
    "═══════════════════════════════════════════════"
  );

  return lines.filter((l) => l !== "").join("\n");
}

function deepClone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

// ─── NoteEditor Component ─────────────────────────────────────────────────────

export default function NoteEditor({ data, onNewSession }: NoteEditorProps) {
  const { currentUser } = useAuth(); // Pulls the logged-in doctor's data

  const [note, setNote] = useState<SoapNote["soap_note"]>(() => deepClone(data.soap_note));
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>();

  // Verification State
  const [verified, setVerified] = useState(false);
  
  // Auto-pull from login credentials
  const physicianName = currentUser?.displayName || "Licensed Clinician";
  const regId = currentUser ? localStorage.getItem(`regId_${currentUser.uid}`) || "ID Not Found" : "";

  // Path setters
  const setHpi = useCallback((key: keyof SoapNote["soap_note"]["subjective"]["hpi"]) => (val: string) => { setNote((prev) => { const next = deepClone(prev); (next.subjective.hpi as any)[key] = val; return next; }); }, []);
  const setHpiList = useCallback((key: keyof SoapNote["soap_note"]["subjective"]["hpi"]) => (val: string) => { setNote((prev) => { const next = deepClone(prev); (next.subjective.hpi as any)[key] = val.split("\n").map((l) => l.trim()).filter(Boolean); return next; }); }, []);
  const setMse = useCallback((key: keyof SoapNote["soap_note"]["objective"]["mental_status_exam"]) => (val: string) => { setNote((prev) => { const next = deepClone(prev); (next.objective.mental_status_exam as any)[key] = val; return next; }); }, []);
  const setRisk = useCallback((key: keyof SoapNote["soap_note"]["assessment"]["risk_assessment"]) => (val: string) => { setNote((prev) => { const next = deepClone(prev); (next.assessment.risk_assessment as any)[key] = val; return next; }); }, []);
  const setDx = useCallback((i: number, key: keyof Diagnosis) => (val: string) => { setNote((prev) => { const next = deepClone(prev); if (next.assessment.diagnoses?.[i]) (next.assessment.diagnoses[i] as any)[key] = val; return next; }); }, []);
  const setPsychList = useCallback((i: number, key: keyof PsychometricAnalysis) => (val: string) => { setNote((prev) => { const next = deepClone(prev); if (next.assessment.psychometric_analysis?.[i]) (next.assessment.psychometric_analysis[i] as any)[key] = val.split("\n").map((l) => l.trim()).filter(Boolean); return next; }); }, []);
  const setMed = useCallback((i: number, key: keyof Medication) => (val: string) => { setNote((prev) => { const next = deepClone(prev); if (next.plan.medications?.[i]) (next.plan.medications[i] as any)[key] = val; return next; }); }, []);
  const setPlan = useCallback((key: keyof SoapNote["soap_note"]["plan"]) => (val: string) => { setNote((prev) => { const next = deepClone(prev); (next.plan as any)[key] = val; return next; }); }, []);
  const setPlanList = useCallback((key: keyof SoapNote["soap_note"]["plan"]) => (val: string) => { setNote((prev) => { const next = deepClone(prev); (next.plan as any)[key] = val.split("\n").map((l) => l.trim()).filter(Boolean); return next; }); }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(toEhrText(note, verified, physicianName, regId));
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = toEhrText(note, verified, physicianName, regId);
      document.body.appendChild(ta);
      ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
      setCopied(true); clearTimeout(copiedTimer.current); copiedTimer.current = setTimeout(() => setCopied(false), 2500);
    }
  }, [note, verified, physicianName, regId]);

  const handlePrint = () => {
    if (verified) window.print();
  };

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const { hpi } = note.subjective;
  const { mental_status_exam: mse } = note.objective;
  const asmt = note.assessment;
  const risk = asmt.risk_assessment;
  const plan = note.plan;
  const strList = (arr: string[] | null | undefined) => arr?.join("\n") ?? "";

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;1,400&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&family=DM+Mono:wght@400;500&display=swap');
        .note-editor-root * { font-family: 'DM Sans', sans-serif; }
        .font-lora { font-family: 'Lora', Georgia, serif; }
        .font-mono { font-family: 'DM Mono', monospace; }
        @keyframes slide-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        .slide-in { animation: slide-in 0.4s cubic-bezier(0.22,1,0.36,1) both; }
        @keyframes pop { 0% { transform: scale(0.94); opacity: 0; } 60% { transform: scale(1.03); } 100% { transform: scale(1); opacity: 1; } }
        .pop { animation: pop 0.3s cubic-bezier(0.22,1,0.36,1) both; }
        
        @media print {
          body { background: white !important; }
          .note-editor-root { background: white !important; padding: 0 !important; }
        }
      `}</style>

      <div className="note-editor-root min-h-screen bg-[#f4f7f6] print:bg-white">
        
        <header className="sticky top-0 z-30 bg-[#f4f7f6]/90 backdrop-blur-sm border-b border-[#e1e8e6] print:hidden">
          <div className="max-w-3xl mx-auto px-6 h-14 flex items-center justify-between">
            <div className="flex items-center gap-3">
              {onNewSession && (
                <button onClick={onNewSession} className="text-[12px] text-[#718a85] hover:text-[#179ea1] transition-colors flex items-center gap-1.5 focus:outline-none">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
                  New session
                </button>
              )}
              <span className="text-[#d3dedb] select-none">·</span>
              <span className="text-[11px] text-[#718a85]">{new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</span>
            </div>
            <div className="flex items-center gap-2.5">
              {data.transcription_confidence && (
                <span className="text-[9.5px] font-[600] tracking-[0.12em] uppercase px-2 py-0.5 rounded border bg-emerald-50 text-emerald-700 border-emerald-200">
                  {data.transcription_confidence} confidence
                </span>
              )}
              <span className="text-[9.5px] font-[600] tracking-[0.12em] uppercase px-2 py-0.5 rounded border bg-[#fff8ec] text-[#a16207] border-[#fde68a]">AI Draft</span>
            </div>
          </div>
        </header>

        <main className="max-w-3xl mx-auto px-6 py-12 space-y-12 slide-in print:py-0 print:space-y-6">
          
          <div className="pb-2 border-b border-[#e1e8e6] print:border-black print:pb-4 print:mb-8">
            <p className="hidden print:block text-[10px] font-bold tracking-[0.2em] text-[#179ea1] uppercase mb-2">Metro Mind • Clinical Record</p>
            <h1 className="font-lora text-[2rem] font-[600] text-[#111] leading-tight print:text-[24px]">Psychiatric SOAP Note</h1>
            <p className="text-[12px] text-[#aaa] mt-1.5 leading-relaxed print:text-black">
              Date of Encounter: {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            </p>
          </div>

          <Section letter="S" title="Subjective" subtitle="History of Present Illness">
            <FieldGrid>
              <Field label="Chief Complaint" value={hpi.chief_complaint ?? ""} onChange={setHpi("chief_complaint")} />
              <Field label="Onset" value={hpi.onset ?? ""} onChange={setHpi("onset")} />
              <Field label="Duration" value={hpi.duration ?? ""} onChange={setHpi("duration")} />
              <Field label="Psychiatric History" value={hpi.psychiatric_history ?? ""} onChange={setHpi("psychiatric_history")} />
            </FieldGrid>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
              <ListField label="Precipitating Factors" value={strList(hpi.precipitating_factors)} onChange={setHpiList("precipitating_factors")} />
              <ListField label="Active Symptoms" value={strList(hpi.symptoms)} onChange={setHpiList("symptoms")} />
              <ListField label="Current Medications" value={strList(hpi.medications)} onChange={setHpiList("medications")} />
            </div>
          </Section>

          <Section letter="O" title="Objective" subtitle="Mental Status Examination">
            <FieldGrid>
              <Field label="Appearance" value={mse.appearance ?? ""} onChange={setMse("appearance")} />
              <Field label="Behavior" value={mse.behavior ?? ""} onChange={setMse("behavior")} />
              <Field label="Speech" value={mse.speech ?? ""} onChange={setMse("speech")} />
              <Field label="Mood" value={mse.mood ?? ""} onChange={setMse("mood")} />
              <Field label="Affect" value={mse.affect ?? ""} onChange={setMse("affect")} />
              <Field label="Thought Process" value={mse.thought_process ?? ""} onChange={setMse("thought_process")} />
              <Field label="Thought Content" value={mse.thought_content ?? ""} onChange={setMse("thought_content")} />
              <Field label="Cognition" value={mse.cognition ?? ""} onChange={setMse("cognition")} />
            </FieldGrid>
          </Section>

          <Section letter="A" title="Assessment" subtitle="Diagnoses, Risk Stratification & Psychometrics">
            {asmt.diagnoses && asmt.diagnoses.map((dx, i) => (
              <div key={i} className="mb-4 print:mb-2">
                <Field label={`Dx ${i + 1} (${dx.status})`} value={`${dx.icd10_code ?? ""} — ${dx.description ?? ""}`} onChange={() => {}} />
              </div>
            ))}
            <Sub title="Risk Assessment">
              <div className="rounded-xl border border-[#d3dedb] bg-white px-4 py-4 space-y-4 mb-6 print:border-none print:px-0 print:py-0">
                <Field label="Clinical Rationale" value={risk.clinical_rationale ?? ""} onChange={setRisk("clinical_rationale")} />
              </div>
            </Sub>

            {/* Psychometric Co-Pilot */}
            {asmt.psychometric_analysis && asmt.psychometric_analysis.length > 0 && (
              <Sub title="Psychometric Analysis (Co-Pilot)">
                <div className="space-y-4">
                  {asmt.psychometric_analysis.map((psy, i) => (
                    <div key={i} className="rounded-xl border border-[#d2dce6] bg-[#f8fbff] px-5 py-4 space-y-4 shadow-sm print:bg-transparent print:border-gray-300">
                      <div className="flex items-center justify-between border-b border-[#e5ecf5] pb-3 print:border-gray-300">
                        <div className="flex items-center gap-3">
                          <span className="text-[15px] font-[600] text-[#1c3a59] font-lora tracking-wide print:text-black">{psy.scale_name}</span>
                          <span className="text-[9.5px] font-[700] tracking-[0.1em] uppercase px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 print:bg-transparent print:text-black print:border print:border-black">
                            Relevance: {psy.relevance_to_session}
                          </span>
                        </div>
                        <span className="text-[10px] font-[600] tracking-[0.1em] uppercase px-2.5 py-1 rounded bg-white border border-[#c4d7ea] text-[#4a6b8c] print:border-black print:text-black">
                          Severity: {psy.narrative_severity_estimate}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
                        <ListField label="Symptoms Endorsed (Mapped)" value={strList(psy.symptoms_mapped_to_scale)} onChange={setPsychList(i, "symptoms_mapped_to_scale")} />
                        <ListField label="Missing Domains (To Evaluate)" value={strList(psy.missing_domains_to_evaluate)} onChange={setPsychList(i, "missing_domains_to_evaluate")} />
                      </div>
                    </div>
                  ))}
                </div>
              </Sub>
            )}
          </Section>

          <Section letter="P" title="Plan">
            <FieldGrid>
              <Field label="Psychotherapy" value={plan.psychotherapy ?? ""} onChange={setPlan("psychotherapy")} />
              <Field label="Follow-Up" value={plan.follow_up ?? ""} onChange={setPlan("follow_up")} />
            </FieldGrid>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4 pt-4">
              <ListField label="Referrals" value={strList(plan.referrals)} onChange={setPlanList("referrals")} />
            </div>
          </Section>

          {/* ── Signature & Verification ────────────────────────────────────────── */}
          <section className="pt-8 mt-8 border-t border-[#e1e8e6] print:border-t print:border-black print:mt-12 print:pt-6">
            <div className="bg-white p-6 rounded-xl border border-[#d3dedb] shadow-sm shadow-[#179ea1]/5 print:border-none print:shadow-none print:p-0 print:bg-transparent">
              <h3 className="text-[15px] font-[600] text-[#2c3d3a] font-lora mb-4 print:hidden">
                Clinician Verification
              </h3>

              <label className="flex items-start gap-3 cursor-pointer group print:hidden mb-6">
                <div className="relative flex items-center justify-center w-5 h-5 mt-0.5 rounded border border-[#d3dedb] bg-[#f4f7f6] group-hover:border-[#179ea1] transition-colors">
                  <input
                    type="checkbox"
                    className="absolute opacity-0 w-full h-full cursor-pointer"
                    checked={verified}
                    onChange={(e) => setVerified(e.target.checked)}
                  />
                  {verified && <CheckIcon className="text-[#179ea1] w-4 h-4" />}
                </div>
                <p className="text-[13px] text-[#4a6b8c] leading-relaxed select-none">
                  I have reviewed this AI-generated draft, edited it for clinical accuracy, and verify its contents as a true reflection of the psychiatric encounter.
                </p>
              </label>

              {/* Signature Fields automatically pulled from login */}
              <div className={`grid grid-cols-1 sm:grid-cols-2 gap-6 transition-opacity ${!verified ? 'opacity-40 pointer-events-none' : 'opacity-100'} print:opacity-100 print:pointer-events-auto`}>
                <div>
                  <p className="text-[9.5px] font-[600] tracking-[0.14em] uppercase text-[#718a85] mb-[5px] print:text-black">
                    Psychiatrist Name
                  </p>
                  <p className="w-full text-[15px] font-[500] text-[#1a1a18] pb-1 print:border-b print:border-black">
                    {physicianName}
                  </p>
                </div>
                <div>
                  <p className="text-[9.5px] font-[600] tracking-[0.14em] uppercase text-[#718a85] mb-[5px] print:text-black">
                    Registration ID
                  </p>
                  <p className="w-full text-[15px] font-[500] text-[#1a1a18] pb-1 print:border-b print:border-black">
                    {regId}
                  </p>
                </div>
                
                {/* Physical signature line for print ONLY */}
                <div className="sm:col-span-2 hidden print:block mt-12 mb-4">
                  <div className="flex justify-between items-end">
                    <div className="w-1/2">
                      <div className="border-b border-black w-4/5 mb-2"></div>
                      <p className="text-[12px] text-black pt-1">Electronically Signed & Verified By</p>
                    </div>
                    <div className="w-1/4">
                      <p className="text-[12px] text-black border-b border-black pb-1 mb-2">
                        {new Date().toLocaleDateString("en-US")}
                      </p>
                      <p className="text-[12px] text-black">Date</p>
                    </div>
                  </div>
                </div>

              </div>
            </div>
          </section>

          {/* Action Buttons (Hidden on Print) */}
          <div className="pt-6 pb-16 flex flex-col sm:flex-row justify-end gap-3 print:hidden">
            <button
              onClick={handlePrint}
              disabled={!verified}
              className={`flex items-center justify-center gap-2.5 text-[13px] font-[600] px-5 py-2.5 rounded-xl border transition-all duration-200 ${
                verified
                  ? "bg-white border-[#179ea1] text-[#179ea1] hover:bg-[#eaf4f3]"
                  : "bg-gray-50 border-gray-200 text-gray-400 cursor-not-allowed"
              }`}
            >
              <PrinterIcon /> Print to PDF
            </button>

            <button 
              onClick={handleCopy} 
              className={["flex items-center justify-center gap-2.5 text-[13px] font-[600] px-5 py-2.5 rounded-xl border transition-all duration-200 shadow-sm", 
                copied 
                  ? "bg-emerald-600 border-emerald-600 text-white pop" 
                  : "bg-gradient-to-r from-[#179ea1] to-[#4bcba2] hover:from-[#14898c] hover:to-[#41af8c] shadow-[#179ea1]/20 border-transparent text-white"
              ].join(" ")}>
              {copied ? <><CheckIcon /> Copied to clipboard</> : <><ClipboardIcon /> Copy to EHR</>}
            </button>
          </div>
        </main>
      </div>
    </>
  );
}

function ClipboardIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/></svg>; }
function CheckIcon({ className }: { className?: string }) { return <svg className={className} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>; }
function PrinterIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>; }