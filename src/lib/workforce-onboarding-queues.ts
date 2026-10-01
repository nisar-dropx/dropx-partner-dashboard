import type { PartnerOnboardingState } from "@/lib/partner-onboarding";

export const workforceRegisterViews = ["training", "registration", "amazon", "active", "attention"] as const;

export type WorkforceRegisterView = typeof workforceRegisterViews[number];

export type WorkforceOnboardingQueueRow = {
  isActive: boolean;
  onboardingStatus?: string | null;
  partnerOnboarding?: PartnerOnboardingState;
};

const attentionStages = new Set([
  "exception",
  "invitation_failed",
  "background_check",
  "learning",
  "documents",
  "partner_action_pending"
]);

function normalizedStatus(row: WorkforceOnboardingQueueRow) {
  return String(row.onboardingStatus ?? "").trim().toLowerCase();
}

export function workforceOnboardingView(value: unknown): WorkforceRegisterView {
  const candidate = String(value ?? "").trim().toLowerCase();
  if ((workforceRegisterViews as readonly string[]).includes(candidate)) return candidate as WorkforceRegisterView;
  // Preserve old bookmarked URLs while moving users to the more precise queue.
  if (candidate === "active") return "active";
  if (candidate === "due") return "attention";
  if (candidate === "pending") return "training";
  return "training";
}

export function needsWorkforceAttention(row: WorkforceOnboardingQueueRow) {
  const state = row.partnerOnboarding;
  return Boolean(state?.due_kind || attentionStages.has(state?.stage ?? ""));
}

export function workforceQueueFor(row: WorkforceOnboardingQueueRow, view: WorkforceRegisterView) {
  const state = row.partnerOnboarding;
  const onboardingStatus = normalizedStatus(row);

  if (view === "attention") return needsWorkforceAttention(row);

  if (view === "active") {
    return Boolean(state ? state.mapping_confirmed : row.isActive && onboardingStatus === "active");
  }

  if (view === "training") {
    return Boolean(state && !state.mapping_confirmed && !state.reported_on && !needsWorkforceAttention(row));
  }

  if (view === "registration") {
    if (state) return !state.registration_ready && Boolean(state.reported_on) && !needsWorkforceAttention(row);
    return ["pending", "returned", "under_review"].includes(onboardingStatus);
  }

  return Boolean(state && state.registration_ready && !state.mapping_confirmed && !needsWorkforceAttention(row));
}

export function workforceQueueCounts(rows: WorkforceOnboardingQueueRow[]) {
  return Object.fromEntries(workforceRegisterViews.map((view) => [
    view,
    rows.filter((row) => workforceQueueFor(row, view)).length
  ])) as Record<WorkforceRegisterView, number>;
}

export function workforceRegistrationLabel(row: WorkforceOnboardingQueueRow & { registrationDraftAt?: string | null }) {
  const onboardingStatus = normalizedStatus(row);
  if (row.partnerOnboarding?.registration_ready) return "Registration complete";
  if (row.registrationDraftAt) return "DropX One draft saved";
  if (onboardingStatus === "under_review") return "Registration submitted";
  if (onboardingStatus === "returned") return "Correction requested";
  return "Registration invite pending";
}

export function workforceNextAction(row: WorkforceOnboardingQueueRow & { registrationDraftAt?: string | null }) {
  const state = row.partnerOnboarding;
  if (needsWorkforceAttention(row)) return state?.instruction || "Review the pending partner step.";
  if (!state) return workforceRegistrationLabel(row);
  if (!state.reported_on) return "Record the associate's first reporting day when training starts.";
  if (!state.registration_ready) return "Ask the associate to complete the DropX One registration.";
  if (state.mapping_confirmed) return "No action needed.";
  return state.instruction;
}
