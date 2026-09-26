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
