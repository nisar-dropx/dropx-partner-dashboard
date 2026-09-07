"use client";

import { Check, ChevronDown, ClipboardList, FileText, MapPin, Plus, ReceiptText, RotateCcw, Search, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { todayInIndia } from "@/lib/india-date";
import {
  emptyExpectedExpenses,
  EXPECTED_EXPENSE_KEYS,
  EXPENSE_PURPOSE_OPTIONS,
  type ExpectedExpenseKey,
  type ExpectedExpenses,
  purposeLabel,
  sumExpectedExpenses
} from "@/lib/expense-request-form";
import type { AppAccount } from "./connect-profile-app";

type Category = { id: string; code: string; name: string; description?: string | null; receipt_required: boolean; receipt_threshold: number; per_item_limit?: number | null; per_day_limit?: number | null };
type Station = { id: string; code: string; name: string; region?: string | null; cluster?: string | null };
type ExpenseItem = { id: string; categoryId: string; expenseDate: string; merchant: string; description: string; amount: string };
type PreRequest = {
  id: string; request_no: string; purpose: string; purpose_code?: string | null; purpose_label?: string | null;
  estimated_amount?: number | null; trip_from?: string | null; trip_to?: string | null; notes?: string | null;
  visit_station_ids?: string[]; visit_stations?: Station[]; expected_expenses?: ExpectedExpenses;
  status: string; decision_note?: string | null; decided_at?: string | null; consumed_claim_id?: string | null; created_at: string;
  assignees: Array<{ id: string; assignee_role: string; status: string; approver_name?: string | null; decision_note?: string | null; decided_at?: string | null }>;
};
type Claim = {
  id: string; claim_no: string; claim_request_id?: string | null; purpose: string; trip_from?: string | null; trip_to?: string | null; total_claimed: number; total_approved?: number | null; status: string; return_reason?: string | null; rejection_reason?: string | null;
  submitted_at?: string | null; created_at?: string;
  items: Array<{ id: string; expense_date: string; merchant?: string | null; description: string; amount: number; approved_amount?: number | null; hr_expense_categories?: { id: string; name: string; code: string } | Array<{ id: string; name: string; code: string }> | null }>;
  steps: Array<{ id: string; step_order: number; step_name: string; status: string; approver_name?: string | null; decision_note?: string | null; decided_at?: string | null }>;
  events: Array<{ id: string; event_type: string; actor_name?: string | null; actor_role?: string | null; comments?: string | null; created_at: string; metadata?: Record<string, unknown> }>;
  attachments: Array<{ id: string; item_id?: string | null; file_name: string; content_type?: string | null; url?: string | null }>;
  payment?: { request_no: string; status: string; approval_status?: string | null; utr_cin?: string | null; bank_status?: string | null; bank_processing_remarks?: string | null; processed_at?: string | null } | null;
};
type Payload = {
  categories: Category[];
  stations: Station[];
  payout: { ready: boolean; message?: string | null };
  claims: Claim[];
  preRequests: PreRequest[];
};

function uid() { return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; }
function newItem(): ExpenseItem { return { id: uid(), categoryId: "", expenseDate: todayInIndia(), merchant: "", description: "", amount: "" }; }
function money(value: number | string | null | undefined) { return `₹${Number(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function dateTime(value: string) { return new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }); }
function first<T>(value: T | T[] | null | undefined) { return Array.isArray(value) ? value[0] : value; }
function statusLabel(status: string) { return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function amountInput(value: number) { return value > 0 ? String(value) : ""; }

export function ConnectReimbursements({ account }: { account: AppAccount }) {
  const [data, setData] = useState<Payload | null>(null);
  const [tab, setTab] = useState<"requests" | "claims">("requests");
  const [purposeCode, setPurposeCode] = useState("");
  const [notes, setNotes] = useState("");
  const [tripFrom, setTripFrom] = useState("");
  const [tripTo, setTripTo] = useState("");
  const [selectedStationIds, setSelectedStationIds] = useState<string[]>([]);
  const [stationQuery, setStationQuery] = useState("");
  const [stationPickerOpen, setStationPickerOpen] = useState(false);
  const [expectedExpenses, setExpectedExpenses] = useState<ExpectedExpenses>(emptyExpectedExpenses());
  const [purpose, setPurpose] = useState("");
  const [items, setItems] = useState<ExpenseItem[]>([newItem()]);
  const [receipts, setReceipts] = useState<File[]>([]);
  const [selectedRequestId, setSelectedRequestId] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingClaimId, setEditingClaimId] = useState<string | null>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<{ kind: "pre_request" | "claim"; id: string } | null>(null);
  const [withdrawReason, setWithdrawReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ accountId: account.id, profileType: account.profileType });
      const response = await fetch(`/api/connect/reimbursements?${query}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to load expense requests.");
      setData({
        ...payload,
        stations: payload.stations ?? [],
        preRequests: payload.preRequests ?? []
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load expense requests."); }
    finally { setLoading(false); }
  }, [account.id, account.profileType]);

  useEffect(() => { void load(); }, [load]);

  const claimableRequests = useMemo(
    () => (data?.preRequests ?? []).filter((request) => request.status === "approved" && !request.consumed_claim_id),
    [data?.preRequests]
  );
  const total = useMemo(() => items.reduce((sum, item) => sum + (Number(item.amount) || 0), 0), [items]);
  const selectedRequest = useMemo(
    () => claimableRequests.find((request) => request.id === selectedRequestId) ?? null,
    [claimableRequests, selectedRequestId]
  );
  const estimatedTotal = useMemo(() => sumExpectedExpenses(expectedExpenses), [expectedExpenses]);
  const selectedStations = useMemo(
    () => (data?.stations ?? []).filter((station) => selectedStationIds.includes(station.id)),
    [data?.stations, selectedStationIds]
  );
  const filteredStations = useMemo(() => {
    const query = stationQuery.trim().toLowerCase();
    return (data?.stations ?? []).filter((station) => {
      if (selectedStationIds.includes(station.id)) return false;
      if (!query) return true;
      return [station.code, station.name, station.region, station.cluster]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    }).slice(0, 40);
  }, [data?.stations, selectedStationIds, stationQuery]);
  const remarksRequired = purposeCode === "other";
  const canSubmitRequest = Boolean(
    purposeCode
    && selectedStationIds.length
    && estimatedTotal > 0
    && (!remarksRequired || notes.trim().length >= 3)
  );

  function changeItem(id: string, changes: Partial<ExpenseItem>) {
    setItems((current) => current.map((item) => item.id === id ? { ...item, ...changes } : item));
  }

  function setExpectedAmount(key: ExpectedExpenseKey, raw: string) {
    const amount = Number(raw);
    setExpectedExpenses((current) => ({
      ...current,
      [key]: Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0
    }));
  }

  function toggleStation(id: string) {
    setSelectedStationIds((current) => current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id]);
    setStationQuery("");
    setStationPickerOpen(false);
  }

  function resetRequestForm() {
    setPurposeCode("");
    setNotes("");
    setTripFrom("");
    setTripTo("");
    setSelectedStationIds([]);
    setStationQuery("");
    setExpectedExpenses(emptyExpectedExpenses());
  }

  function startClaimFromRequest(request: PreRequest) {
    setSelectedRequestId(request.id);
    setPurpose(request.purpose_label || request.purpose);
    setTripFrom(request.trip_from ?? "");
    setTripTo(request.trip_to ?? "");
    setItems([newItem()]);
    setReceipts([]);
    setEditingClaimId(null);
    setTab("claims");
    setNotice("Complete expense lines and attach receipts for the approved request.");
  }

  function openWithdrawModal(kind: "pre_request" | "claim", id: string) {
    setWithdrawTarget({ kind, id });
    setWithdrawReason("");
    setError("");
  }

  function closeWithdrawModal() {
    if (saving) return;
    setWithdrawTarget(null);
    setWithdrawReason("");
  }

  async function confirmWithdraw(event: FormEvent) {
    event.preventDefault();
    if (!withdrawTarget) return;
    const reason = withdrawReason.trim();
    if (reason.length < 3) {
      setError(`Enter a short reason (at least 3 characters) to withdraw this ${withdrawTarget.kind === "claim" ? "claim" : "request"}.`);
      return;
    }
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/connect/reimbursements", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: account.id,
          profileType: account.profileType,
          kind: withdrawTarget.kind,
          action: "withdrawn",
          ...(withdrawTarget.kind === "claim"
            ? { claimId: withdrawTarget.id }
            : { requestId: withdrawTarget.id }),
          note: reason
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Unable to withdraw ${withdrawTarget.kind === "claim" ? "claim" : "request"}.`);
      setNotice(payload.notice || (withdrawTarget.kind === "claim" ? "Claim withdrawn." : "Request withdrawn."));
      setExpanded(null);
      setWithdrawTarget(null);
      setWithdrawReason("");
      await load();
    } catch (reasonValue) { setError(reasonValue instanceof Error ? reasonValue.message : "Unable to withdraw."); }
    finally { setSaving(false); }
  }

  async function submitRequest(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      if (!canSubmitRequest) throw new Error("Complete the required expense request fields.");
      const form = new FormData();
      form.set("kind", "pre_request");
      form.set("accountId", account.id);
      form.set("profileType", account.profileType);
      form.set("purposeCode", purposeCode);
      form.set("notes", notes);
      form.set("estimatedAmount", String(estimatedTotal));
      form.set("tripFrom", tripFrom);
      form.set("tripTo", tripTo);
      form.set("visitStationIds", JSON.stringify(selectedStationIds));
      form.set("expectedExpenses", JSON.stringify(expectedExpenses));
      const response = await fetch("/api/connect/reimbursements", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to submit request.");
      setNotice(payload.notice);
      resetRequestForm();
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to submit request."); }
    finally { setSaving(false); }
  }

  async function submitClaim(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(""); setNotice("");
    try {
      if (!editingClaimId && !selectedRequestId) throw new Error("Select an approved request before submitting a claim.");
      if (!receipts.length) throw new Error("Attach at least one receipt image or PDF.");
      const form = new FormData();
      form.set("kind", "claim");
      form.set("accountId", account.id);
      form.set("profileType", account.profileType);
      form.set("purpose", purpose);
      form.set("tripFrom", tripFrom);
      form.set("tripTo", tripTo);
      form.set("claimRequestId", selectedRequestId);
      if (editingClaimId) form.set("claimId", editingClaimId);
      form.set("items", JSON.stringify(items.map((item) => ({ ...item, amount: Number(item.amount) }))));
      for (const file of receipts) form.append("receipts", file);
      const response = await fetch("/api/connect/reimbursements", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Unable to submit claim.");
      setNotice(payload.notice);
      setPurpose(""); setTripFrom(""); setTripTo(""); setItems([newItem()]); setReceipts([]); setSelectedRequestId(""); setEditingClaimId(null);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to submit claim."); }
    finally { setSaving(false); }
  }

  function correctReturnedClaim(claim: Claim) {
    setEditingClaimId(claim.id);
    setSelectedRequestId(claim.claim_request_id ?? "");
    setPurpose(claim.purpose);
    setTripFrom(claim.trip_from ?? "");
    setTripTo(claim.trip_to ?? "");
    setItems(claim.items.map((item) => ({
      id: uid(),
      categoryId: first(item.hr_expense_categories)?.id ?? "",
      expenseDate: item.expense_date,
      merchant: item.merchant ?? "",
      description: item.description,
      amount: String(item.amount)
    })));
    setReceipts([]);
    setExpanded(null);
    setTab("claims");
    setNotice("Correct the returned claim, re-attach receipts, and resubmit through the current approval policy.");
  }

  return <section className="dx-expenses">
    <header className="dx-page-intro">
      <small>Payments</small>
      <h1>Expense requests</h1>
      <p>Get prior approval before any business visit or expense. After approval, submit the actual claim with bills.</p>
    </header>
    {error ? <div className="dx-alert error">{error}</div> : null}
    {notice ? <div className="dx-alert success">{notice}</div> : null}
    {data && !data.payout.ready ? <div className="dx-alert warning">{data.payout.message} You can still raise a request; bank details are required before claim submission.</div> : null}

    <nav className="dx-expense-tabs">
      <button className={tab === "requests" ? "active" : ""} onClick={() => setTab("requests")} type="button">
        Requests <b>{data?.preRequests.length ?? 0}</b>
      </button>
      <button className={tab === "claims" ? "active" : ""} onClick={() => setTab("claims")} type="button">
        Claims <b>{data?.claims.length ?? 0}</b>
      </button>
    </nav>

    {loading ? <div className="dx-loader"><span /><small>Loading expense requests…</small></div> : null}

    {!loading && tab === "requests" ? <>
      <form className="dx-expense-form" onSubmit={submitRequest}>
        <section className="dx-expense-card dx-expense-request-card">
          <div className="dx-expense-request-hero">
            <span>
              <small>Prior approval</small>
              <h2>New expense request</h2>
              <p>Tell us the visit purpose, stations, dates, and expected spend before anything is incurred.</p>
            </span>
            <em>{money(estimatedTotal)}</em>
          </div>

          <label className="dx-expense-field">
            Purpose
            <select onChange={(event) => setPurposeCode(event.target.value)} required value={purposeCode}>
              <option value="">Select purpose</option>
              {EXPENSE_PURPOSE_OPTIONS.map((option) => (
                <option key={option.code} value={option.code}>{option.label}</option>
              ))}
            </select>
          </label>

          <div className="dx-expense-field">
            <span className="dx-expense-field-label">Visiting station / location</span>
            {selectedStations.length ? (
              <div className="dx-station-chips">
                {selectedStations.map((station) => (
                  <button className="dx-station-chip" key={station.id} onClick={() => toggleStation(station.id)} type="button">
                    <MapPin />
                    <span>{station.code}</span>
                    <small>{station.name}</small>
                    <X />
                  </button>
                ))}
              </div>
            ) : null}
            <div className={`dx-station-picker${stationPickerOpen ? " open" : ""}`}>
              <label className="dx-station-search">
                <Search />
                <input
                  onBlur={() => window.setTimeout(() => setStationPickerOpen(false), 120)}
                  onChange={(event) => { setStationQuery(event.target.value); setStationPickerOpen(true); }}
                  onFocus={() => setStationPickerOpen(true)}
                  placeholder={selectedStations.length ? "Add another station" : "Search KOZD, KGQA, TLPA…"}
                  value={stationQuery}
                />
              </label>
              {stationPickerOpen ? (
                <div className="dx-station-results">
                  {filteredStations.length ? filteredStations.map((station) => (
                    <button key={station.id} onMouseDown={(event) => event.preventDefault()} onClick={() => toggleStation(station.id)} type="button">
                      <strong>{station.code}</strong>
                      <span>{station.name}</span>
                      <small>{[station.cluster, station.region].filter(Boolean).join(" · ") || "Active station"}</small>
                    </button>
                  )) : <p>No matching active stations.</p>}
                </div>
              ) : null}
            </div>
            <small className="dx-expense-hint">Select one or more active stations for this visit.</small>
          </div>

          <div className="dx-expense-dates">
            <label className="dx-expense-field">Visit from<input onChange={(event) => setTripFrom(event.target.value)} type="date" value={tripFrom} /></label>
            <label className="dx-expense-field">Visit to<input min={tripFrom || undefined} onChange={(event) => setTripTo(event.target.value)} type="date" value={tripTo} /></label>
          </div>

          <label className="dx-expense-field">
            Business justification / remarks
            <small>{remarksRequired ? "Required for Other purpose" : "Optional context for approvers"}</small>
            <textarea
              maxLength={1000}
              minLength={remarksRequired ? 3 : undefined}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={remarksRequired ? "Describe the other purpose clearly" : "Why is this visit needed?"}
              required={remarksRequired}
              rows={3}
              value={notes}
            />
          </label>

          <div className="dx-expense-breakdown">
            <header>
              <div>
                <h3>Expected expense</h3>
                <p>Enter estimates by category. Total updates automatically.</p>
              </div>
              <strong>{money(estimatedTotal)}</strong>
            </header>
            <div className="dx-expense-breakdown-grid">
              {EXPECTED_EXPENSE_KEYS.map((entry) => (
                <label key={entry.key}>
                  {entry.label}
                  <input
                    inputMode="decimal"
                    min="0"
                    onChange={(event) => setExpectedAmount(entry.key, event.target.value)}
                    placeholder="0.00"
                    step="0.01"
                    type="number"
                    value={amountInput(expectedExpenses[entry.key])}
                  />
                </label>
              ))}
            </div>
            <div className="dx-expense-total-row">
              <span>Total estimated amount</span>
              <b>{money(estimatedTotal)}</b>
            </div>
          </div>
        </section>
        <button className="dx-save" disabled={saving || !canSubmitRequest} type="submit">
          {saving ? "Submitting…" : "Submit request"}
        </button>
      </form>

      <div className="dx-expense-list">
        {data?.preRequests.length ? data.preRequests.map((request) => (
          <article className="dx-expense-claim" key={request.id}>
            <button className="dx-expense-claim-head" onClick={() => setExpanded((current) => current === request.id ? null : request.id)} type="button">
              <span>
                <small>{request.request_no}</small>
                <strong>{request.purpose_label || purposeLabel(request.purpose_code, request.purpose)}</strong>
                <em>{statusLabel(request.status)}</em>
              </span>
              <b>{request.estimated_amount != null ? money(request.estimated_amount) : "—"}</b>
              <ChevronDown className={expanded === request.id ? "open" : ""} />
            </button>
            {expanded === request.id ? <div className="dx-expense-claim-body">
              <section>
                <h3>Request</h3>
                <div className="dx-expense-row">
                  <span>
                    <strong>{request.trip_from || request.trip_to ? `${request.trip_from || "—"} → ${request.trip_to || "—"}` : "No visit dates"}</strong>
                    <small>Raised {dateTime(request.created_at)}</small>
                    {request.visit_stations?.length ? (
                      <p className="dx-station-inline">{request.visit_stations.map((station) => station.code).join(" + ")}</p>
                    ) : null}
                    {request.notes ? <p>{request.notes}</p> : null}
                    {request.decision_note ? <p>{request.decision_note}</p> : null}
                  </span>
                </div>
                {request.expected_expenses ? (
                  <div className="dx-expense-mini-breakdown">
                    {EXPECTED_EXPENSE_KEYS.filter((entry) => Number(request.expected_expenses?.[entry.key] ?? 0) > 0).map((entry) => (
                      <span key={entry.key}><small>{entry.label}</small><b>{money(request.expected_expenses?.[entry.key])}</b></span>
                    ))}
                  </div>
                ) : null}
              </section>
              <section>
                <h3>Assignees</h3>
                {request.assignees.length ? request.assignees.map((assignee) => (
                  <div className="dx-expense-row" key={assignee.id}>
                    <span>
                      <strong>{assignee.approver_name || "Approver"}</strong>
                      <small>{statusLabel(assignee.assignee_role)} · {statusLabel(assignee.status)}{assignee.decided_at ? ` · ${dateTime(assignee.decided_at)}` : ""}</small>
                    </span>
                  </div>
                )) : <p className="dx-expense-help">Directly approved.</p>}
              </section>
              {request.status === "approved" && !request.consumed_claim_id ? (
                <button className="dx-save" onClick={() => startClaimFromRequest(request)} type="button"><ReceiptText /> Submit claim</button>
              ) : null}
              {request.status === "pending" ? (
                <button className="dx-small-action danger" disabled={saving} onClick={() => openWithdrawModal("pre_request", request.id)} type="button"><RotateCcw /> Withdraw request</button>
              ) : null}
              {request.consumed_claim_id ? <p className="dx-expense-help">Claim already submitted for this request.</p> : null}
            </div> : null}
          </article>
        )) : <div className="dx-empty"><ReceiptText /><strong>No expense requests yet</strong><small>Raise a request to get prior approval before submitting the claim.</small></div>}
      </div>
    </> : null}

    {!loading && tab === "claims" ? <>
      {(claimableRequests.length || editingClaimId) ? <form className="dx-expense-form" onSubmit={submitClaim}>
        {editingClaimId ? <div className="dx-alert warning">You are correcting a returned claim. Previous decisions remain in the audit timeline.</div> : null}
        <section className="dx-expense-summary">
          <div><ReceiptText /><span><small>Report total</small><strong>{money(total)}</strong></span></div>
          <div><FileText /><span><small>Receipt files</small><strong>{receipts.length}</strong></span></div>
        </section>
        <section className="dx-expense-card">
          <h2>Claim against approved request</h2>
          {!editingClaimId ? (
            <label>Approved request
              <select onChange={(event) => {
                const request = claimableRequests.find((entry) => entry.id === event.target.value);
                setSelectedRequestId(event.target.value);
                if (request) {
                  setPurpose(request.purpose_label || request.purpose);
                  setTripFrom(request.trip_from ?? "");
                  setTripTo(request.trip_to ?? "");
                }
              }} required value={selectedRequestId}>
                <option value="">Select approved request</option>
                {claimableRequests.map((request) => (
                  <option key={request.id} value={request.id}>{request.request_no} · {request.purpose_label || request.purpose}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label>Purpose<textarea maxLength={500} onChange={(event) => setPurpose(event.target.value)} required rows={3} value={purpose} /></label>
          <div className="dx-expense-dates">
            <label>Visit from<input onChange={(event) => setTripFrom(event.target.value)} type="date" value={tripFrom} /></label>
            <label>Visit to<input min={tripFrom || undefined} onChange={(event) => setTripTo(event.target.value)} type="date" value={tripTo} /></label>
          </div>
          {selectedRequest ? <p className="dx-expense-help">Linked request {selectedRequest.request_no}. Receipts are merged into one PDF for approvers.</p> : null}
        </section>
        <section className="dx-expense-card">
          <header>
            <div><h2>Expense lines</h2><p>Add every bill on this claim.</p></div>
            <button className="dx-small-action" onClick={() => setItems((current) => [...current, newItem()])} type="button"><Plus /> Add line</button>
          </header>
          <div className="dx-expense-lines">{items.map((item, index) => {
            const category = data?.categories.find((entry) => entry.id === item.categoryId);
            return <article key={item.id}>
              <header>
                <strong>#{index + 1}</strong>
                <span>{category?.name ?? "Select category"}</span>
                <em>{money(item.amount)}</em>
                {items.length > 1 ? <button aria-label="Remove expense line" onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))} type="button"><Trash2 /></button> : null}
              </header>
              <div className="dx-expense-line-grid">
                <label>Category<select onChange={(event) => changeItem(item.id, { categoryId: event.target.value })} required value={item.categoryId}><option value="">Select</option>{data?.categories.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
                <label>Date<input onChange={(event) => changeItem(item.id, { expenseDate: event.target.value })} required type="date" value={item.expenseDate} /></label>
                <label>Amount<input min="0.01" onChange={(event) => changeItem(item.id, { amount: event.target.value })} required step="0.01" type="number" value={item.amount} /></label>
                <label>Merchant<input maxLength={160} onChange={(event) => changeItem(item.id, { merchant: event.target.value })} placeholder="Vendor / hotel" value={item.merchant} /></label>
                <label className="wide">Description<input maxLength={500} onChange={(event) => changeItem(item.id, { description: event.target.value })} placeholder="What was this expense for?" required value={item.description} /></label>
              </div>
            </article>;
          })}</div>
        </section>
        <section className="dx-expense-card">
          <h2>Receipts</h2>
          <p className="dx-expense-help">Upload multiple images or PDFs. They are merged into a single PDF before storage.</p>
          <label className="dx-expense-upload">
            <Upload />
            <span><strong>Add images or PDFs</strong><small>PDF, JPG, PNG, WebP · max 10 MB each</small></span>
            <input accept="application/pdf,image/jpeg,image/png,image/webp" multiple onChange={(event) => setReceipts(Array.from(event.target.files ?? []))} required={!editingClaimId || receipts.length === 0} type="file" />
          </label>
          {receipts.length ? <ul className="dx-expense-file-list">{receipts.map((file) => <li key={`${file.name}-${file.size}`}><FileText /><span>{file.name}</span><small>{Math.ceil(file.size / 1024)} KB</small></li>)}</ul> : null}
        </section>
        <button className="dx-save" disabled={saving || total <= 0 || !data?.payout.ready || (!editingClaimId && !selectedRequestId)} type="submit">
          {saving ? "Submitting…" : `${editingClaimId ? "Resubmit" : "Submit"} ${money(total)} claim`}
        </button>
      </form> : <div className="dx-alert warning">Approve an expense request first, then return here to submit the claim with receipts.</div>}

      <div className="dx-expense-list">{data?.claims.length ? data.claims.map((claim) => <article className="dx-expense-claim" key={claim.id}>
        <button className="dx-expense-claim-head" onClick={() => setExpanded((current) => current === claim.id ? null : claim.id)} type="button">
          <span><small>{claim.claim_no}</small><strong>{claim.purpose}</strong><em>{statusLabel(claim.status)}</em></span>
          <b>{money(claim.total_approved ?? claim.total_claimed)}</b>
          <ChevronDown className={expanded === claim.id ? "open" : ""} />
        </button>
        {expanded === claim.id ? <div className="dx-expense-claim-body">
          <section>
            <h3>Items</h3>
            {claim.items.map((item) => <div className="dx-expense-row" key={item.id}>
              <span>
                <strong>{first(item.hr_expense_categories)?.name ?? "Expense"}</strong>
                <small>{item.expense_date} · {item.merchant || item.description}</small>
              </span>
              <b>{money(item.approved_amount ?? item.amount)}</b>
            </div>)}
            {claim.attachments.filter((attachment) => attachment.url).map((attachment) => (
              <a href={attachment.url ?? "#"} key={attachment.id} rel="noreferrer" target="_blank"><FileText /> {attachment.file_name}</a>
            ))}
          </section>
          <section>
            <h3>Tracking</h3>
            <div className="dx-expense-timeline">
              <div>
                <i><ReceiptText /></i>
                <span>
                  <strong>Submitted</strong>
                  <small>{dateTime(claim.submitted_at || claim.created_at || "")}</small>
                </span>
              </div>
              {claim.steps.map((step) => (
                <div key={step.id}>
                  <i>{step.status === "rejected" ? <X /> : step.status === "returned" ? <RotateCcw /> : step.status === "pending" || step.status === "waiting" ? <ClipboardList /> : <Check />}</i>
                  <span>
                    <strong>{step.approver_name ? `${step.approver_name} · ${step.step_name}` : step.step_name}</strong>
                    <small>{statusLabel(step.status)}{step.decided_at ? ` · ${dateTime(step.decided_at)}` : ""}{step.decision_note ? ` · ${step.decision_note}` : ""}</small>
                  </span>
                </div>
              ))}
            </div>
          </section>
          {claim.payment ? <section className="dx-payment-track">
            <h3>Payment</h3>
            <div>
              <span><small>Request</small><strong>{claim.payment.request_no}</strong></span>
              <span><small>Status</small><strong>{statusLabel(claim.payment.status)}</strong></span>
              <span><small>UTR / CIN</small><strong>{claim.payment.utr_cin || "Pending"}</strong></span>
              <span><small>Bank status</small><strong>{claim.payment.bank_status || "Pending"}</strong></span>
            </div>
            {claim.payment.bank_processing_remarks ? <p>{claim.payment.bank_processing_remarks}</p> : null}
          </section> : null}
          {claim.status === "returned" ? <button className="dx-save" onClick={() => correctReturnedClaim(claim)} type="button"><RotateCcw /> Correct and resubmit</button> : null}
          {claim.status === "pending_approval" || claim.status === "returned" ? (
            <button className="dx-small-action danger" disabled={saving} onClick={() => openWithdrawModal("claim", claim.id)} type="button"><RotateCcw /> Withdraw claim</button>
          ) : null}
        </div> : null}
      </article>) : <div className="dx-empty"><ReceiptText /><strong>No claims yet</strong><small>Approved requests become claims once receipts are submitted.</small></div>}</div>
    </> : null}

    {withdrawTarget ? (
      <div className="dx-advance-modal" role="presentation">
        <button aria-label="Close" className="backdrop" onClick={closeWithdrawModal} type="button" />
        <form aria-labelledby="dx-reimbursement-withdraw-title" aria-modal="true" onSubmit={confirmWithdraw} role="dialog">
          <header>
            <h2 id="dx-reimbursement-withdraw-title">{withdrawTarget.kind === "claim" ? "Withdraw claim?" : "Withdraw request?"}</h2>
            <button aria-label="Close" disabled={saving} onClick={closeWithdrawModal} type="button"><X /></button>
          </header>
          <p className="dx-expense-help">
            {withdrawTarget.kind === "claim"
              ? "Approvers will no longer see this claim, and uploaded receipt files will be deleted from storage."
              : "Approvers will no longer see this request. You can raise a new one later if needed."}
          </p>
          <label>Reason
            <textarea
              autoFocus
              maxLength={500}
              minLength={3}
              onChange={(event) => setWithdrawReason(event.target.value)}
              placeholder={withdrawTarget.kind === "claim" ? "Why are you withdrawing this claim?" : "Why are you withdrawing this request?"}
              required
              rows={4}
              value={withdrawReason}
            />
          </label>
          <button className="submit" disabled={saving || withdrawReason.trim().length < 3} type="submit">
            {saving ? "Withdrawing…" : "Confirm withdrawal"}
          </button>
        </form>
      </div>
    ) : null}
  </section>;
}
