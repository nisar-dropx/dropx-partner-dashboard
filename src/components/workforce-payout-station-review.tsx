"use client";

import { useMemo } from "react";
import type { WorkforcePayoutRow } from "@/components/workforce-payout-table";

type StationReview = {
  station: string;
  rows: number;
  payable: number;
  review: number;
  blocked: number;
  paid: number;
  amount: number;
};

function money(value: number) {
  return `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function stationStatus(item: StationReview) {
  if (item.blocked > 0) return "Needs attention";
  if (item.review > 0) return "Review pending";
  if (item.payable > 0) return "Ready for Finance";
  return "No payable balance";
}

/**
 * A fast, read-only station control plane. It deliberately derives from the
 * worksheet rows already loaded by the page; adding a station dashboard must
 * not create one query per station or fetch another copy of bank data.
 */
export function WorkforcePayoutStationReview({ rows }: { rows: WorkforcePayoutRow[] }) {
  const stations = useMemo<StationReview[]>(() => {
    const grouped = new Map<string, StationReview>();
    for (const row of rows) {
      const station = row.location?.trim() || "Unassigned";
      const current = grouped.get(station) ?? { station, rows: 0, payable: 0, review: 0, blocked: 0, paid: 0, amount: 0 };
      current.rows += 1;
      if (row.paymentSummary?.paidAmount && row.paymentSummary.paidAmount > 0) current.paid += row.paymentSummary.paidAmount;
      if (row.paymentDetailsAvailable && row.netAmount > 0 && row.paymentSummary?.eligible !== false) {
        current.payable += 1;
        current.amount += row.paymentSummary?.balancePayable ?? row.netAmount;
      }
      if (["Ready for review", "Under Review", "Notification queued"].includes(row.status)) current.review += 1;
      if (!row.paymentDetailsAvailable || row.status.toLowerCase().includes("incomplete") || row.status.toLowerCase().includes("pending")) current.blocked += 1;
      grouped.set(station, current);
    }
    return [...grouped.values()].sort((a, b) => a.station.localeCompare(b.station));
  }, [rows]);

  if (!stations.length) return null;

  return <section className="panel" aria-labelledby="workforce-station-review-title">
    <div className="panel-head">
      <div>
        <h2 id="workforce-station-review-title">Station review</h2>
        <p className="subtle">Confirm each station’s payable balance before selecting rows for Finance.</p>
      </div>
      <span className="subtle">{stations.length} station{stations.length === 1 ? "" : "s"}</span>
    </div>
    <div className="panel-body" style={{ overflowX: "auto" }}>
      <table className="report-table" aria-label="Station payout review">
        <thead><tr><th>Station</th><th>Status</th><th>Rows</th><th>Payable</th><th>Balance</th><th>Paid to date</th></tr></thead>
        <tbody>{stations.map((item) => <tr key={item.station}>
          <th scope="row">{item.station}</th>
          <td>{stationStatus(item)}</td>
          <td>{item.rows.toLocaleString("en-IN")}</td>
          <td>{item.payable.toLocaleString("en-IN")}</td>
          <td>{money(item.amount)}</td>
          <td>{money(item.paid)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}
