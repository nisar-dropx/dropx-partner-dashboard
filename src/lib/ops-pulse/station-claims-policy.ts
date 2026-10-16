/** Station loss claim workflow, shared by the server and the desk. station_claim_transition enforces the same rules. */

export type ClaimStatus = "submitted" | "returned" | "approved" | "rejected" | "withdrawn";
export type ClaimAction = "approve" | "reject" | "return" | "resubmit" | "withdraw";
export type ClaimCategory = "cash_shortage" | "cod_shortage" | "asset_loss" | "shipment_loss" | "damage" | "other";

export const CLAIM_CATEGORIES: Record<ClaimCategory, string> = {
  cash_shortage: "Cash shortage",
  cod_shortage: "COD shortage",
  asset_loss: "Asset lost",
  shipment_loss: "Shipment lost",
  damage: "Damage",
  other: "Other",
};

/** Who acts next, shown on every claim so the station and Ops both know where it stands. */
export const CLAIM_STATUS: Record<ClaimStatus, { label: string; tone: "warn" | "info" | "good" | "muted" | "danger"; next: string }> = {
  submitted: { label: "With cluster manager", tone: "warn", next: "Cluster manager to approve, return or reject" },
  returned: { label: "Returned to station", tone: "danger", next: "Station to add the details asked for and resubmit" },
  approved: { label: "Approved", tone: "good", next: "Assign the people responsible in the recovery panel" },
  rejected: { label: "Rejected", tone: "muted", next: "Closed" },
  withdrawn: { label: "Withdrawn", tone: "muted", next: "Closed" },
};

export function claimActions(
  claim: { status: ClaimStatus; raisedBy: string },
  viewerId: string,
  isApprover: boolean,
  canRaise: boolean,
): ClaimAction[] {
  const mine = claim.raisedBy === viewerId;
  const out: ClaimAction[] = [];
  if (claim.status === "submitted" && isApprover && !mine) out.push("approve", "return", "reject");
  if (mine && canRaise && claim.status === "returned") out.push("resubmit");
  if (mine && canRaise && (claim.status === "submitted" || claim.status === "returned")) out.push("withdraw");
  return out;
}

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export type ClaimInput = {
  stationId: string;
  reference: string;
  incidentDate: string;
  category: string;
  amount: string;
  description: string;
  evidenceUrl: string;
  people: string;
};

export function validateClaim(input: ClaimInput, now = today()) {
  if (!/^[0-9a-f-]{36}$/i.test(input.stationId)) return "Choose the station.";
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]{2,59}$/.test(input.reference.trim())) return "Use a reference of 3–60 letters, numbers, / _ . or -.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.incidentDate)) return "Choose the incident date.";
  const days = (Date.parse(`${now}T00:00:00Z`) - Date.parse(`${input.incidentDate}T00:00:00Z`)) / 86400000;
  if (!(days >= 0 && days <= 180)) return "The incident date must be within the last 180 days.";
  if (!(input.category in CLAIM_CATEGORIES)) return "Choose a category.";
  const amount = Number(input.amount);
  if (!/^\d+(\.\d{1,2})?$/.test(input.amount.trim()) || amount <= 0 || amount > 1_000_000) return "Enter a loss amount between ₹0.01 and ₹10,00,000.";
  const d = input.description.trim().length;
  if (d < 10 || d > 2000) return "Describe the loss (10–2,000 characters).";
  if (input.evidenceUrl.trim() && !/^https:\/\/\S+$/.test(input.evidenceUrl.trim())) return "Evidence must be an https:// link.";
  if (input.people.length > 500) return "Keep the people involved under 500 characters.";
  return "";
}

export function claimNoteError(action: ClaimAction, note: string) {
  const n = note.trim();
  if (n.length > 1000) return "Keep the note under 1,000 characters.";
  if ((action === "reject" || action === "return") && n.length < 5) return "Add a reason (at least 5 characters).";
  return "";
}
