import type { PartnerOnboardingState } from "./partner-onboarding";

export type ClientIdPartnerState = {
  queue: "mapping" | "progress" | "attention";
  label: string;
  instruction: string;
  source: string;
  observedAt: string | null;
  transporterId: string | null;
};
export type AmazonProfileLink = {
  workforce_id: string; amazon_provider_id: string | null;
  transporter_id: string | null; last_synced_at: string | null;
};
export type AmazonRosterRecord = {
  provider_id: string | null; transporter_id: string;
  operational_status: string | null; synced_at: string;
};
export type AmazonObservation = {
  workforce_id: string; provider_profile_id: string; progress: string;
  provider_status: string; observed_at: string;
};

const time = (value: string | null | undefined) => value ? new Date(value).getTime() || 0 : 0;

// A profile link proves existence, not activation. Only explicit partner status
// proves activation; absence from an onboarding report never does.
export function clientIdPartnerState(
  link?: AmazonProfileLink,
  roster?: AmazonRosterRecord,
  observation?: AmazonObservation,
  flow?: PartnerOnboardingState,
): ClientIdPartnerState | undefined {
  const evidence: ClientIdPartnerState[] = [];
  const transporterId = link?.transporter_id || flow?.transporter_id || null;
  if (link?.amazon_provider_id && roster?.provider_id === link.amazon_provider_id
    && roster.transporter_id === link.transporter_id) {
    const status = roster.operational_status?.trim().toUpperCase();
    evidence.push({
      queue: status === "ACTIVE" ? "mapping" : status === "ONBOARDING" ? "progress" : "attention",
      label: status === "ACTIVE" ? "ID active · mapping pending" : status === "ONBOARDING" ? "LSC onboarding in progress" : "Existing ID · review required",
      instruction: status === "ACTIVE"
        ? "The Amazon ID is already active. Complete its provider ID mapping in Dashboard. A new invitation is not needed."
        : status === "ONBOARDING"
          ? "An Amazon ID already exists and onboarding is in progress. Complete the pending steps in LSC."
          : `An Amazon ID already exists${status ? ` with status ${status}` : ""}. Review it in LSC before changing its mapping.`,
      source: "LSC roster", observedAt: roster.synced_at, transporterId,
    });
  }
  if (observation && (!link?.amazon_provider_id || observation.provider_profile_id === link.amazon_provider_id)) {
    const needsHelp = /insufficien|rejected|blocked|failed|mismatch/i.test(`${observation.progress} ${observation.provider_status}`);
    evidence.push({ queue: needsHelp ? "attention" : "progress", label: needsHelp ? "LSC onboarding needs attention" : "LSC onboarding in progress",
      instruction: `${observation.progress} · ${observation.provider_status}`, source: "LSC onboarding",
      observedAt: observation.observed_at, transporterId });
  }
  if (flow && !flow.can_trigger && !["active", "registration_pending", "partner_setup_pending"].includes(flow.stage)) {
    evidence.push({ queue: flow.stage === "mapping_pending" ? "mapping" : ["exception", "invitation_failed"].includes(flow.stage) ? "attention" : "progress",
      label: flow.label, instruction: flow.instruction, source: "Partner onboarding report",
      observedAt: flow.report_updated_at, transporterId });
  }
  // A fresh roster must supersede an old learning/BGC report. Conversely, newer
  // onboarding evidence can supersede an older roster without assuming active.
  evidence.sort((a, b) => time(b.observedAt) - time(a.observedAt));
  if (evidence.length) return evidence[0];
  if (link?.amazon_provider_id || link?.transporter_id) return {
    queue: "attention", label: "Existing ID · verify LSC status",
    instruction: "An Amazon profile is already linked. Verify its current LSC status before completing the Dashboard mapping. Do not send another invitation.",
    source: "Amazon profile link", observedAt: link.last_synced_at, transporterId,
  };
}
