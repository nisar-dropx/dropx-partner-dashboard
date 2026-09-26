export const dropxOnePageOptions = [
  { value: "dashboard", label: "Dashboard" },
  { value: "profile", label: "My Profile" },
  { value: "documents", label: "Documents" },
  { value: "approvals", label: "Approval Inbox" },
  { value: "connect", label: "Connect" },
  { value: "advances", label: "Advances" },
  { value: "earnings", label: "My Earnings" },
  { value: "rate_card", label: "My Rate Card" },
  { value: "reimbursements", label: "Reimbursements" },
  { value: "attendance", label: "Attendance" },
  { value: "roster", label: "Roster" },
  { value: "leave", label: "Leave" },
  { value: "wfh", label: "Work from home" },
  { value: "performance", label: "Performance" },
  { value: "refer_earn", label: "Refer & Earn" },
  { value: "settings", label: "Settings" }
] as const;

export const dropxOnePageCodes = new Set<string>(dropxOnePageOptions.map((page) => page.value));
export const requiredDropxOnePageCodes = ["profile", "settings"] as const;
