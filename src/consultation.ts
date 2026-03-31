export interface ConsultationMetadata {
  patientName: string;
  chiefComplaint: string;
  preferredLanguage: string;
}

export const DEFAULT_CONSULTATION_METADATA: ConsultationMetadata = {
  patientName: "",
  chiefComplaint: "",
  preferredLanguage: "English",
};
