"use client";

import { FileSpreadsheet, FileText } from "lucide-react";
import { useState } from "react";
import { downloadFleetExcel, downloadFleetPdf, type FleetReportTable } from "@/lib/fleet/report-export";

export function FleetExportButtons({ report, compact = false }: { report: FleetReportTable; compact?: boolean }) {
  const [busy, setBusy] = useState<"excel" | "pdf" | null>(null);
  async function run(format: "excel" | "pdf") {
    setBusy(format);
    try { await (format === "excel" ? downloadFleetExcel(report) : downloadFleetPdf(report)); }
    finally { setBusy(null); }
  }
  return <div className={`fc-export-buttons ${compact ? "compact" : ""}`}>
    <button disabled={Boolean(busy) || !report.rows.length} onClick={() => run("excel")} type="button"><FileSpreadsheet size={14} /> {busy === "excel" ? "Preparing…" : "Excel"}</button>
    <button disabled={Boolean(busy) || !report.rows.length} onClick={() => run("pdf")} type="button"><FileText size={14} /> {busy === "pdf" ? "Preparing…" : "PDF"}</button>
  </div>;
}
