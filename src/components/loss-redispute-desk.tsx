"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { NlCase } from "@/lib/ops-pulse/nl-loss-policy";
import { ListPager, usePaged } from "./list-pager";
import styles from "./nl-loss.module.css";
export type RedisputeWindow = {
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
  const router = useRouter();
  const [bulk, setBulk] = useState<
      { month: string; case_key: string; version: number; station: string }[]
    >([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(""),
    [status, setStatus] = useState("open");
  const byKey = useMemo(
    () => new Map(rows.map((r) => [`${r.month}|${r.case_key}`, r])),
    [rows],
  );
  const shown = windows.filter(
    (w) =>
      (status === "all" ||
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
  const matches =
    query.trim().length >= 6
      ? rows
          .filter((r) =>
            [r.case_key, r.details.tid].join(" ").includes(query.trim()),
          )
          .slice(0, 20)
      : [];
  const href = (month: string, key: string) =>
    `/team-ops/losses/vendor-response?${new URLSearchParams({ month, case: key })}`;
  async function template() {
    const XLSX = await import("xlsx");
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["Loss month", "Shipment ID", "Station"],
        ["YYYY-MM", "Enter exact shipment ID", "Station code"],
      ]),
      "Activate redisputes",
    );
    XLSX.writeFile(book, "redispute-activation-template.xlsx");
  }
  async function upload(file: File) {
    setMessage("");
    setBulk([]);
    try {
      if (file.size > 2 * 1024 * 1024)
        throw Error("Use a workbook smaller than 2 MB.");
      const XLSX = await import("xlsx");
      const book = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const input = XLSX.utils.sheet_to_json<Record<string, string>>(
        book.Sheets[book.SheetNames[0]],
        { raw: false },
      );
      if (!input.length || input.length > 100)
        throw Error("Provide 1–100 shipments.");
      const parsed = [];
      const seen = new Set<string>();
      for (const [i, item] of input.entries()) {
        const month = String(item["Loss month"] || "").trim(),
          id = String(item["Shipment ID"] || "").trim(),
          station = String(item["Station"] || "")
            .trim()
            .toUpperCase();
        const matches = rows.filter(
          (r) =>
            r.month === month &&
            (r.details.tid === id || r.case_key === id) &&
            r.station_code === station,
        );
        if (matches.length !== 1)
          throw Error(
            `Row ${i + 2}: shipment not found uniquely in your permitted stations.`,
          );
        const r = matches[0],
          key = `${r.month}|${r.case_key}`;
        if (seen.has(key)) throw Error(`Row ${i + 2}: duplicate shipment.`);
        seen.add(key);
        const w = windows.find(
          (w) => w.month === r.month && w.case_key === r.case_key,
        );
        if (w?.enabled)
          throw Error(`Row ${i + 2}: redispute is already active.`);
        parsed.push({
          month: r.month,
          case_key: r.case_key,
          version: w?.version || 0,
          station,
        });
      }
      setBulk(parsed);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Unable to read workbook.");
    }
  }
  async function activate(
    input: { month: string; case_key: string; version: number }[],
  ) {
    if (!canActivate) return;
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/ops-pulse/losses/case-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bulk_activate", rows: input }),
      });
      const body = await res.json();
      if (!res.ok) throw Error(body.error);
      const failed = body.results.filter((r: { ok: boolean }) => !r.ok);
      setMessage(
        `${body.results.length - failed.length} activated.${failed.length ? " " + failed.map((r: { case_key: string; error: string }) => `${r.case_key}: ${r.error}`).join("; ") : ""}`,
      );
      setBulk([]);
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Unable to activate.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={styles.panel}>
      <div className={styles.panelHead}>
        <div>
          <h2>Redispute follow-up</h2>
          <small>Activate → station evidence → review → vendor outcome.</small>
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
              ["awaiting_station", "Station evidence needed"],
              ["awaiting_review", "Awaiting review"],
              ["approved", "Approved for post-dispute"],
              ["preparing", "Preparing"],
              ["filed", "TT filed"],
              ["with_vendor", "With vendor"],
              ["returned", "Needs response"],
              ["won", "Won · recovery stopped"],
              ["lost", "Lost · continue recovery"],
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
      <div className={styles.panelHead}>
        <div className={styles.toolbar}>
          <button className={styles.button} onClick={() => void template()}>
            Download template
          </button>
          <label className={styles.button}>
            Upload shipments
            <input
              type="file"
              accept=".xlsx,.csv"
              disabled={busy || !canActivate}
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
        <small>Up to 100 shipments · activates evidence collection only</small>
      </div>
      {message ? (
        <p role="status" className={styles.notice}>
          {message}
        </p>
      ) : null}
      {bulk.length ? (
        <details open className={styles.compactDetails}>
          <summary>Review {bulk.length} shipments</summary>
          {bulk.map((r) => (
            <p key={`${r.month}|${r.case_key}`}>
              {r.station} · {r.case_key} · {r.month}
            </p>
          ))}
          <button
            className={styles.primary}
            disabled={busy || !canActivate}
            onClick={() => void activate(bulk)}
          >
            Activate {bulk.length} redisputes
          </button>
        </details>
      ) : null}
      {matches.length ? (
        <details open className={styles.compactDetails}>
          <summary>Matching loss cases</summary>
          {matches.map((r) => (
            <p key={`${r.month}|${r.case_key}`}>
              <a href={href(r.month, r.case_key)}>
                {r.station_code} · {r.details.tid || r.case_key} · {r.month} →
                Open case
              </a>{" "}
              {!windows.some(
                (w) =>
                  w.month === r.month && w.case_key === r.case_key && w.enabled,
              ) ? (
                <button
                  className={styles.button}
                  disabled={busy || !canActivate}
                  onClick={() =>
                    void activate([
                      {
                        month: r.month,
                        case_key: r.case_key,
                        version:
                          windows.find(
                            (w) =>
                              w.month === r.month && w.case_key === r.case_key,
                          )?.version || 0,
                      },
                    ])
                  }
                >
                  Activate
                </button>
              ) : null}
            </p>
          ))}
        </details>
      ) : null}
      <div className={styles.tableWrap}>
        <table className={styles.ledgerTable}>
          <thead>
            <tr>
              <th>Case</th>
              <th>LSC TT</th>
              <th>Status</th>
              <th>Follow-up</th>
              <th>Last update</th>
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!shown.length ? (
        <p className={styles.empty}>
          No redisputes match. Search a final Shipment ID to activate its
          response window.
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
