/**
 * Cloak's live month moves through four hand-offs before it becomes historic:
 * eDSP1 (we dispute) → NL1 (Amazon reviews) → eDSP2 (we answer Amazon's queries) → NL2 (final review).
 * Deadlines come from Cloak as "11 October" — a day in India with no year.
 */
export const WINDOW_STAGES = ["eDSP1", "NL1", "eDSP2", "NL2"] as const;
export type WindowStage = (typeof WINDOW_STAGES)[number];
/** Last day (India, inclusive) of each stage, YYYY-MM-DD. Missing = Cloak has not published it. */
export type LiveWindow = Partial<Record<WindowStage, string>>;

export const STAGE_COPY: Record<
  WindowStage,
  { title: string; owner: "station" | "amazon"; detail: string }
> = {
  eDSP1: {
    title: "Dispute window",
    owner: "station",
    detail: "Stations dispute or accept each loss.",
  },
  NL1: {
    title: "Amazon review",
    owner: "amazon",
    detail: "Amazon reviews the disputes and may ask for more details.",
  },
  eDSP2: {
    title: "Respond to Amazon",
    owner: "station",
    detail: "Answer the cases Amazon sent back for more details.",
  },
  NL2: {
    title: "Final review",
    owner: "amazon",
    detail: "Amazon closes the remaining cases.",
  },
};

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const DAY = 86_400_000;
/** The instant a deadline day ends in India. */
const endOfDay = (date: string) => Date.parse(`${date}T23:59:59.999+05:30`);
const indiaDate = (now: Date) =>
  new Date(now.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export function parseLiveWindow(input: unknown, now = new Date()): LiveWindow {
  const window: LiveWindow = {};
  if (!Array.isArray(input)) return window;
  const year = Number(indiaDate(now).slice(0, 4));
  for (const item of input) {
    const stage = String(item?.current_sla_stage ?? "") as WindowStage;
    const match = /^\s*(\d{1,2})\s+([A-Za-z]+)\s*$/.exec(
      String(item?.sla_date ?? ""),
    );
    const month = match ? MONTHS.indexOf(match[2]!.toLowerCase()) : -1;
    if (!WINDOW_STAGES.includes(stage) || !match || month < 0) continue;
    const day = Number(match[1]);
    // No year in the source: the deadline is whichever occurrence is nearest to today.
    const dates = [year - 1, year, year + 1]
      .map((y) => new Date(Date.UTC(y, month, day)))
      .filter((d) => d.getUTCMonth() === month)
      .sort(
        (a, b) =>
          Math.abs(a.getTime() - now.getTime()) -
          Math.abs(b.getTime() - now.getTime()),
      );
    if (dates[0]) window[stage] = dates[0].toISOString().slice(0, 10);
  }
  return window;
}

/** Whole India calendar days from today to the deadline (0 = closes today, negative = closed). */
export function daysUntil(date: string, now = new Date()) {
  return Math.round(
    (Date.parse(`${date}T00:00:00Z`) -
      Date.parse(`${indiaDate(now)}T00:00:00Z`)) /
      DAY,
  );
}

export function windowSummary(window: LiveWindow, now = new Date()) {
  const known = WINDOW_STAGES.filter((s) => window[s]);
  if (!known.length)
    return { stage: null, deadline: null, daysLeft: null } as const;
  const stage = known.find((s) => endOfDay(window[s]!) >= now.getTime());
  if (!stage)
    return { stage: "Completed", deadline: null, daysLeft: null } as const;
  return {
    stage,
    deadline: window[stage]!,
    daysLeft: daysUntil(window[stage]!, now),
  } as const;
}

export type LiveCaseLike = {
  case_status?: string | null;
  nl_status?: string | null;
  extra?: Record<string, string | null | undefined> | null;
};
export type PhaseKey =
  | "action"
  | "respond"
  | "amazon"
  | "accepted"
  | "won"
  | "lost"
  | "missed";
export const PHASES: Record<
  PhaseKey,
  { label: string; tone: "warn" | "info" | "good" | "bad" | "muted" }
> = {
  action: { label: "Dispute pending", tone: "warn" },
  respond: { label: "Amazon asked for details", tone: "warn" },
  amazon: { label: "With Amazon", tone: "info" },
  accepted: { label: "Accepted · not disputed", tone: "muted" },
  won: { label: "Non-recoverable", tone: "good" },
  lost: { label: "Recoverable", tone: "bad" },
  missed: { label: "SLA missed", tone: "bad" },
};

export function casePhase(c: LiveCaseLike): { key: PhaseKey } & (typeof PHASES)[PhaseKey] {
  const status = String(c.case_status ?? "").toLowerCase();
  const stage = String(c.extra?.current_sla_stage ?? "");
  const decision = String(c.nl_status ?? "").toLowerCase();
  let key: PhaseKey;
  if (status === "resolved")
    key = decision.startsWith("non-recoverable") ? "won" : "lost";
  else if (status === "not_disputed") key = "accepted";
  else if (status === "sla_missed") key = "missed";
  else if (stage === "eDSP2") key = "respond";
  else if (stage === "NL1" || stage === "NL2") key = "amazon";
  else if (stage === "eDSP1" || status === "not_started") key = "action";
  else key = "amazon";
  return { key, ...PHASES[key] };
}

/** Whether the station may still raise (or answer) a dispute for this case. */
export function disputeGate(c: LiveCaseLike, window: LiveWindow, now = new Date()) {
  const phase = casePhase(c).key;
  if (phase !== "action" && phase !== "respond")
    return {
      open: false,
      kind: null,
      deadline: null,
      reason:
        phase === "amazon"
          ? "Amazon is reviewing this case."
          : "This case is closed in Cloak.",
    } as const;
  const kind = phase === "action" ? "dispute" : "respond";
  const deadline = window[phase === "action" ? "eDSP1" : "eDSP2"] ?? null;
  // Cloak still shows the case with us; an unpublished deadline must not lock the station out.
  const open = !deadline || endOfDay(deadline) >= now.getTime();
  return {
    open,
    kind,
    deadline,
    reason: open
      ? ""
      : `The ${kind === "dispute" ? "dispute" : "response"} window closed on ${deadline}.`,
  } as const;
}

/** Reasons Cloak offers when a dispute is filed (from its dispute form). */
export const DISPUTE_REASONS = [
  "WRTS but MDR",
  "Shipment returned to origin",
  "Delivered/Cash in Bank",
  "Scan Update Issue",
  "Scan Marked by someone not from Station",
  "Pickup Done Issue",
  "Processed as Orphan",
  "BuyBack Recovery",
  "Seller Issue",
  "Physically available at SP",
  "Reject Label Issue",
  "Double label issue",
  "Customer Abuse",
  "Other",
];

export type DisputeRequest = {
  decision: "dispute" | "accept";
  reason: string;
  remarks: string;
  cctv_url: string | null;
  attachments: { id: string; file_name: string }[];
  status: "draft" | "submitted" | "returned" | "filed";
  desk_note: string;
  /** Cloak stage the request was last saved in (eDSP1 dispute, eDSP2 response). */
  source_stage: string | null;
  version: number;
  updated_by_name: string;
  updated_at: string;
  submitted_at: string | null;
  filed_at: string | null;
};
/**
 * Cloak shows the request was filed: the case has left the station's hands and
 * Cloak holds the same decision the station asked for. Lets a sent request close
 * itself on the next hourly pull without anyone marking it.
 */
export function filedInCloak(
  request: Pick<DisputeRequest, "decision" | "status"> | null,
  c: LiveCaseLike,
) {
  if (!request || (request.status !== "submitted" && request.status !== "filed"))
    return false;
  if (request.status === "filed") return true;
  const phase = casePhase(c).key;
  const held = String(c.extra?.dispute_selected ?? "").toUpperCase();
  return (
    phase !== "action" &&
    phase !== "respond" &&
    held === (request.decision === "dispute" ? "YES" : "NO")
  );
}
/**
 * The request is with the Cloak desk (or filed) for the stage the case is in now.
 * One sent during eDSP1 no longer counts once Amazon returns the case in eDSP2.
 */
export function requestSent(
  request: Pick<DisputeRequest, "status" | "source_stage"> | null | undefined,
  stage: string | null | undefined,
) {
  return (
    !!request &&
    (request.status === "submitted" || request.status === "filed") &&
    (request.source_stage ?? "") === (stage ?? "")
  );
}
export const REQUEST_STATUS: Record<
  DisputeRequest["status"],
  { label: string; tone: "warn" | "info" | "good" | "muted" }
> = {
  draft: { label: "Draft", tone: "muted" },
  submitted: { label: "Sent to Cloak desk", tone: "info" },
  returned: { label: "Returned by desk", tone: "warn" },
  filed: { label: "Filed in Cloak", tone: "good" },
};
