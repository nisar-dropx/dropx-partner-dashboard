export const dropxOnePageOptions = [
  { value: "dashboard", label: "Dashboard" },
  { value: "profile", label: "My Profile" },
  { value: "documents", label: "Documents" },
  { value: "approvals", label: "Approval Inbox" },
  { value: "advances", label: "Advances" },
  { value: "reimbursements", label: "Reimbursements" },
  { value: "attendance", label: "Attendance" },
  { value: "roster", label: "Roster" },
  { value: "leave", label: "Leave" },
  { value: "performance", label: "Performance" },
  { value: "settings", label: "Settings" }
] as const;

export const dropxOnePageCodes = new Set<string>(dropxOnePageOptions.map((page) => page.value));
export const requiredDropxOnePageCodes = ["profile", "settings"] as const;
