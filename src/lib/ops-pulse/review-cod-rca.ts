import type { ReviewCodSnapshot } from "./review-cod";

export const COD_REMARK_KEY = "cod_pending_2plus";
export const COD_REMARK_MAX = 240;
export const isCodRemarkKey = (key: string) => key === COD_REMARK_KEY;
export const codRemarkMoney = (value: number) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** Same verified snapshot and 2+ day classification as the COD card. Never age a stale import to today. */
export function buildCodRca(snapshot: ReviewCodSnapshot) {
  if (snapshot.error || !snapshot.summary || !(snapshot.summary.overdueAmount > 0)) return [];
  const amount = snapshot.summary.overdueAmount;
  const imported = snapshot.importedAt ? new Date(snapshot.importedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "Not supplied";
  return [{ key: COD_REMARK_KEY, label: "COD pending · 2+ days", short: "COD aged 2+ days",
    actual: amount, target: 0, direction: "lower" as const, severity: "red" as const, reasonOnly: true as const,
    evidence: `${codRemarkMoney(amount)} pending for 2+ days · Latest imported position: ${imported} IST. 0–1 day balances do not need a remark. This is not a historical review-day balance.` }];
}

export function codRemark(value: string) {
  const remark = value.replace(/\s+/g, " ").trim();
  if (!remark) throw Error("Add a short COD pendency reason / remark.");
  if (remark.length > COD_REMARK_MAX) throw Error(`Keep the COD remark within ${COD_REMARK_MAX} characters.`);
  return remark;
}

export function missingCodRemark(rows: { key: string }[], items: { metric_key: string; root_cause: string | null }[]) {
  return rows.length > 0 && !items.some(item => isCodRemarkKey(item.metric_key) && Boolean(item.root_cause?.trim()));
}
