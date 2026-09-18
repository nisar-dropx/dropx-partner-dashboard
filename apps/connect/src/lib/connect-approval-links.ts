export const connectApprovalSections = ["time-off", "wfh", "business-trip", "attendance", "rosters", "location-integrity", "reimbursements", "exits", "pay-advances", "payments"] as const;
export type ConnectApprovalSection = typeof connectApprovalSections[number];

export function connectApprovalSection(value: string | null | undefined): ConnectApprovalSection | null {
  return connectApprovalSections.includes(value as ConnectApprovalSection) ? value as ConnectApprovalSection : null;
}
