"use client";
import { ReportTable } from "@/components/report-table";


import { useMemo, useState } from "react";
import { formatDashboardDate } from "@/lib/date-format";
import type { LeadAdRow, LeadRow } from "@/lib/leads-data";

type ReportType = "lead_data" | "ad_spend";

type LeadReportsPanelProps = {
  ads: LeadAdRow[];
  leads: LeadRow[];
};

type AdSpendReportRow = {
  adName: string;
  location: string;
  role: string;
  spend: number;
};

const pageSize = 50;

function normalizeDate(value: string | null | undefined) {
  if (!value) return "";
  return value.slice(0, 10);
}

function isInDateRange(value: string | null | undefined, from: string, to: string) {
  const date = normalizeDate(value);
  if (!date) return !from && !to;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function uniqueValues(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function formatMoney(value: number | null | undefined) {
  return `Rs ${Number(value || 0).toLocaleString("en-IN", {
    maximumFractionDigits: 2
  })}`;
}

function formatDate(value: string | null | undefined) {
  return formatDashboardDate(value);
}

function csvValue(value: string | number | null | undefined) {
  const text = String(value ?? "");
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, headers: string[], rows: Array<Array<string | number | null | undefined>>) {
  const csv = [headers.map(csvValue).join(","), ...rows.map((row) => row.map(csvValue).join(","))].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function LeadReportsPanel({ ads, leads }: LeadReportsPanelProps) {
  const [reportType, setReportType] = useState<ReportType>("lead_data");
  const [addedFrom, setAddedFrom] = useState("");
  const [addedTo, setAddedTo] = useState("");
  const [updatedFrom, setUpdatedFrom] = useState("");
  const [updatedTo, setUpdatedTo] = useState("");
  const [status, setStatus] = useState("");
  const [station, setStation] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [page, setPage] = useState(1);
  const [adSpendRows, setAdSpendRows] = useState<AdSpendReportRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const stationOptions = useMemo(() => uniqueValues(reportType === "ad_spend" ? ads.map((ad) => ad.station_code) : leads.map((lead) => lead.station_code)), [ads, leads, reportType]);
  const statusOptions = useMemo(() => uniqueValues(reportType === "ad_spend" ? ads.map((ad) => ad.status) : leads.map((lead) => lead.status)), [ads, leads, reportType]);

  const leadRows = useMemo(() => {
    return leads
      .filter((lead) => !station || lead.station_code === station)
      .filter((lead) => !status || lead.status === status)
      .filter((lead) => isInDateRange(lead.lead_created_at, addedFrom, addedTo))
      .filter((lead) => isInDateRange(lead.updated_at, updatedFrom, updatedTo))
      .map((lead) => ({
        name: lead.full_name || "-",
        phone: lead.phone || "-",
        location: lead.station_code || "-",
        role: lead.job_code || "-",
        status: lead.status || "-",
        addedOn: lead.lead_created_at,
        updatedOn: lead.updated_at
      }));
  }, [addedFrom, addedTo, leads, station, status, updatedFrom, updatedTo]);

  const currentRows = reportType === "ad_spend" ? adSpendRows : leadRows;
  const totalPages = Math.max(1, Math.ceil(currentRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = currentRows.slice((safePage - 1) * pageSize, safePage * pageSize);

  function clearSubmitted(clearAdSpend = false) {
    setSubmitted(false);
    setError("");
    setPage(1);
    if (clearAdSpend) setAdSpendRows([]);
  }

  async function submitReport() {
    setPage(1);
    setError("");

    if (reportType === "ad_spend") {
      setIsLoading(true);
      try {
        const response = await fetch("/api/leads/ad-spend", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: updatedFrom,
            to: updatedTo,
            station,
            status
          })
        });
        const payload = (await response.json()) as { rows?: AdSpendReportRow[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "Unable to fetch live ad spend.");
        setAdSpendRows(payload.rows ?? []);
        setSubmitted(true);
      } catch (fetchError) {
        setAdSpendRows([]);
        setSubmitted(false);
        setError(fetchError instanceof Error ? fetchError.message : "Unable to fetch live ad spend.");
      } finally {
        setIsLoading(false);
      }
      return;
    }

    setSubmitted(true);
  }

  function downloadReport() {
    if (reportType === "ad_spend") {
      downloadCsv(
        `ad-spend-report-${new Date().toISOString().slice(0, 10)}.csv`,
        ["Ad name", "Location", "Role", "Spend"],
        adSpendRows.map((row) => [row.adName, row.location, row.role, row.spend])
      );
      return;
    }

    downloadCsv(
      `lead-report-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Name", "Phone", "Location", "Role", "Status", "Added On", "Last Updated"],
      leadRows.map((row) => [row.name, row.phone, row.location, row.role, row.status, formatDate(row.addedOn), formatDate(row.updatedOn)])
    );
  }

  return (
    <>
      <div className="lead-report-form">
        <label>
          Report Type
          <select
            className="field"
            value={reportType}
            onChange={(event) => {
              setReportType(event.target.value as ReportType);
              clearSubmitted(true);
              setStatus("");
              setStation("");
            }}
          >
            <option value="lead_data">Lead Data</option>
            <option value="ad_spend">Ad Spend</option>
          </select>
        </label>
        {reportType !== "ad_spend" ? (
          <>
            <label>
              Added From
              <input className="field" type="date" value={addedFrom} onChange={(event) => {
                setAddedFrom(event.target.value);
                clearSubmitted();
              }} />
            </label>
            <label>
              Added To
              <input className="field" type="date" value={addedTo} onChange={(event) => {
                setAddedTo(event.target.value);
                clearSubmitted();
              }} />
            </label>
          </>
        ) : null}
        <label>
          Last Updated From
          <input className="field" type="date" value={updatedFrom} onChange={(event) => {
            setUpdatedFrom(event.target.value);
            clearSubmitted(reportType === "ad_spend");
          }} />
        </label>
        <label>
          Last Updated To
          <input className="field" type="date" value={updatedTo} onChange={(event) => {
            setUpdatedTo(event.target.value);
            clearSubmitted(reportType === "ad_spend");
          }} />
        </label>
        <label>
          Status
          <select className="field" value={status} onChange={(event) => {
            setStatus(event.target.value);
            clearSubmitted(reportType === "ad_spend");
          }}>
            <option value="">All Status</option>
            {statusOptions.map((item) => (
              <option key={item} value={item}>{item.replace(/_/g, " ")}</option>
            ))}
          </select>
        </label>
        <label>
          Station
          <select className="field" value={station} onChange={(event) => {
            setStation(event.target.value);
            clearSubmitted(reportType === "ad_spend");
          }}>
            <option value="">All Stations</option>
            {stationOptions.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>
        <button className="button" type="button" onClick={submitReport} disabled={isLoading}>{isLoading ? "Fetching..." : "Submit"}</button>
      </div>

      {error ? (
        <div className="lead-report-error">
          <strong>Action required</strong>
          <span>{error}</span>
        </div>
      ) : null}

      {submitted ? (
        <div className="lead-report-results">
          <div className="lead-report-results-head">
            <div>
              <strong>{currentRows.length.toLocaleString("en-IN")} rows</strong>
              <span>Showing {pageRows.length.toLocaleString("en-IN")} rows on this page.</span>
            </div>
            <button className="button secondary" type="button" onClick={downloadReport} disabled={!currentRows.length}>Download</button>
          </div>
          <div className="table-wrap">
            <ReportTable className="lead-table">
              <thead>
                {reportType === "ad_spend" ? (
                  <tr>
                    <th>Ad name</th>
                    <th>Location</th>
                    <th>Role</th>
                    <th>Spend</th>
                  </tr>
                ) : (
                  <tr>
                    <th>Name</th>
                    <th>Phone</th>
                    <th>Location</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Added On</th>
                    <th>Last Updated</th>
                  </tr>
                )}
              </thead>
              <tbody>
                {pageRows.length ? pageRows.map((row, index) => (
                  reportType === "ad_spend" ? (
                    <tr key={`${(row as (typeof adSpendRows)[number]).adName}-${index}`}>
                      <td><strong>{(row as (typeof adSpendRows)[number]).adName}</strong></td>
                      <td>{(row as (typeof adSpendRows)[number]).location}</td>
                      <td>{(row as (typeof adSpendRows)[number]).role}</td>
                      <td>{formatMoney((row as (typeof adSpendRows)[number]).spend)}</td>
                    </tr>
                  ) : (
                    <tr key={`${(row as (typeof leadRows)[number]).phone}-${index}`}>
                      <td><strong>{(row as (typeof leadRows)[number]).name}</strong></td>
                      <td>{(row as (typeof leadRows)[number]).phone}</td>
                      <td>{(row as (typeof leadRows)[number]).location}</td>
                      <td>{(row as (typeof leadRows)[number]).role}</td>
                      <td>{(row as (typeof leadRows)[number]).status.replace(/_/g, " ")}</td>
                      <td>{formatDate((row as (typeof leadRows)[number]).addedOn)}</td>
                      <td>{formatDate((row as (typeof leadRows)[number]).updatedOn)}</td>
                    </tr>
                  )
                )) : (
                  <tr>
                    <td colSpan={reportType === "ad_spend" ? 4 : 7}>
                      <div className="empty-state">No data for selected filters.</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </ReportTable>
          </div>
          {totalPages > 1 ? (
            <div className="pagination">
              <button type="button" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button>
              <span>Page {safePage} of {totalPages}</span>
              <button type="button" disabled={safePage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>Next</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
