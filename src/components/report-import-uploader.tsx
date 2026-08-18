"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ReportImportMaster, reportSchedule } from "@/lib/report-import-master";
import { isReportAutoSource, isWorkforceAutoSource } from "@/lib/report-auto-worker";
import { isFuelPortalSource, runFuelPortalInline } from "@/lib/portal-client/fuel-browser";
import { supabase } from "@/lib/supabase";

type ShipmentStation = { code: string; name: string; model: string; provider: string; parentStationId?: string | null; id?: string; childCodes?: string[] };

function indiaDate(days = 0) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
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
  const [sourceType, setSourceType] = useState(sourceOptions.some((report) => report.source_code === requestedSource) ? requestedSource : "");
  const [stationCode, setStationCode] = useState(stations[0]?.code ?? "");
  const [reportDate, setReportDate] = useState(indiaDate());
  const [message, setMessage] = useState<string | null>(null);
  const [autoNotice, setAutoNotice] = useState(false);
  const [hasFile, setHasFile] = useState(false);
  const [summary, setSummary] = useState<{ duplicateRows?: number; imported?: number; refreshedExisting?: number; skipped?: number; totalRows?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isAutoPending, startAuto] = useTransition();
  const busy = isPending || isAutoPending;

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
    startAuto(async () => {
      const response = await fetch("/api/report-imports/auto-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_type: sourceType,
          report_date: isWorkforceAutoSource(sourceType)
            ? undefined
            : (reportDate || undefined),
          station_code: requiresStation ? effectiveStationCode : undefined
        })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && result.clientPortal && isFuelPortalSource(sourceType)) {
          try {
            const effectiveDate = String(result.reportDate || reportDate || indiaDate(-1));
            const browser = await runFuelPortalInline({
              sourceType,
              reportDate: effectiveDate
            });
            const form = new FormData();
            form.set("source_type", sourceType);
            form.set("report_date", effectiveDate);
            form.set("file", browser.file);
            const importResponse = await fetch("/api/report-imports", { method: "POST", body: form });
            const imported = await importResponse.json().catch(() => ({}));
            if (!importResponse.ok) {
              setError(imported.error ?? `Import failed after browser download (${importResponse.status}).`);
              return;
            }
            setMessage(imported.message ?? `${sourceType} auto upload completed via your browser network.`);
            setSummary({
              duplicateRows: Number(imported.duplicateRows ?? 0),
              imported: Number(imported.imported ?? 0),
              refreshedExisting: Number(imported.refreshedExisting ?? 0),
              skipped: Number(imported.skipped ?? 0),
              totalRows: Number(imported.totalRows ?? 0)
            });
            setAutoNotice(true);
            router.refresh();
            return;
          } catch (browserErr) {
            setError(browserErr instanceof Error ? browserErr.message : String(browserErr));
            return;
          }
        }
        setError(result.error ?? `Auto upload failed (${response.status}).`);
        return;
      }
      setMessage(result.message ?? "Auto upload started.");
      setAutoNotice(true);
      router.refresh();
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
        : "Fetch this report from the portal and import it (no file needed)";

  const autoButton = (
    <button
      className={`button secondary ${isAutoPending ? "loading" : ""}`}
      disabled={busy || !canAuto || (requiresStation && !effectiveStationCode) || (requiresReportDate && !reportDate)}
      onClick={autoUpload}
      title={autoTitle}
      type="button"
    >
      {isAutoPending ? "Auto uploading..." : "Auto upload"}
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
            const nextReportDate = indiaDate(next?.date_default_offset ?? 0);
            setReportDate(nextReportDate);
            const nextUrl = new URL(window.location.href);
            if (nextType) nextUrl.searchParams.set("report", nextType);
            else nextUrl.searchParams.delete("report");
            if (next && ["delivered_shipment_detail", "inbound_shipment_detail"].includes(next.parser_type)) {
              nextUrl.searchParams.set("shipment", "1");
              nextUrl.searchParams.set("date", indiaDate());
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
      {compact && isShipmentImport ? <p className="shipment-upload-note">Station is detected from the file or filename; the selected checklist date is used when the file has no date. Existing IDs are refreshed without double-counting.</p> : null}
      {compact && canAuto ? <p className="shipment-upload-note">Auto upload pulls the file from the portal — no file picker needed. Use Upload file when Amazon has not published yet or Auto fails.</p> : null}
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
