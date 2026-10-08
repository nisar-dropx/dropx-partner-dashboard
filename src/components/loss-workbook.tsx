"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { recoveryCsv } from "@/lib/ops-pulse/nl-loss-policy";
import styles from "./nl-loss.module.css";

type Result = {
  row: number;
  station: string;
  tid: string;
  status: "saved" | "unchanged" | "error";
  message: string;
};
type Outcome = {
  summary: { saved: number; unchanged: number; failed: number; skipped: number };
  results: Result[];
};

/** Download the scoped recovery worklist, fill it offline, upload it back. */
export function LossWorkbook({
  kind,
  query,
  canUpload,
  scope,
}: {
  kind: string;
  query: string;
  canUpload: boolean;
  scope: string;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"" | "download" | "upload">("");
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function download() {
    setBusy("download");
    setError("");
    try {
      const res = await fetch(`/api/ops-pulse/losses/workbook?${query}`, {
        cache: "no-store",
      });
      if (!res.ok)
        throw Error((await res.json().catch(() => null))?.error || "Download failed.");
      const name =
        /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] ||
        "loss-recovery.xlsx";
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setBusy("");
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy("upload");
    setError("");
    setOutcome(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("kind", kind);
      const res = await fetch("/api/ops-pulse/losses/workbook", {
        method: "POST",
        body: form,
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.summary)
        throw Error(json?.error || "The upload did not complete. Check the list before uploading again.");
      setOutcome(json);
      if (json.summary.saved) router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy("");
    }
  }

  function downloadIssues() {
    if (!outcome) return;
    const rows = [
      ["Excel row", "Station", "TID", "Result", "Details"],
      ...outcome.results.map((r) => [r.row, r.station, r.tid, r.status, r.message]),
    ];
    const url = URL.createObjectURL(
      new Blob(["﻿" + rows.map((r) => r.map(recoveryCsv).join(",")).join("\r\n")], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "loss-recovery-upload-result.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const failed = outcome?.results.filter((r) => r.status === "error") ?? [];
  return (
    <section className={styles.workbook} aria-label="Excel workbook">
      <div>
        <strong>Work in Excel</strong>
        <span>
          Download the cases for {scope} with the allowed recovery actions and
          station employees, fill it in, then upload it here.
        </span>
      </div>
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.button}
          onClick={() => void download()}
          disabled={!!busy}
        >
          {busy === "download" ? "Preparing…" : "Download workbook"}
        </button>
        {canUpload ? (
          <>
            <button
              type="button"
              className={styles.primary}
              onClick={() => input.current?.click()}
              disabled={!!busy}
            >
              {busy === "upload" ? "Checking and saving…" : "Upload filled workbook"}
            </button>
            <input
              ref={input}
              type="file"
              hidden
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </>
        ) : null}
      </div>
      {busy === "upload" ? (
        <p role="status" className={styles.hint}>
          Each row is checked against employee eligibility and salary limits.
          Keep this page open.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {outcome ? (
        <div className={styles.uploadResult} role="status">
          <div className={styles.toolbar}>
            <span className={`${styles.badge} ${styles.good}`}>
              {outcome.summary.saved} saved
            </span>
            <span className={`${styles.badge} ${styles.muted}`}>
              {outcome.summary.unchanged} unchanged
            </span>
            <span className={`${styles.badge} ${outcome.summary.failed ? styles.bad : styles.muted}`}>
              {outcome.summary.failed} need attention
            </span>
            <span className={`${styles.badge} ${styles.muted}`}>
              {outcome.summary.skipped} left blank
            </span>
            <button type="button" className={styles.button} onClick={downloadIssues}>
              Download result
            </button>
            <button type="button" className={styles.button} onClick={() => setOutcome(null)}>
              Dismiss
            </button>
          </div>
          {failed.length ? (
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr>
                    <th>Excel row</th>
                    <th>Station</th>
                    <th>TID</th>
                    <th>What to fix</th>
                  </tr>
                </thead>
                <tbody>
                  {failed.slice(0, 50).map((r) => (
                    <tr key={r.row}>
                      <td>{r.row}</td>
                      <td>{r.station}</td>
                      <td>{r.tid}</td>
                      <td className={styles.wrap}>{r.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {failed.length > 50 ? (
            <p className={styles.hint}>
              Showing the first 50 of {failed.length}. Download the result for the full list.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
