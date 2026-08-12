import { formatAmount } from "@/lib/ops-pulse/cod";

type CiaSummaryTotals = {
  pendingLiability: number;
  pendingDriverCount: number;
  ageingTotal: number;
  ciaTotal: number;
  cashAtStationTotal: number;
  depositedTotal: number;
  cashDifference: number;
  shipmentCount: number;
};

export function CiaSummaryMetrics({ totals }: { totals: CiaSummaryTotals }) {
  return (
    <section className="summary-grid cia-summary-grid">
      <div className="metric-card accent-warn">
        <span>Cash with drivers</span>
        <strong>₹{formatAmount(totals.pendingLiability)}</strong>
        <small>{totals.pendingDriverCount} drivers still holding CIA cash</small>
      </div>
      <div className="metric-card">
        <span>Ageing cash (CIA + station)</span>
        <strong>₹{formatAmount(totals.ageingTotal)}</strong>
        <small>
          CIA ₹{formatAmount(totals.ciaTotal)} · at station ₹{formatAmount(totals.cashAtStationTotal)}
        </small>
      </div>
      <div className="metric-card">
        <span>Bank deposits</span>
        <strong>₹{formatAmount(totals.depositedTotal)}</strong>
        <small>Submitted or created in this period</small>
      </div>
      <div className="metric-card">
        <span>Gap (ageing − deposits)</span>
        <strong>₹{formatAmount(totals.cashDifference)}</strong>
        <small>{totals.shipmentCount.toLocaleString("en-IN")} CASH CIA + station shipments</small>
      </div>
    </section>
  );
}
