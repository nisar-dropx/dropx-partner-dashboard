import styles from "./nl-loss.module.css";
const money = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);
export function LossFinalMetrics({
  summary: s,
}: {
  summary: {
    count: number;
    amount: number;
    updated: number;
    updatedAmount: number;
    pendingUpdate: number;
    pendingUpdateAmount: number;
    nonrecoverable?: number;
    nonrecoverableAmount?: number;
  };
}) {
  return (
    <div className={styles.finalMetrics}>
      <div>
        <span>Filtered shipments</span>
        <strong>{s.count.toLocaleString("en-IN")}</strong>
        <small>{money(s.amount)}</small>
      </div>
      <div>
        <span>Recovery details updated</span>
        <strong>{s.updated.toLocaleString("en-IN")}</strong>
        <small>{money(s.updatedAmount)}</small>
      </div>
      <div>
        <span>Pending recovery update</span>
        <strong>{s.pendingUpdate.toLocaleString("en-IN")}</strong>
        <small>{money(s.pendingUpdateAmount)}</small>
      </div>
      {!!s.nonrecoverable && (
        <div>
          <span>Non-recoverable · no update needed</span>
          <strong>{s.nonrecoverable.toLocaleString("en-IN")}</strong>
          <small>{money(s.nonrecoverableAmount || 0)}</small>
        </div>
      )}
    </div>
  );
}
