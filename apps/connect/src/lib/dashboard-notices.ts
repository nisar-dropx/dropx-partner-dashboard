export type ConnectNotification = {
  id: string; title: string; body: string; route?: string | null;
  created_at: string; read_at?: string | null;
  data?: { showOnDashboard?: boolean; dashboardUntil?: string; openNotice?: boolean; ctaLabel?: string; summary?: string; presentation?: unknown };
};

/** Display is driven by published notification data, never a payroll date in application code. */
export function visibleDashboardNotices(rows: ConnectNotification[], now = Date.now()) {
  return rows.filter(row => row.data?.showOnDashboard === true &&
    Number.isFinite(Date.parse(row.data.dashboardUntil ?? "")) &&
    Date.parse(row.data.dashboardUntil!) > now);
}
