"use client";
import { useMemo, useState } from "react";
import { hasStationSubmission } from "@/lib/ops-pulse/loss-exceptions";
import type { NlCase } from "@/lib/ops-pulse/nl-loss-policy";
import { ListPager, usePaged } from "./list-pager";
import styles from "./nl-loss.module.css";
export type RedisputeWindow = {
  submitted_by?: string | null;
  response_details?: Record<string, string>;
  version: number;
  workflow_status?: string;
  recovery_month?: string;
  month: string;
  case_key: string;
  enabled: boolean;
  tt_reference: string | null;
  tt_url: string | null;
  followup_status: string;
  followup_on: string | null;
  updated_by_name: string | null;
  updated_at: string;
};
export function LossRedisputeDesk({
  rows,
  windows,
  canActivate,
}: {
  rows: NlCase[];
  windows: RedisputeWindow[];
  canActivate: boolean;
}) {
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("open");
  const byKey = useMemo(
    () => new Map(rows.map((r) => [`${r.month}|${r.case_key}`, r])),
    [rows],
  );
  const shown = windows.filter(
    (w) =>
      hasStationSubmission(w) && (status === "all" ||
        (status === "open" && w.enabled) ||
        w.workflow_status === status ||
        w.followup_status === status) &&
      [
        w.case_key,
        w.tt_reference,
        byKey.get(`${w.month}|${w.case_key}`)?.station_code,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const paged = usePaged(shown, 25, `${status}|${query}`);
  const href = (month: string, key: string) => '/team-ops/losses/vendor-response?' + new URLSearchParams({month,case:key});
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <div>
          <h2>Redispute submissions</h2>
          <small>Only station-submitted evidence appears here. Review details, ticket and vendor outcome.</small>
        </div>
        <div className={styles.toolbar}>
          <input
            aria-label="Find redispute or Shipment ID"
            placeholder="Search Shipment ID or ticket"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="Redispute status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {[
              ["open", "Active cases"],
              ["awaiting_review", "Awaiting review"],
              ["approved", "Approved for post-dispute"],
              ["preparing", "Preparing"],
              ["filed", "TT filed"],
              ["with_vendor", "With vendor"],
              ["returned", "Needs response"],
              ["won", "Won · recovery stopped"],
              ["lost", "Lost · continue recovery"],
              ["cancelled", "Disabled / revoked"],
              ["closed", "Closed"],
              ["all", "All cases"],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.ledgerTable}>
          <thead>
            <tr>
              <th>Case</th>
              <th>LSC TT</th>
              <th>Status</th>
              <th>Follow-up</th>
              <th>Last update</th>
              <th>Station reason</th>
            </tr>
          </thead>
          <tbody>
            {paged.rows.map((w) => {
              const row = byKey.get(`${w.month}|${w.case_key}`);
              return (
                <tr key={`${w.month}|${w.case_key}`}>
                  <td>
                    <a href={href(w.month, w.case_key)}>
                      {row?.station_code} · {row?.details.tid || w.case_key}
                    </a>
                    <small>{w.month}</small>
                  </td>
                  <td>
                    {w.tt_url ? (
                      <a href={w.tt_url} target="_blank" rel="noreferrer">
                        {w.tt_reference || "Open TT"} ↗
                      </a>
                    ) : (
                      w.tt_reference || "Not filed"
                    )}
                  </td>
                  <td>
                    {(w.workflow_status || w.followup_status).replaceAll(
                      "_",
                      " ",
                    )}
                    {w.recovery_month ? (
                      <small>Payroll {w.recovery_month}</small>
                    ) : null}
                  </td>
                  <td>{w.followup_on || "—"}</td>
                  <td>
                    {w.updated_by_name}
                    <small>
                      {new Date(w.updated_at).toLocaleDateString("en-IN", {
                        timeZone: "Asia/Kolkata",
                      })}
                    </small>
                  </td>
                  <td>{w.response_details?.reason || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!shown.length ? (
        <p className={styles.empty}>
          No station submissions match. Enabled TIDs appear here after the station submits evidence.
        </p>
      ) : null}
      <ListPager
        page={paged.page}
        pages={paged.pages}
        size={paged.size}
        total={paged.total}
        onPage={paged.setPage}
        onSize={paged.setSize}
        label="redisputes"
      />
    </section>
  );
}
