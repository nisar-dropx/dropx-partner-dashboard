export type ConnectNotification = {
  event_code?: string;
  id: string; title: string; body: string; route?: string | null;
  created_at: string; read_at?: string | null;
  data?: { caseId?: string; announcementId?: string; showOnDashboard?: boolean; dashboardUntil?: string | null; openNotice?: boolean; ctaLabel?: string; summary?: string | null; presentation?: unknown; tab?: string; payoutMonth?: string; reviewUntil?: string | null };
};

export function expiredConnectNotification(row: ConnectNotification, now = Date.now()) {
  if (row.event_code !== "workforce_payout_review") return false;
  const deadline = Date.parse(String(row.data?.reviewUntil ?? ""));
  return Number.isFinite(deadline) && deadline <= now;
}

/** Display is driven by published notification data, never a payroll date in application code. */
export function visibleDashboardNotices(rows: ConnectNotification[], now = Date.now()) {
  return rows.filter(row => !(row.event_code === "LOSS_RECOVERY_UPDATED" && row.read_at) && row.data?.showOnDashboard === true &&
    (row.data.dashboardUntil === null || (Number.isFinite(Date.parse(row.data.dashboardUntil ?? "")) &&
    Date.parse(row.data.dashboardUntil!) > now)));
}
