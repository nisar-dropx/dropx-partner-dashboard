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

/** People self-service records are available to every People designation; Workforce masters stay unchanged. */
export function peopleDocumentsAvailable(account: { profileType: string; workspace?: string; activationOnly?: boolean } | null) {
  return Boolean(account && !account.activationOnly && account.workspace === "people" && ["employee", "contractor"].includes(account.profileType));
}
