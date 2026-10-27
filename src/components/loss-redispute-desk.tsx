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
      { month: string; case_key: string; version: number; station: string; action: "activate" | "revoke"; note: string }[]
    >([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const [revoking,setRevoking] = useState<RedisputeWindow|null>(null), [revokeNote,setRevokeNote] = useState("");
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
        ["Loss month", "Shipment ID", "Station", "Action", "Reason"],
      ]),
      "Redisputes",
    );
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ["Field", "Instructions"], ["Loss month", "YYYY-MM"], ["Shipment ID", "Exact Shipment ID; format as text"], ["Station", "Station code"], ["Action", "Enable or Disable"], ["Reason", "Required for Disable: at least 10 characters. History is retained."], ["Limit", "100 shipments. Review the preview before applying."]
    ]), "Instructions");
    XLSX.writeFile(book, "redispute-enable-disable-template.xlsx");
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
        const value = String(item["Action"] || "").trim().toLowerCase();
        if (!["enable","disable"].includes(value)) throw Error(`Row ${i+2}: choose Enable or Disable.`);
        const action = value === "enable" ? "activate" as const : "revoke" as const;
        const note = String(item["Reason"] || "").trim();
        if (action === "revoke" && (note.length < 10 || note.length > 4000)) throw Error(`Row ${i+2}: give a disable reason (10–4000 characters).`);
        if ((action === "activate") === !!w?.enabled) throw Error(`Row ${i+2}: redispute is already ${w?.enabled ? "enabled" : "disabled"}.`);
        parsed.push({
          month: r.month,
          case_key: r.case_key,
          version: w?.version || 0,
          station, action, note,
        });
      }
      setBulk(parsed);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Unable to read workbook.");
    }
  }
  async function activate(
    input: { month: string; case_key: string; version: number; action?: "activate" | "revoke"; note?: string }[],
  ) {
    if (!canActivate) return;
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/ops-pulse/losses/case-response", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bulk_update", rows: input.map(r=>({...r,action:r.action || "activate"})) }),
      });
      const body = await res.json();
      if (!res.ok) throw Error(body.error);
      const failed = body.results.filter((r: { ok: boolean }) => !r.ok);
      setMessage(
        `${body.results.length - failed.length} updated.${failed.length ? " " + failed.map((r: { case_key: string; error: string }) => `${r.case_key}: ${r.error}`).join("; ") : ""}`,
      );
      setBulk([]); setRevoking(null); setRevokeNote("");
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
        <small>Enable or disable · up to 100 shipments</small>
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
              {r.station} · {r.case_key} · {r.month} · {r.action === "revoke" ? "Disable" : "Enable"}
            </p>
          ))}
          <button
            className={styles.primary}
            disabled={busy || !canActivate}
            onClick={() => void activate(bulk)}
          >
            Apply {bulk.length} updates
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
      {revoking ? <section className={styles.allocation} aria-label="Disable redispute"><strong>Disable · {revoking.case_key}</strong><p className={styles.hint}>Closes the response window and resumes eligible recovery. History stays available.</p><div className={styles.toolbar}><input aria-label="Disable reason" value={revokeNote} maxLength={4000} placeholder="Reason for disabling" onChange={e=>setRevokeNote(e.target.value)}/><button className={styles.primary} disabled={busy || revokeNote.trim().length<10} onClick={()=>void activate([{...revoking,action:"revoke",note:revokeNote.trim()}])}>Disable redispute</button><button className={styles.button} disabled={busy} onClick={()=>setRevoking(null)}>Cancel</button></div></section> : null}
      <div className={styles.tableWrap}>
        <table className={styles.ledgerTable}>
          <thead>
            <tr>
              <th>Case</th>
              <th>LSC TT</th>
              <th>Status</th>
              <th>Follow-up</th>
              <th>Last update</th>
              {canActivate ? <th>Action</th> : null}
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
                  {canActivate ? <td>{w.enabled ? <button className={styles.button} disabled={busy} onClick={()=>{setRevoking(w);setRevokeNote("");}}>Disable</button> : <span>Disabled</span>}</td> : null}
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
