export type CodStatusLocation = { id: string; code: string; name: string; model: string; region: string; manager: string };
export type StatusComponent<T> = { state: 'ok' | 'unavailable'; checkedAt: string; data: T | null };
export type CodRemittance = { id: string; code: string | null; status: string; expectedAmount: number; actualAmount: number; variance: number; createdAt: number | null; updatedAt: number | null; submittedAt: number | null; createdBy: string; submittedBy: string | null };
export type CodStatusSnapshot = {
  version: 1; stationCode: string; date: string; fetchedAt: string; cached?: boolean;
  remittanceWindow: { startTime: number; endTime: number };
  reconciliation: StatusComponent<{ complete: boolean; driverCount: number; pendingCount: number; pendingAmount: number; completedPercent: number; drivers: { id: string; name: string; pendingAmount: number; packages: { trackingId: string; amount: number; paymentMethod: string }[] }[] }>;
  prepareDeposit: StatusComponent<{ expectedAmount: number; actualAmount: number; variance: number }>;
  remittances: StatusComponent<{ complete: boolean; openCount: number; openAmount: number; submittedToday: boolean; latestSubmitted: CodRemittance | null; rows: CodRemittance[] }>;
};
export function codStatusToday(now = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year:'numeric',month:'2-digit',day:'2-digit' }).format(now); }
export function codStatusCategory(snapshot: CodStatusSnapshot | undefined, now = new Date()): 'attention' | 'clear' | 'unavailable' | 'unchecked' {
  if (!snapshot) return 'unchecked';
  if (snapshot.date !== codStatusToday(now)) return 'unavailable';
  const r = snapshot.reconciliation.data, p = snapshot.prepareDeposit.data, m = snapshot.remittances.data;
  if (r?.pendingCount || (p && [p.expectedAmount,p.actualAmount,p.variance].some(v => Math.abs(v) >= 0.01)) || m?.openCount) return 'attention';
  if (!r?.complete || !p || !m?.complete || !m.submittedToday) return 'unavailable';
  return 'clear';
}
