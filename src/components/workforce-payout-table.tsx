"use client";

import { useMemo, useState } from "react";

export type WorkforcePayoutRow = {
  id: string; dropxId: string; name: string; providerMemberId: string; providerMemberName: string; locationId: string | null;
  location: string; provider: string; model: string; paymentMethod: string; production: number;
  productionBreakdown: Array<{ code: string; label: string; count: number; rate: number; amount: number }>;
  baseAmount: number; additions: number; deductions: number; deductionBreakdown: Array<{ code: string; label: string; amount: number }>; panAadhaarStatus: "LINKED" | "NOT LINKED"; netAmount: number; status: string;
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
    return (!term || `${row.dropxId} ${row.name} ${row.providerMemberId} ${row.providerMemberName}`.toLowerCase().includes(term))
      && (location === "all" || row.location === location)
      && (provider === "all" || row.provider === provider)
      && (method === "all" || row.paymentMethod === method)
      && (status === "all" || row.status === status);
  }), [rows, search, location, provider, method, status]);
  const pageSize = size === "all" ? Math.max(filtered.length, 1) : Number(size);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const productionColumns = useMemo(() => {
    const values = new Map<string, string>();
    rows.forEach((row) => row.productionBreakdown.forEach((item) => values.set(item.code, item.label)));
    const preferred = ["DELIVERY", "CRETURN", "SELLER_PICKUP", "SLLLER_RETURN"];
    return Array.from(values, ([code, label]) => ({ code, label })).sort((left, right) => {
      const leftIndex = preferred.indexOf(left.code); const rightIndex = preferred.indexOf(right.code);
      if (leftIndex === -1 && rightIndex === -1) return left.label.localeCompare(right.label);
      if (leftIndex === -1) return 1; if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });
  }, [rows]);
  const deductionColumns = useMemo(() => {
    const values = new Map<string, string>();
    rows.forEach((row) => row.deductionBreakdown.forEach((item) => values.set(item.code, item.label)));
    return Array.from(values, ([code, label]) => ({ code, label })).sort((left, right) => left.label.localeCompare(right.label));
  }, [rows]);

  function exportRows() {
    const productionHeaders = productionColumns.flatMap((item) => [`${item.label} Count`, `${item.label} Rate`, `${item.label} Amount`]);
    const deductionHeaders = deductionColumns.map((item) => `${item.label} Deduction`);
    const columns = ["DropX ID","Registered Worker","Provider Member","Provider Member ID","Location Code","Provider","Model","Payment Method",...productionHeaders,"Base Amount","Additional Payments",...deductionHeaders,"Gross Deductions","Net Pay","PAN-Aadhaar Status","Status"];
    const csv = [columns, ...filtered.map((r) => [r.dropxId,r.name,r.providerMemberName,r.providerMemberId,r.location,r.provider,r.model,r.paymentMethod,...productionColumns.flatMap((column) => { const item = r.productionBreakdown.find((value) => value.code === column.code); return [item?.count ?? 0,item?.rate ?? 0,item?.amount ?? 0]; }),r.baseAmount,r.additions,...deductionColumns.map((column) => r.deductionBreakdown.find((item) => item.code === column.code)?.amount ?? 0),r.deductions,r.netAmount,r.panAadhaarStatus,r.status])]
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
    <div className="table-wrap"><table className="workforce-payout-table workforce-payout-detail-table"><thead><tr><th rowSpan={2}>DropX ID</th><th rowSpan={2}>Registered Worker</th><th rowSpan={2}>Provider Member</th><th rowSpan={2}>Location Code</th><th rowSpan={2}>Provider / Model</th><th rowSpan={2}>Payment Method</th>{productionColumns.map((column) => <th className="production-group" colSpan={3} key={column.code}>{column.label}</th>)}<th rowSpan={2}>Base Amount</th><th rowSpan={2}>Additional Payments</th>{deductionColumns.map((column) => <th rowSpan={2} className="deduction-group" key={column.code}>{column.label}</th>)}<th rowSpan={2}>Gross Deductions</th><th rowSpan={2}>Net Pay</th><th rowSpan={2}>PAN–Aadhaar</th><th rowSpan={2}>Status</th><th rowSpan={2}>Action</th></tr><tr>{productionColumns.flatMap((column) => [<th key={`${column.code}-count`}>Count</th>,<th key={`${column.code}-rate`}>Rate</th>,<th key={`${column.code}-amount`}>Amount</th>])}</tr></thead>
      <tbody>{visible.length ? visible.map((row) => <tr key={row.id} className={row.panAadhaarStatus === "NOT LINKED" ? "payout-pan-aadhaar-unlinked" : undefined}><td><strong>{row.dropxId}</strong></td><td><strong>{row.name}</strong></td><td><strong>{row.providerMemberName}</strong><small>{row.providerMemberId}</small></td><td><strong>{row.location}</strong></td><td>{row.provider}<small>{row.model}</small></td><td>{row.paymentMethod}</td>{productionColumns.flatMap((column) => { const item = row.productionBreakdown.find((value) => value.code === column.code); return [<td key={`${column.code}-count`}>{(item?.count ?? 0).toLocaleString("en-IN")}</td>,<td key={`${column.code}-rate`}>{money(item?.rate ?? 0)}</td>,<td key={`${column.code}-amount`}><strong>{money(item?.amount ?? 0)}</strong></td>]; })}<td>{money(row.baseAmount)}</td><td className="positive">+ {money(row.additions)}</td>{deductionColumns.map((column) => <td className="negative" key={column.code}>- {money(row.deductionBreakdown.find((item) => item.code === column.code)?.amount ?? 0)}</td>)}<td className="negative">- {money(row.deductions)}</td><td><strong>{money(row.netAmount)}</strong></td><td><span className={`status-pill ${row.panAadhaarStatus === "LINKED" ? "good" : "warn"}`}>{row.panAadhaarStatus}</span></td><td><span className="status-pill warn">{row.status}</span></td><td><button className="button secondary compact" type="button">Review</button></td></tr>) : <tr><td className="empty-cell" colSpan={14 + deductionColumns.length + productionColumns.length * 3}>No mapped workforce payouts match the selected period and filters.</td></tr>}</tbody>
    </table></div>
    <div className="pagination"><span>Showing {filtered.length ? (safePage - 1) * pageSize + 1 : 0}–{Math.min(safePage * pageSize, filtered.length)} of {filtered.length}</span><div><button className="button secondary compact" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>Previous</button><span>Page {safePage} of {pages}</span><button className="button secondary compact" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)}>Next</button></div></div>
  </>;
}
