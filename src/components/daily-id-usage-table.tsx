"use client";
import { ChevronRight } from "lucide-react";
import styles from "./daily-id-usage-table.module.css";
import { useEffect, useMemo, useState } from "react";
import { dailyUsageStatus } from "@/lib/daily-id-usage";

export function DailyIdUsageTable({
  rows,
  onReview,
}: {
  rows: any[];
  onReview: (rows: any[]) => void;
}) {
  const [by, setBy] = useState("associate"),
    [expanded, setExpanded] = useState<Set<string>>(() => new Set()),
    [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const entries = useMemo(() => {
    const groups = new Map<
      string,
      { name: string; detail: string; rows: any[] }
    >();
    for (const r of rows) {
      const entries =
        by === "associate"
          ? [{ key: r.workerId, name: r.name, detail: r.dropxId }]
          : (r.usages?.length
              ? r.usages
              : [{ providerId: "", providerName: "No provider ID", client: "" }]
            ).map((u: any) => ({
              key: `${r.stationId}|${u.client}|${u.providerId}`,
              name: u.providerId || "No provider ID",
              detail: `${u.providerName || ""} · ${r.stationCode}`,
            }));
      for (const e of entries) {
        const g: { name: string; detail: string; rows: any[] } = groups.get(
          e.key,
        ) || { name: e.name, detail: e.detail, rows: [] };
        if (!g.rows.some((x) => x.key === r.key)) g.rows.push(r);
        groups.set(e.key, g);
      }
    }
    return [...groups.entries()].sort((a, b) =>
      a[1].name.localeCompare(b[1].name),
    );
  }, [rows, by]);
  useEffect(() => {
    setPage(0);
    setExpanded(new Set());
    setSelected([]);
  }, [rows, by]);
  const picked = rows.filter((r) => selected.includes(r.key));
  const validSelection =
    picked.length > 0 &&
    picked.length <= 31 &&
    new Set(picked.map((r) => r.workerId)).size === 1;
  const pageEntries = entries.slice(page * 30, (page + 1) * 30);
  const editable = (r: any) =>
    !r.lockReason && r.hasPaySetup && !r.reviewElsewhere;
  const mismatch = (r: any) =>
    !r.lockReason &&
    !["worked", "not_worked"].includes(r.decision) &&
    r.hasStationDeliveryData &&
    ((r.punches > 0 && !r.ownDeliveries) ||
      (!r.punches && r.ownDeliveries > 0));
  const metrics = [
    [new Set(rows.map((r) => r.workerId)).size, "Associates"],
    [rows.filter((r) => r.punches > 0).length, "Days with biometric punch"],
    [rows.filter(mismatch).length, "Attendance / delivery gaps"],
    [rows.filter((r) => r.paymentLocked).length, "Payment-locked days"],
  ];
  return (
    <div className={styles.desk}>
      <div className={styles.overview}>
        {metrics.map(([value, label]) => (
          <div className={styles.metric} key={label}>
            <strong>{Number(value).toLocaleString("en-IN")}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className={styles.toolbar}>
        <div className={styles.segmented} aria-label="Group daily usage">
          <button
            aria-pressed={by === "associate"}
            onClick={() => setBy("associate")}
          >
            By associate
          </button>
          <button
            aria-pressed={by === "provider"}
            onClick={() => setBy("provider")}
          >
            By provider ID
          </button>
        </div>
        <span>
          {entries.length.toLocaleString("en-IN")}{" "}
          {by === "associate" ? "associates" : "IDs"} ·{" "}
          {rows.length.toLocaleString("en-IN")} associate days
        </span>
        <button
          className="button secondary compact"
          onClick={() => setExpanded(new Set(pageEntries.map(([key]) => key)))}
        >
          Expand page
        </button>
        <button
          className="button secondary compact"
          onClick={() => setExpanded(new Set())}
        >
          Collapse all
        </button>
      </div>
      {pageEntries.map(([key, g]) => (
        <details key={key} open={expanded.has(key)} className={styles.group}>
          <summary
            onClick={(e) => {
              e.preventDefault();
              setExpanded((v) => {
                const next = new Set(v);
                next.has(key) ? next.delete(key) : next.add(key);
                return next;
              });
            }}
          >
            <span className={styles.avatar}>
              {by === "provider"
                ? "ID"
                : g.name
                    .split(" ")
                    .slice(0, 2)
                    .map((v: string) => v[0])
                    .join("")}
            </span>
            <span className={styles.identity}>
              <strong>{g.name}</strong>
              <small>{g.detail}</small>
            </span>
            <span className={styles.groupMeta}>
              <span>{new Set(g.rows.map((r) => r.date)).size} days</span>
              <span>
                {new Set(g.rows.map((r) => r.stationCode)).size} stations
              </span>
              {g.rows.some(mismatch) && (
                <span className={styles.status} data-tone="warning">
                  {g.rows.filter(mismatch).length} gaps
                </span>
              )}
              {g.rows.some((r) => r.paymentLocked) && (
                <span className={styles.status} data-tone="locked">
                  {g.rows.filter((r) => r.paymentLocked).length} locked
                </span>
              )}
            </span>
            <ChevronRight
              size={17}
              className={styles.chevron}
              aria-hidden="true"
            />
          </summary>
          {expanded.has(key) && (
            <>
              <div className={styles.groupActions}>
                {by === "associate" && (
                  <button
                    className="button secondary compact"
                    onClick={() =>
                      setSelected(g.rows.filter(editable).map((r) => r.key))
                    }
                  >
                    Select available days
                  </button>
                )}
                <span>
                  Select dates to review together. Locked days stay read-only.
                </span>
              </div>
              <div className={styles.tableWrap}>
                <table>
                  <thead>
                    <tr>
                      <th aria-label="Select day"></th>
                      <th>Date / station</th>
                      <th>
                        {by === "associate"
                          ? "Provider ID / owner"
                          : "Actual associate"}
                      </th>
                      <th>Attendance</th>
                      <th>Deliveries</th>
                      <th>Payment structure / status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((r) => (
                      <tr key={r.key} data-selected={selected.includes(r.key)}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${r.name} ${r.date} ${r.stationCode}`}
                            checked={selected.includes(r.key)}
                            disabled={!editable(r)}
                            onChange={(e) =>
                              setSelected((v) =>
                                e.target.checked
                                  ? [...v, r.key]
                                  : v.filter((k) => k !== r.key),
                              )
                            }
                          />
                        </td>
                        <td>
                          {new Date(`${r.date}T12:00:00Z`).toLocaleDateString(
                            "en-GB",
                            { day: "2-digit", month: "short" },
                          )}
                          <small>{r.stationCode}</small>
                        </td>
                        <td>
                          {by === "provider" ? (
                            <>
                              <strong>{r.name}</strong>

                              <small>{r.dropxId}</small>
                            </>
                          ) : (
                            (r.usages || []).map((u: any, i: number) => (
                              <div key={i}>
                                <strong>{u.providerId}</strong> {u.providerName}
                                <small>
                                  {u.borrowed ? "Used from" : "Owner"}:{" "}
                                  {u.ownerName} · {u.ownerDropxId}
                                </small>
                              </div>
                            ))
                          )}
                        </td>
                        <td>
                          {r.punches
                            ? `${r.punches} biometric punches`
                            : r.bulkPeriods?.length
                              ? "Bulk · period total"
                              : "No biometric punch"}
                        </td>
                        <td>
                          <strong>
                            {by === "provider"
                              ? (r.usages || [])
                                  .filter(
                                    (u: any) =>
                                      `${r.stationId}|${u.client}|${u.providerId}` ===
                                      key,
                                  )
                                  .reduce(
                                    (sum: number, u: any) =>
                                      sum + Number(u.deliveries || 0),
                                    0,
                                  )
                              : (r.adjustedDeliveries ?? r.ownDeliveries)}
                          </strong>

                          <small>
                            {by === "provider"
                              ? "On this ID"
                              : `${r.ownDeliveries} on own IDs + ${r.receivedDeliveries || 0} allocated − ${r.givenDeliveries || 0} reassigned`}
                          </small>
                        </td>
                        <td>
                          {r.payMethod || "Not configured"}

                          <div>
                            <span
                              className={styles.status}
                              data-tone={
                                r.lockReason
                                  ? "locked"
                                  : mismatch(r)
                                    ? "warning"
                                    : ["worked", "not_worked"].includes(
                                          r.decision,
                                        )
                                      ? "success"
                                      : ""
                              }
                            >
                              {dailyUsageStatus(r)}
                            </span>
                          </div>
                          {r.lockReason && (
                            <details>
                              <summary>Why read-only?</summary>
                              <small>{r.lockReason}</small>
                            </details>
                          )}
                        </td>
                        <td>
                          <button
                            className="button secondary compact"
                            onClick={() => onReview([r])}
                          >
                            {r.lockReason ? "View details" : "Review"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </details>
      ))}
      {!entries.length && (
        <div className={styles.empty}>
          <strong>No matching days</strong>
          <p>Change or clear the filters to see more records.</p>
        </div>
      )}
      {entries.length > 30 && (
        <div className={styles.pagination}>
          <button
            className="button secondary compact"
            disabled={!page}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </button>
          <span>
            Page {page + 1} of {Math.ceil(entries.length / 30)}
          </span>
          <button
            className="button secondary compact"
            disabled={(page + 1) * 30 >= entries.length}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
      {picked.length > 0 && (
        <div className={styles.selection}>
          <span>
            {picked.length} days selected
            {validSelection ? ` · ${picked[0].name}` : ""}
          </span>
          {!validSelection && (
            <span role="alert">Choose up to 31 days for one associate.</span>
          )}
          <button
            className="button secondary compact"
            onClick={() => setSelected([])}
          >
            Clear
          </button>
          <button
            className="button primary compact"
            disabled={!validSelection}
            onClick={() => onReview(picked)}
          >
            Review selected days
          </button>
        </div>
      )}
    </div>
  );
}
