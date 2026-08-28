"use client";

import { useMemo, useState } from "react";

export type WorkforcePayoutRow = {
  id: string; dropxId: string; name: string; providerMemberId: string; locationId: string | null;
  location: string; provider: string; model: string; paymentMethod: string; production: number;
  baseAmount: number; additions: number; deductions: number; netAmount: number; status: string;
};

function money(value: number) { return `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }

export function WorkforcePayoutTable({ rows }: { rows: WorkforcePayoutRow[] }) {
  const [search, setSearch] = useState("");
  const [location, setLocation] = useState("all");
  const [provider, setProvider] = useState("all");
  const [method, setMethod] = useState("all");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [size, setSize] = useState("20");
  const options = (key: keyof WorkforcePayoutRow) => Array.from(new Set(rows.map((row) => String(row[key] || "-")).filter(Boolean))).sort();
  const filtered = useMemo(() => rows.filter((row) => {
    const term = search.trim().toLowerCase();
    return (!term || `${row.dropxId} ${row.name} ${row.providerMemberId}`.toLowerCase().includes(term))
      && (location === "all" || row.location === location)
      && (provider === "all" || row.provider === provider)
      && (method === "all" || row.paymentMethod === method)
      && (status === "all" || row.status === status);
  }), [rows, search, location, provider, method, status]);
  const pageSize = size === "all" ? Math.max(filtered.length, 1) : Number(size);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function exportRows() {
    const columns = ["DropX ID","Worker","Provider Member ID","Location","Provider","Model","Payment Method","Production","Base Amount","Additional Payments","Deductions","Net Pay","Status"];
    const csv = [columns, ...filtered.map((r) => [r.dropxId,r.name,r.providerMemberId,r.location,r.provider,r.model,r.paymentMethod,r.production,r.baseAmount,r.additions,r.deductions,r.netAmount,r.status])]
      .map((line) => line.map((value) => `"${String(value).replaceAll('"','""')}"`).join(",")).join("\r\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = "workforce-payouts.csv"; link.click(); URL.revokeObjectURL(link.href);
  }

  return <>
    <div className="payout-filters">
      <label>Search<input className="field" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="DropX ID, worker or holder ID" /></label>
      <label>Location<select className="field" value={location} onChange={(e) => { setLocation(e.target.value); setPage(1); }}><option value="all">All allocated locations</option>{options("location").map((v) => <option key={v}>{v}</option>)}</select></label>
      <label>Provider<select className="field" value={provider} onChange={(e) => { setProvider(e.target.value); setPage(1); }}><option value="all">All providers</option>{options("provider").map((v) => <option key={v}>{v}</option>)}</select></label>
      <label>Payment method<select className="field" value={method} onChange={(e) => { setMethod(e.target.value); setPage(1); }}><option value="all">All methods</option>{options("paymentMethod").map((v) => <option key={v}>{v}</option>)}</select></label>
      <label>Status<select className="field" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="all">All statuses</option>{options("status").map((v) => <option key={v}>{v}</option>)}</select></label>
      <label>Rows<select className="field" value={size} onChange={(e) => { setSize(e.target.value); setPage(1); }}>{["20","50","100","500","1000","all"].map((v) => <option value={v} key={v}>{v === "all" ? "All" : v}</option>)}</select></label>
      <button className="button secondary" type="button" onClick={exportRows}>Export</button>
    </div>
    <div className="table-wrap"><table className="workforce-payout-table"><thead><tr><th>DropX ID</th><th>Worker / Holder ID</th><th>Location</th><th>Provider / Model</th><th>Payment Method</th><th>Production</th><th>Base Amount</th><th>Additional Payments</th><th>Deductions</th><th>Net Pay</th><th>Status</th><th>Action</th></tr></thead>
      <tbody>{visible.length ? visible.map((row) => <tr key={row.id}><td><strong>{row.dropxId}</strong></td><td><strong>{row.name}</strong><small>{row.providerMemberId}</small></td><td>{row.location}</td><td>{row.provider}<small>{row.model}</small></td><td>{row.paymentMethod}</td><td>{row.production.toLocaleString("en-IN")}</td><td>{money(row.baseAmount)}</td><td className="positive">+ {money(row.additions)}</td><td className="negative">- {money(row.deductions)}</td><td><strong>{money(row.netAmount)}</strong></td><td><span className="status-pill warn">{row.status}</span></td><td><button className="button secondary compact" type="button">Review</button></td></tr>) : <tr><td className="empty-cell" colSpan={12}>No mapped workforce payouts match the selected period and filters.</td></tr>}</tbody>
    </table></div>
    <div className="pagination"><span>Showing {filtered.length ? (safePage - 1) * pageSize + 1 : 0}–{Math.min(safePage * pageSize, filtered.length)} of {filtered.length}</span><div><button className="button secondary compact" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>Previous</button><span>Page {safePage} of {pages}</span><button className="button secondary compact" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)}>Next</button></div></div>
  </>;
}
