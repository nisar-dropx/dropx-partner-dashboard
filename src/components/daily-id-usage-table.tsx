"use client";
import { useEffect, useState } from "react";
import { dailyUsageStatus } from "@/lib/daily-id-usage";

export function DailyIdUsageTable({
  rows,
  onReview,
}: {
  rows: any[];
  onReview: (rows: any[]) => void;
}) {
  const [by, setBy] = useState("associate"),
    [expanded, setExpanded] = useState(""),
    [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
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
  const entries = [...groups.entries()].sort((a, b) =>
    a[1].name.localeCompare(b[1].name),
  );
  useEffect(() => {
    setPage(0);
    setExpanded("");
    setSelected([]);
  }, [rows.length, by]);
  const picked = rows.filter((r) => selected.includes(r.key));
  const validSelection =
    picked.length > 0 &&
    picked.length <= 31 &&
    new Set(picked.map((r) => r.workerId)).size === 1;
  return (
    <div className="panel-body">
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <button
          className="button secondary compact"
          aria-pressed={by === "associate"}
          onClick={() => setBy("associate")}
        >
          By associate
        </button>
        <button
          className="button secondary compact"
          aria-pressed={by === "provider"}
          onClick={() => setBy("provider")}
        >
          By provider ID
        </button>
        <span>
          {entries.length} {by === "associate" ? "associates" : "IDs"} ·{" "}
          {rows.length} associate days
        </span>
        <button
          className="button primary compact"
          disabled={!validSelection}
          onClick={() => onReview(picked)}
        >
          Review {picked.length || ""} selected days
        </button>
        {picked.length > 0 && (
          <button
            className="button secondary compact"
            onClick={() => setSelected([])}
          >
            Clear selection
          </button>
        )}
        {picked.length > 0 && !validSelection && (
          <span role="alert">Select up to 31 days for one associate.</span>
        )}
      </div>
      {entries.slice(page * 30, (page + 1) * 30).map(([key, g]) => (
        <details
          key={key}
          open={expanded === key}
          onToggle={(e) => {
            if (e.currentTarget.open) setExpanded(key);
          }}
          style={{
            borderBottom: "1px solid var(--border-color, #ddd)",
            padding: "12px 0",
          }}
        >
          <summary
            style={{ cursor: "pointer" }}
            onClick={(e) => {
              e.preventDefault();
              setExpanded(expanded === key ? "" : key);
            }}
          >
            <strong>{g.name}</strong> · {g.detail} ·{" "}
            {new Set(g.rows.map((r) => r.date)).size} days ·{" "}
            {new Set(g.rows.map((r) => r.stationCode)).size} stations
          </summary>
          {expanded === key && (
            <>
              {by === "associate" && (
                <button
                  className="button secondary compact"
                  style={{ margin: "10px 0" }}
                  onClick={() =>
                    setSelected(
                      g.rows
                        .filter((r) => !r.lockReason && r.hasPaySetup)
                        .map((r) => r.key),
                    )
                  }
                >
                  Select available days
                </button>
              )}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Select</th>
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
                      <tr key={r.key}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${r.name} ${r.date} ${r.stationCode}`}
                            checked={selected.includes(r.key)}
                            disabled={!!r.lockReason || !r.hasPaySetup}
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
                          {r.date}
                          <br />
                          <small>{r.stationCode}</small>
                        </td>
                        <td>
                          {by === "provider" ? (
                            <>
                              <strong>{r.name}</strong>
                              <br />
                              <small>{r.dropxId}</small>
                            </>
                          ) : (
                            (r.usages || []).map((u: any, i: number) => (
                              <div key={i}>
                                <strong>{u.providerId}</strong> {u.providerName}
                                <br />
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
                          <br />
                          <small>
                            {by === "provider"
                              ? "On this ID"
                              : `${r.ownDeliveries} on own IDs + ${r.receivedDeliveries || 0} allocated − ${r.givenDeliveries || 0} reassigned`}
                          </small>
                        </td>
                        <td>
                          {r.payMethod || "Not configured"}
                          <br />
                          <strong>{dailyUsageStatus(r)}</strong>
                          {r.lockReason && (
                            <div role="note">{r.lockReason}</div>
                          )}
                        </td>
                        <td>
                          <button
                            className="button secondary compact"
                            onClick={() => onReview([r])}
                          >
                            {r.lockReason ? "View details" : "Review / update"}
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
      {!entries.length && <p>No mapped days match these filters.</p>}
      {entries.length > 30 && (
        <div
          style={{
            display: "flex",
            gap: 12,
            alignItems: "center",
            marginTop: 12,
          }}
        >
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
    </div>
  );
}
