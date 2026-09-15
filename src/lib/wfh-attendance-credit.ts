export type WfhCreditState = "upcoming" | "in_progress" | "awaiting_finalization" | "credited";
export type WfhCreditRow = {
  work_mode?: string | null;
  wfh_scheduled_start_at?: string | null;
  wfh_scheduled_end_at?: string | null;
  wfh_credit_finalized_at?: string | null;
  in_time?: string | null;
  out_time?: string | null;
  punch_count?: number | null;
};

/** Approval and policy credit are separate from recorded attendance punches. */
export function wfhCreditState(row: WfhCreditRow, now = Date.now()): WfhCreditState | null {
  if (row.work_mode !== "wfh" || row.in_time || row.out_time || Number(row.punch_count ?? 0) > 0) return null;
  const start = Date.parse(row.wfh_scheduled_start_at ?? "");
  const end = Date.parse(row.wfh_scheduled_end_at ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  if (now < start) return "upcoming";
  if (now < end) return "in_progress";
  const finalized = Date.parse(row.wfh_credit_finalized_at ?? "");
  return Number.isFinite(finalized) && finalized >= end && finalized <= now ? "credited" : "awaiting_finalization";
}

export function wfhCreditLabel(state: WfhCreditState): string {
  return { upcoming: "WFH approved · Upcoming", in_progress: "WFH approved · Day in progress",
    awaiting_finalization: "WFH approved · Finalizing", credited: "Present · WFH credit" }[state];
}
