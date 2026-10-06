"use client";

import { FileImage, FileSpreadsheet, FileText } from "lucide-react";
import { useState } from "react";
import { downloadFleetExcel, downloadFleetImage, downloadFleetPdf, type FleetReportTable } from "@/lib/fleet/report-export";

export function FleetExportButtons({ report, compact = false, image = true }: { report: FleetReportTable; compact?: boolean; image?: boolean }) {
  const [busy, setBusy] = useState<"excel" | "image" | "pdf" | null>(null);
  const [error,setError] = useState("");
  async function run(format: "excel" | "image" | "pdf") {
    setBusy(format); setError("");
    try { await (format === "excel" ? downloadFleetExcel(report) : format === "image" ? downloadFleetImage(report) : downloadFleetPdf(report)); }
    catch { setError("Export could not be prepared. Try again or choose Excel."); }
    finally { setBusy(null); }
  }
  return <div className={`fc-export-buttons ${compact ? "compact" : ""}`}>
    <button className="excel" disabled={Boolean(busy) || !report.rows.length} onClick={() => run("excel")} type="button"><FileSpreadsheet size={14} /> {busy === "excel" ? "Preparing…" : "Excel"}</button>
    {image ? <button className="image" disabled={Boolean(busy) || !report.rows.length} onClick={() => run("image")} type="button"><FileImage size={14} /> {busy === "image" ? "Preparing…" : "Image"}</button> : null}
    <button className="pdf" disabled={Boolean(busy) || !report.rows.length} onClick={() => run("pdf")} type="button"><FileText size={14} /> {busy === "pdf" ? "Preparing…" : "PDF"}</button>
    {error ? <span role="alert" style={{fontSize:12,color:"#a32642"}}>{error}</span> : null}
  </div>;
}
