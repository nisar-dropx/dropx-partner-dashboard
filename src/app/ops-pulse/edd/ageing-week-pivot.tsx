/** State × ISO week of promised delivery date — Sum of Order Amount (Ageing let.xlsx). */

import type { CSSProperties } from "react";

export type AgeingWeekAmountRow = {
  state: string;
  week: string;
  amount: number;
  count: number;
};

function weekRank(week: string): number {
  if (week === "(blank)") return 100000;
  const m = /^week(\d+)$/i.exec(week);
  return m ? Number(m[1]) : 50000;
}

function inr(n: number) {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function AgeingWeekPivot({ rows, title }: { rows: AgeingWeekAmountRow[] | undefined; title?: string }) {
  const data = Array.isArray(rows) ? rows : [];
  if (!data.length) return null;

  const weeks = [...new Set(data.map((r) => r.week))].sort((a, b) => weekRank(a) - weekRank(b));
  const states = [...new Set(data.map((r) => r.state))].sort((a, b) => a.localeCompare(b));
  const cell = new Map(data.map((r) => [`${r.state}\t${r.week}`, r]));
  const colTot = weeks.map((w) => data.filter((r) => r.week === w).reduce((s, r) => s + r.amount, 0));
  const grand = colTot.reduce((a, b) => a + b, 0);

  return (
    <section style={{ margin: "1.25rem 0", overflowX: "auto" }}>
      <h3 style={{ margin: "0 0 0.35rem", fontSize: "1rem" }}>{title ?? "Sum of Order Amount"}</h3>
      <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", opacity: 0.75 }}>
        State × ISO week of Promised Delivery Date — same layout as Ageing let.xlsx
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.85rem", minWidth: 640 }}>
        <thead>
          <tr>
            <th style={th}>Row Labels</th>
            {weeks.map((w) => (
              <th key={w} style={{ ...th, textAlign: "right" }}>{w}</th>
            ))}
            <th style={{ ...th, textAlign: "right" }}>Grand Total</th>
          </tr>
        </thead>
        <tbody>
          {states.map((state) => {
            const rowAmt = weeks.map((w) => cell.get(`${state}\t${w}`)?.amount ?? 0);
            const rowTot = rowAmt.reduce((a, b) => a + b, 0);
            return (
              <tr key={state}>
                <td style={td}>{state}</td>
                {rowAmt.map((amt, i) => (
                  <td key={weeks[i]} style={{ ...td, textAlign: "right" }}>{amt ? inr(amt) : ""}</td>
                ))}
                <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{inr(rowTot)}</td>
              </tr>
            );
          })}
          <tr>
            <td style={{ ...td, fontWeight: 700 }}>Grand Total</td>
            {colTot.map((amt, i) => (
              <td key={weeks[i]} style={{ ...td, textAlign: "right", fontWeight: 700 }}>{inr(amt)}</td>
            ))}
            <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{inr(grand)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

const th: CSSProperties = {
  textAlign: "left",
  padding: "6px 8px",
  borderBottom: "2px solid #1f7a4d",
  background: "#1f7a4d",
  color: "#fff",
  whiteSpace: "nowrap",
};

const td: CSSProperties = {
  padding: "5px 8px",
  borderBottom: "1px solid #d7e2e8",
  whiteSpace: "nowrap",
};
