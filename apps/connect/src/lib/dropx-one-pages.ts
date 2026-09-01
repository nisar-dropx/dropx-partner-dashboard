export const dropxOnePageCodes = [
  "dashboard",
  "profile",
  "documents",
  "approvals",
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
