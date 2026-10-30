export const dropxOnePageCodes = [
  "dashboard",
  "profile",
  "documents",
  "approvals",
  "connect",
  "advances",
  "earnings",
  "rate_card",
  "reimbursements",
  "attendance",
  "roster",
  "leave",
  "wfh",
  "performance",
  "refer_earn",
  "settings"
] as const;

export type DropxOnePageCode = typeof dropxOnePageCodes[number];
export const requiredDropxOnePageCodes: DropxOnePageCode[] = ["profile", "settings"];

// Navigation is not a designation entitlement. Request policies and approval
// workflows still decide whether an individual action can be completed.
export const workforceSelfServicePages = ["dashboard", "profile", "settings", "documents", "connect", "earnings", "rate_card", "advances", "attendance", "roster", "leave", "performance", "refer_earn"] as const;
export function withWorkforceSelfServicePages(pages: string[], account: { profileType: string; workspace?: string; activationOnly?: boolean }) {
  if (account.workspace !== "workforce" || account.profileType === "user" || account.activationOnly) return pages;
  return [...new Set([...pages, ...workforceSelfServicePages])];
}

/** People self-service records are available to every People designation; Workforce masters stay unchanged. */
export function peopleDocumentsAvailable(account: { profileType: string; workspace?: string; activationOnly?: boolean } | null) {
  return Boolean(account && !account.activationOnly && account.workspace === "people" && ["employee", "contractor"].includes(account.profileType));
}
