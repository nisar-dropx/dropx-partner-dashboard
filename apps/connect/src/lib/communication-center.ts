export const communicationChannels = ["general", "connect", "integrity"] as const;
export type CommunicationChannel = typeof communicationChannels[number];

export const communicationStatuses = [
  "submitted",
  "acknowledged",
  "in_review",
  "action_required",
  "resolved",
  "closed",
  "dismissed"
] as const;

export const communicationUrgencies = ["normal", "high", "critical"] as const;

export const defaultCommunicationSettings = {
  general: {
    title: "Updates",
    subtitle: "Official news and updates from DropX",
    guidance: "Company communication is published by DropX and is read-only in DropX One.",
    categories: [],
    slaHours: 48,
    rewardEnabled: false
  },
  connect: {
    title: "HR Help",
    subtitle: "A private conversation with People & Culture",
    guidance: "Ask about work, pay, attendance, reporting, policy or the app. Only you and authorised People team members can access the conversation.",
    categories: [
      "Work information",
      "Payment query",
      "Attendance query",
      "App or system issue",
      "Suggestion or improvement",
      "Manager or reporting concern",
      "Workplace treatment",
      "Process or policy concern",
      "Health and safety",
      "Other"
    ],
    slaHours: 24,
    rewardEnabled: false
  },
  integrity: {
    title: "Speak Up",
    subtitle: "Confidential fraud, abuse and safety reporting",
    guidance: "Report suspected fraud, theft, abuse, harassment or serious misconduct. Add facts and evidence safely, and do not confront the person involved.",
    categories: [
      "Fraud or falsification",
      "Theft or cash shortage",
      "Shipment misuse",
      "Harassment or abuse",
      "Safety threat",
      "Data or account misuse",
      "Other"
    ],
    slaHours: 12,
    rewardEnabled: true
  }
} satisfies Record<CommunicationChannel, {
  title: string;
  subtitle: string;
  guidance: string;
  categories: string[];
  slaHours: number;
  rewardEnabled: boolean;
}>;

export function isCommunicationChannel(value: unknown): value is CommunicationChannel {
  return communicationChannels.includes(String(value) as CommunicationChannel);
}

export function cleanCommunicationText(value: unknown, max: number) {
  return String(value ?? "").replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

export function communicationCaseNumber(channel: CommunicationChannel, random = crypto.randomUUID()) {
  const prefix = channel === "integrity" ? "SUP" : channel === "connect" ? "HR" : "UPD";
  const date = new Date().toISOString().slice(2, 10).replaceAll("-", "");
  return `DX-${prefix}-${date}-${random.replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

export function validateCommunicationSubmission(input: {
  channel: unknown;
  category: unknown;
  subject: unknown;
  description: unknown;
  urgency?: unknown;
}) {
  if (!isCommunicationChannel(input.channel)) throw new Error("Select a communication channel.");
  if (input.channel === "general") throw new Error("Updates are read-only. Use HR Help to start a conversation.");
  const category = cleanCommunicationText(input.category, 80);
  const subject = cleanCommunicationText(input.subject, 140);
  const description = cleanCommunicationText(input.description, 5000);
  const urgency = String(input.urgency ?? "normal");
  if (!category) throw new Error("Select a category.");
  if (subject.length < 5) throw new Error("Add a short subject.");
  if (description.length < 20) throw new Error("Add enough factual detail for the team to understand your request.");
  if (!communicationUrgencies.includes(urgency as typeof communicationUrgencies[number])) throw new Error("Select a valid urgency.");
  return { channel: input.channel, category, subject, description, urgency };
}
