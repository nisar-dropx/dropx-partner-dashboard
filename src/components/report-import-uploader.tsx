"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ReportImportMaster, reportSchedule } from "@/lib/report-import-master";
import { isReportAutoSource, isWorkforceAutoSource } from "@/lib/report-auto-worker";
import { supabase } from "@/lib/supabase";

type ShipmentStation = { code: string; name: string; model: string; provider: string; parentStationId?: string | null; id?: string; childCodes?: string[] };

type AutoStep = {
  label: string;
  detail?: string;
  status: "done" | "active" | "pending" | "error";
};

type AutoProgress = {
  title: string;
  current: number;
  total: number;
  station?: string | null;
  steps: AutoStep[];
};

function indiaDate(days = 0) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

/** Local calendar YYYY-MM-DD — never use toISOString() (UTC shift breaks IST). */
function localYmd(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function applyDateOffset(ymd: string, offsetDays: number) {
  const date = new Date(`${ymd}T12:00:00`);
  date.setDate(date.getDate() + offsetDays);
  return localYmd(date);
}

export function ReportImportUploader({
  reports,
  stations = [],
  compact = false,
  autoEnabled = false
}: {
  reports: ReportImportMaster[];
  stations?: ShipmentStation[];
  compact?: boolean;
  autoEnabled?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fileRef = useRef<HTMLInputElement>(null);
  const sourceOptions = reports.filter((report) => report.is_active);
  const requestedSource = searchParams.get("report") ?? "";
  const urlDate = searchParams.get("date") ?? "";
  const initialSource = sourceOptions.some((report) => report.source_code === requestedSource) ? requestedSource : "";
  const [sourceType, setSourceType] = useState(initialSource);
  const [stationCode, setStationCode] = useState(stations[0]?.code ?? "");
  const initialReport = sourceOptions.find((r) => r.source_code === initialSource);
  const initialOffset = initialReport?.date_default_offset ?? 0;
  const initialBaseDate = /^\d{4}-\d{2}-\d{2}$/.test(urlDate) ? urlDate : indiaDate();
  const [reportDate, setReportDate] = useState(applyDateOffset(initialBaseDate, initialOffset));
  const [message, setMessage] = useState<string | null>(null);
  const [autoNotice, setAutoNotice] = useState(false);
  const [hasFile, setHasFile] = useState(false);
  const [summary, setSummary] = useState<{ duplicateRows?: number; imported?: number; refreshedExisting?: number; skipped?: number; totalRows?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isAutoPending, startAuto] = useTransition();
  const [autoProgress, setAutoProgress] = useState<AutoProgress | null>(null);
  const busy = isPending || isAutoPending;
  const networkStationCount = stations.filter((station) => !station.parentStationId && station.code.toUpperCase() !== "TEST").length;

  async function upload() {
    setMessage(null);
    setSummary(null);
    setError(null);
    setAutoNotice(false);
    if (!sourceType) {
      setError("Select the report you are uploading.");
      return;
    }
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a report file first.");
      return;
    }
    const payload = new FormData();
    payload.append("source_type", sourceType);
    if (requiresStation) payload.append("station_code", effectiveStationCode);
    if (requiresReportDate || isShipmentImport) payload.append("report_date", reportDate);
    startTransition(async () => {
      if (file.size > 3.5 * 1024 * 1024) {
        const signedResponse = await fetch("/api/report-imports/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: file.name, size: file.size })
        });
        const signed = await signedResponse.json().catch(() => ({}));
        if (!signedResponse.ok || !signed.path || !signed.token || !supabase) {
          setError(signed.error ?? "Unable to prepare this large-file upload.");
          return;
        }
        const staged = await supabase.storage.from(signed.bucket).uploadToSignedUrl(signed.path, signed.token, file, {
          contentType: file.type || "application/octet-stream"
        });
        if (staged.error) {
          setError(`Unable to stage this file: ${staged.error.message}`);
          return;
        }
        payload.append("storage_bucket", signed.bucket);
        payload.append("storage_path", signed.path);
        payload.append("original_file_name", file.name);
        payload.append("original_file_size", String(file.size));
      } else {
        payload.append("file", file);
      }
      const response = await fetch("/api/report-imports", {
        method: "POST",
        body: payload
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(result.error ?? `Unable to import this file (${response.status}).`);
        return;
      }
      setMessage(result.message ?? "Import completed.");
      setSummary({
        duplicateRows: Number(result.duplicateRows ?? 0),
        imported: Number(result.imported ?? 0),
        refreshedExisting: Number(result.refreshedExisting ?? 0),
        skipped: Number(result.skipped ?? 0),
        totalRows: Number(result.totalRows ?? 0)
      });
      if (fileRef.current) fileRef.current.value = "";
      setHasFile(false);
      router.refresh();
    });
  }

  async function autoUpload() {
    setMessage(null);
    setSummary(null);
    setError(null);
    setAutoNotice(false);
    if (!sourceType) {
      setError("Select the report you want to auto-upload.");
      return;
    }
    if (!isReportAutoSource(sourceType)) {
      setError("Auto upload is not available for this report. Choose a file and use Upload file.");
      return;
    }
    if (requiresStation && !effectiveStationCode) {
      setError("Select a station first.");
      return;
    }
    if (requiresReportDate && !reportDate) {
      setError("Select a data date first.");
      return;
    }
    const isDelivered = sourceType === "delivered_shipment_detail";

    // IOCL/BPCL/Cashbook/etc. all run directly on the report-auto-worker now —
    // no browser extension, no office-gateway agent. Same call path for all.
    startAuto(async () => {
      try {
      setAutoProgress({
        title: isDelivered ? "Fetching delivered data for every station" : "Auto upload",
        current: 0,
        total: isDelivered ? Math.max(networkStationCount, 1) : 3,
        station: null,
        steps: isDelivered
          ? [
              { label: "Start network run", status: "active" },
              { label: "Fetch stations one by one", status: "pending" },
              { label: "Refresh checklist", status: "pending" }
            ]
          : [
              { label: "Ask the report worker", status: "active" },
              { label: "Download from the portal", status: "pending" },
              { label: "Import into Master", status: "pending" }
            ]
      });
      const response = await fetch("/api/report-imports/auto-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_type: sourceType,
          report_date: reportDate || undefined,
          station_code: requiresStation ? effectiveStationCode : undefined
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(result.error ?? `Auto upload failed (${response.status}).`);
        return;
      }

      if (isDelivered && result.runId && !result.done) {
        let done = false;
        let runId = String(result.runId);
        let lastStation = String(result.lastStationCode || "");
        let stationsOk = Number(result.stationsOk || 1);
        let stationsTotal = Number(result.stationsTotal || networkStationCount || 27);
        const seen = lastStation ? [lastStation] : [];
        let ticks = 0;
        while (!done && ticks < 80) {
          ticks += 1;
          setAutoProgress({
            title: "Fetching delivered data for every station",
            current: stationsOk,
            total: stationsTotal,
            station: lastStation,
            steps: [
              { label: "Start network run", status: "done" },
              {
                label: "Fetch stations one by one",
                status: "active",
                detail: lastStation
                  ? `${stationsOk}/${stationsTotal} · now ${lastStation}`
                  : `${stationsOk}/${stationsTotal}`
              },
              { label: "Refresh checklist", status: "pending" }
            ]
          });
          const tickResponse = await fetch("/api/report-imports/auto-tick", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              source_type: sourceType,
              report_date: result.reportDate || reportDate,
              run_id: runId
            })
          });
          const tick = await tickResponse.json().catch(() => ({}));
          if (!tickResponse.ok) {
            setError(tick.error ?? `Station fetch failed (${tickResponse.status}).`);
            return;
          }
          done = Boolean(tick.done);
          runId = String(tick.runId || runId);
          lastStation = String(tick.lastStationCode || lastStation);
          stationsOk = Number(tick.stationsOk ?? stationsOk);
          stationsTotal = Number(tick.stationsTotal || stationsTotal);
          if (tick.lastStationCode && !seen.includes(tick.lastStationCode)) {
            seen.push(tick.lastStationCode);
          }
          if (tick.error && done) {
            setError(tick.error);
            router.refresh();
            return;
          }
        }
        setMessage(`Delivered data finished for ${result.reportDate || reportDate}. ${stationsOk} station${stationsOk === 1 ? "" : "s"} fetched — check Import Master for upload status.`);
        setAutoNotice(true);
        router.refresh();
        return;
      }

      setMessage(result.message ?? "Auto upload started.");
      setAutoNotice(true);
      router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setAutoProgress(null);
      }
    });
  }

  const selected = sourceOptions.find((option) => option.source_code === sourceType);
  const requiresStation = Boolean(selected?.requires_station);
  const requiresReportDate = Boolean(selected?.requires_report_date);
  const hasConditionalFields = requiresStation || requiresReportDate;
  const eligibleStations = selected?.station_scope === "amazon_dsp_xpt" || selected?.station_scope === "amazon_dsp_xpd"
    ? stations.filter((station) => station.provider.toUpperCase().includes("AMAZON") && ["DSP", "EDSP"].includes(station.model.toUpperCase()) && !station.parentStationId)
    : stations;
  const effectiveStationCode = eligibleStations.some((station) => station.code === stationCode)
    ? stationCode
    : eligibleStations[0]?.code ?? "";
  const accepted = selected?.file_types.map((type) => `.${type}`).join(",") ?? "";
  const isShipmentImport = selected?.parser_type === "delivered_shipment_detail" || selected?.parser_type === "inbound_shipment_detail";
  const canAuto = autoEnabled && Boolean(sourceType) && isReportAutoSource(sourceType);
  const autoTitle = !sourceType
    ? "Select a report first"
    : !autoEnabled
      ? "Auto upload is not configured"
      : !isReportAutoSource(sourceType)
        ? "Auto upload is not available for this report — use Upload file"
        : isShipmentImport
          ? "Fetches every station one by one — you do not pick a station"
        : "Fetch this report from the portal and import it (no file needed)";

  const autoButton = (
    <button
      className={`button secondary ${isAutoPending ? "loading" : ""}`}
      disabled={busy || !canAuto || (requiresStation && !effectiveStationCode) || (requiresReportDate && !reportDate)}
      onClick={autoUpload}
      title={autoTitle}
      type="button"
    >
      {isAutoPending ? (autoProgress?.station ? `Fetching ${autoProgress.station}…` : "Auto uploading…") : "Auto upload"}
    </button>
  );
  const manualButton = (
    <button
      className={`button ${isPending ? "loading" : ""}`}
      disabled={busy || !sourceType || !hasFile || (requiresStation && !effectiveStationCode) || (requiresReportDate && !reportDate)}
      onClick={upload}
      title="Import a file you already downloaded"
      type="button"
    >
      {isPending ? "Processing..." : compact ? "Upload file" : "Import file"}
    </button>
  );

  return (
    <div className="panel-body stacked">
      {!compact ? <div className="import-source-grid">
        {sourceOptions.map((option) => (
          <button
            className={`import-source-card ${sourceType === option.source_code ? "active" : ""}`}
            key={option.source_code}
            onClick={() => setSourceType(option.source_code)}
            type="button"
          >
            <strong>{option.name}</strong>
            <span>{option.description}</span>
            <small>{reportSchedule(option)}</small>
          </button>
        ))}
      </div> : null}

      <div className={compact ? `compact-upload-row ${hasConditionalFields ? "shipment-upload-row" : ""}` : "form-grid three"}>
        <label>
          <span>Report</span>
          <select className="select" value={sourceType} onChange={(event) => {
            const nextType = event.target.value;
            setSourceType(nextType);
            setMessage(null);
            setSummary(null);
            setError(null);
            const next = sourceOptions.find((option) => option.source_code === nextType);
            const currentUrlDate = new URLSearchParams(window.location.search).get("date") ?? "";
            const baseDate = /^\d{4}-\d{2}-\d{2}$/.test(currentUrlDate) ? currentUrlDate : indiaDate();
            const offset = next?.date_default_offset ?? 0;
            setReportDate(applyDateOffset(baseDate, offset));
            const nextUrl = new URL(window.location.href);
            if (nextType) nextUrl.searchParams.set("report", nextType);
            else nextUrl.searchParams.delete("report");
            if (next && ["delivered_shipment_detail", "inbound_shipment_detail"].includes(next.parser_type)) {
              nextUrl.searchParams.set("shipment", "1");
              if (!nextUrl.searchParams.has("date")) nextUrl.searchParams.set("date", baseDate);
              router.replace(`${nextUrl.pathname}?${nextUrl.searchParams.toString()}`);
            } else {
              nextUrl.searchParams.delete("shipment");
              window.history.replaceState(window.history.state, "", nextUrl);
            }
            window.dispatchEvent(new CustomEvent("report-import-source-change", {
              detail: { parserType: next?.parser_type ?? "" }
            }));
          }}>
            <option value="">Select report</option>
            {sourceOptions.map((option) => <option key={option.source_code} value={option.source_code}>{option.parser_type === "inbound_shipment_detail" ? "Inbound data" : option.parser_type === "delivered_shipment_detail" ? "Delivered data" : option.name}</option>)}
          </select>
        </label>
        {requiresStation ? <label>
          <span>Station</span>
          <select className="select" value={effectiveStationCode} onChange={(event) => setStationCode(event.target.value)} required>
            {eligibleStations.map((station) => <option key={station.code} value={station.code}>{station.code} · {station.name} · {station.model}{station.childCodes?.length ? ` · includes ${station.childCodes.join(", ")} XPT` : ""}</option>)}
          </select>
        </label> : null}
        {requiresReportDate ? <label>
          <span>{selected?.report_date_label || "Data date"}</span>
          <input className="field" type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} required />
        </label> : null}
        <label style={compact ? undefined : { gridColumn: "span 2" }}>
          <span>File</span>
          <input ref={fileRef} className="field" type="file" accept={accepted} onChange={(event) => setHasFile(Boolean(event.target.files?.length))} />
        </label>
        {compact ? <div className="compact-upload-actions">{manualButton}{autoButton}</div> : null}
      </div>
      {compact && isShipmentImport ? <p className="shipment-upload-note">Manual upload: station is read from the file. Auto upload: every Amazon station is fetched one by one for the date above — no station picker.</p> : null}
      {compact && canAuto && !isShipmentImport ? <p className="shipment-upload-note">{sourceType === "amazon_hawkeye_daily" || sourceType === "qc_store_health_daily" ? "Auto upload checks Gmail for new report files (same as the 15-minute worker). Use Upload file for a one-off PDF/xlsx." : "Auto upload pulls the file from the portal — no file picker needed. Use Upload file when the portal is blocked or Auto fails."}</p> : null}
      {autoProgress ? (
        <div className="auto-run-progress" role="status" aria-live="polite">
          <div className="auto-run-progress-head">
            <strong>{autoProgress.title}</strong>
            <span>{autoProgress.current}/{autoProgress.total}</span>
          </div>
          <div className="auto-run-progress-bar">
            <i style={{ width: `${Math.min(100, autoProgress.total ? (autoProgress.current / autoProgress.total) * 100 : 8)}%` }} />
          </div>
          {autoProgress.station ? <p className="auto-run-progress-now">Now fetching <strong>{autoProgress.station}</strong></p> : null}
          <ol className="auto-run-steps">
            {autoProgress.steps.map((step) => (
              <li className={step.status} key={step.label}>
                <span>{step.status === "done" ? "Done" : step.status === "active" ? "Now" : step.status === "error" ? "Failed" : "Next"}</span>
                <div>
                  <strong>{step.label}</strong>
                  {step.detail ? <small>{step.detail}</small> : null}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {!compact ? <div className="dropzone" style={{ minHeight: 120 }}>
        <div>
          <h2>{selected?.name ?? "No active reports"}</h2>
          <p className="subtle" style={{ marginTop: 8 }}>{selected?.description}</p>
          {selected ? <p className="subtle" style={{ marginTop: 6 }}>{reportSchedule(selected)} · accepts {selected.file_types.map((type) => `.${type}`).join(", ")}</p> : null}
          <div className="compact-upload-actions" style={{ marginTop: 16 }}>
            {manualButton}
            {autoButton}
          </div>
        </div>
      </div> : null}
      {message ? <div className="message-panel success"><strong>{autoNotice ? "Auto upload." : "Import completed."}</strong> <span>{message}</span></div> : null}
      {summary ? (
        <div className="report-import-summary">
          <span>Source rows <strong>{summary.totalRows}</strong></span>
          <span>Unique shipments processed <strong>{summary.imported}</strong></span>
          <span>Repeated rows consolidated <strong>{summary.duplicateRows}</strong></span>
          <span>Invalid rows skipped <strong>{summary.skipped}</strong></span>
          {summary.refreshedExisting ? <span>Existing shipments refreshed <strong>{summary.refreshedExisting}</strong></span> : null}
        </div>
      ) : null}
      {error ? <div className="message-panel error"><strong>{error}</strong></div> : null}
    </div>
  );
}
