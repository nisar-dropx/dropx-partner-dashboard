export const dropxOnePageCodes = [
  "dashboard",
  "profile",
  "documents",
  "connect",
  "approvals",
  "earnings",
  "rate_card",
  "advances",
  "reimbursements",
  "attendance",
  "roster",
  "leave",
  "performance",
  "settings"
] as const;

export type DropxOnePageCode = typeof dropxOnePageCodes[number];
export const requiredDropxOnePageCodes: DropxOnePageCode[] = ["profile", "settings"];
