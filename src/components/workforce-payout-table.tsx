"use client";

import { ChevronDown, Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { buildWorkforcePayoutCsv } from "@/lib/workforce-payout-export";
import { matchesWorkforcePayoutFilters, workforcePayoutFacetValues } from "@/lib/workforce-payout-filters";
import { duplicateAdvanceWorkforceIds } from "@/lib/workforce-payout-action-selection";
import { isWorkforcePayoutDisplayPublishable } from "@/lib/workforce-payout-publication-eligibility";
import { MAX_WORKFORCE_PAYOUT_NOTIFICATION_SELECTION } from "@/lib/workforce-payout-publication-limits";
import { PaymentAllocationHistoryButton } from "@/components/payment-allocation-history-button";
import type { PaymentAllocationHistoryEntry } from "@/lib/payment-allocation-history";

export type WorkforcePayoutLine = {
  code: string;
  label: string;
  componentType: "production" | "amount";
  count: number;
  rate: number;
  amount: number;
  schedule?: "per_unit" | "per_day" | "per_hour" | "per_month";
  sortOrder?: number;
  reportedCount?: number;
  thresholdDeducted?: number;
  thresholdPeriod?: "day" | "month" | null;
  thresholdMinimum?: number | null;
  thresholdConfigurationMissing?: boolean;
};

export type WorkforcePayoutAttendanceRange = {
  basis: "hours" | "days";
  quantity: number;
  effectiveFrom: string;
  effectiveTo: string;
};

export type WorkforcePayoutRow = {
  id: string; dropxId: string; dropxStatus: string; name: string; designation: string; providerMemberId: string; providerMemberName: string; locationId: string | null;
  reviewSubjectType?: "workforce" | "helper"; reviewSubjectId?: string | null; reviewToken?: string | null;
  location: string; provider: string; model: string; paymentMethod: string; mappingStatus: string; paymentDetailsAvailable: boolean; workDays: number; workDaysSource: string; production: number;
  paymentMethodBreakdown: Array<{ id: string; label: string; amount: number }>;
  history: PaymentAllocationHistoryEntry[];
  productionBreakdown: WorkforcePayoutLine[];
  dailyBreakdown: Array<{
    date: string;
    workDayUnits: number;
    attendanceSource: string;
    deliveryReview?: { deliveries: number; threshold: number };
    methodAmounts: Array<{ id: string; label: string; amount: number }>;
    baseAmount: number;
    lines: WorkforcePayoutLine[];
    attendanceRange?: WorkforcePayoutAttendanceRange;
  }>;
  additionalPaymentBreakdown?: Array<{
    fieldId: string;
    code: string;
    label: string;
    calculationType: "manual_amount" | "units_x_rate";
    inputValue: number;
    rateValue: number | null;
    amount: number;
  }>;
  baseAmount: number; additions: number; grossPayment: number; deductions: number; deductionBreakdown: Array<{ code: string; label: string; amount: number }>; panAadhaarStatus: "LINKED" | "NOT LINKED" | ""; netAmount: number; status: string;
};

function money(value: number) { return `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`; }
function rateMoney(value: number) { return `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function units(value: number) { return value.toLocaleString("en-IN", { maximumFractionDigits: 2 }); }
function dateLabel(value: string) { return value.split("-").reverse().join("/"); }
function workDaysValue(value: number, source: string) { return source.toLowerCase().includes("unavailable") ? "" : value; }
function workDaysDisplay(value: number, source: string) { return workDaysValue(value, source) === "" ? "—" : units(value); }
const MAX_REVIEW_SELECTION = 1000;
const ADVANCE_DEDUCTION_LOCKED_STATUSES = new Set(["approved", "paid", "finalized", "finalised"]);
function canSendPayoutForReview(row: WorkforcePayoutRow, audience: "workforce" | "helpers") {
  return Boolean(row.reviewSubjectId && row.locationId && row.reviewToken && row.paymentDetailsAvailable)
    && (audience === "workforce"
      ? isWorkforcePayoutDisplayPublishable(row.status)
      : row.status === "Ready for review" || row.status === "Returned");
}
function canDeductAdvanceFromPayout(row: WorkforcePayoutRow) {
  return Boolean(row.reviewSubjectId && row.locationId && row.paymentDetailsAvailable)
    && !ADVANCE_DEDUCTION_LOCKED_STATUSES.has(row.status.trim().toLowerCase());
}
function statusTone(status: string) {
  if (status === "Ready for review" || status === "Approved" || status === "Payment published") return "good";
  if (status === "Under Review" || status === "Returned" || status === "Notification queued" || status === "Delivery needs review") return "warn";
  if (status === "ID not mapped" || status === "Mapping conflict" || status === "Notification failed") return "bad";
  if (status === "Configuration incomplete" || status === "Payment method not allocated") return "warn";
  return "payout-status-neutral";
}

function PayoutMultiFilter({ allLabel, label, onChange, options, selected }: {
  allLabel: string;
  label: string;
  onChange: (values: string[]) => void;
  options: string[];
  selected: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const visibleOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    return options.filter((option) => !term || option.toLowerCase().includes(term));
  }, [options, query]);
  const summary = selected.length === 0
    ? allLabel
    : selected.length <= 2
      ? selected.join(", ")
      : `${selected.length} selected`;

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    function closeOnOutsideClick(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function toggle(value: string) {
    onChange(selectedSet.has(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value]);
  }

  return <div className="payout-multi-filter" ref={rootRef}>
    <span>{label}</span>
    <div className="multi-select">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${label}: ${summary}`}
        className={`multi-select-trigger ${open ? "open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="multi-select-summary">{summary}</span>
        <ChevronDown aria-hidden="true" className="multi-select-chevron" size={15} />
      </button>
      {open ? <div aria-label={`${label} options`} className="multi-select-menu payout-filter-menu" role="dialog">
        <div className="multi-select-search payout-filter-search">
          <Search aria-hidden="true" size={14} />
          <input
            aria-label={`Search ${label.toLowerCase()}`}
            autoFocus
            className="field multi-select-search-field"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${label.toLowerCase()}`}
            type="search"
            value={query}
          />
        </div>
        <label className="multi-select-all">
          <input checked={selected.length === 0} onChange={() => onChange([])} type="checkbox" />
          <span>{allLabel}</span>
        </label>
        <div aria-label={label} className="multi-select-options" role="group">
          {visibleOptions.map((option) => <label className={`multi-select-option ${selectedSet.has(option) ? "selected" : ""}`} key={option}>
            <input checked={selectedSet.has(option)} onChange={() => toggle(option)} type="checkbox" />
            <span>{option}</span>
          </label>)}
          {!visibleOptions.length ? <p className="payout-filter-empty">No matching options</p> : null}
        </div>
      </div> : null}
    </div>
  </div>;
}

export function WorkforcePayoutTable({ audience = "workforce", canDeductAdvances = false, canEdit = false, canPublishNotifications = false, periodEnd, periodStart, rows }: { audience?: "workforce" | "helpers"; canDeductAdvances?: boolean; canEdit?: boolean; canPublishNotifications?: boolean; periodStart: string; periodEnd: string; rows: WorkforcePayoutRow[] }) {
  const router = useRouter();
  const subjectLabel = audience === "helpers" ? "Helper" : "Workforce";
  const subjectLabelLower = subjectLabel.toLowerCase();
  const [search, setSearch] = useState("");
  const [locations, setLocations] = useState<string[]>([]);
  const [designations, setDesignations] = useState<string[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [methods, setMethods] = useState<string[]>([]);
  const [mappingStatuses, setMappingStatuses] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState("50");
  const [expandedId, setExpandedId] = useState("");
  const [stickyScrollWidth, setStickyScrollWidth] = useState(0);
  const [stickyScrollFrame, setStickyScrollFrame] = useState({ left: 0, width: 0, visible: false });
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [reviewState, setReviewState] = useState<{ busy: boolean; error: string; notice: string }>({ busy: false, error: "", notice: "" });
  const [advanceState, setAdvanceState] = useState<{ busy: boolean; error: string; notice: string }>({ busy: false, error: "", notice: "" });
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const stickyScrollRef = useRef<HTMLDivElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const deferredSearch = useDeferredValue(search);
  const calendarMonthEnd = useMemo(() => {
    if (!/^\d{4}-\d{2}-01$/.test(periodStart)) return "";
    const date = new Date(`${periodStart}T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + 1);
    date.setUTCDate(0);
    return date.toISOString().slice(0, 10);
  }, [periodStart]);
  const canPublishPeriod = canEdit && audience === "workforce" && calendarMonthEnd === periodEnd;
  const canPublish = canPublishPeriod && canPublishNotifications;
  const canReviewHelpers = canEdit && audience === "helpers";
  const maxActionSelection = audience === "workforce" ? MAX_WORKFORCE_PAYOUT_NOTIFICATION_SELECTION : MAX_REVIEW_SELECTION;
  const showSelection = canPublish || canReviewHelpers || canDeductAdvances;
  const locationOptions = useMemo(() => Array.from(new Set(rows.flatMap((row) => workforcePayoutFacetValues(row.location || "-"))).values()).sort(), [rows]);
  const designationOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.designation).filter(Boolean))).sort((left, right) => left.localeCompare(right)), [rows]);
  const providerOptions = useMemo(() => Array.from(new Set(rows.flatMap((row) => workforcePayoutFacetValues(row.provider || "-"))).values()).sort(), [rows]);
  const mappingStatusOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.mappingStatus).filter(Boolean))).sort(), [rows]);
  const statusOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.status || "-")).values()).sort(), [rows]);
  const methodOptions = useMemo(() => Array.from(new Set(rows.flatMap((row) => row.paymentMethodBreakdown.map((item) => item.label)))).sort((left, right) => left.localeCompare(right)), [rows]);
  const filtered = useMemo(() => rows.filter((row) => matchesWorkforcePayoutFilters(row, deferredSearch, { locations, designations, providers, methods, mappingStatuses, statuses })), [rows, deferredSearch, locations, designations, providers, methods, mappingStatuses, statuses]);
  const pageSize = size === "all" ? Math.max(filtered.length, 1) : Number(size);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selectable = useMemo(() => filtered.filter((row) => ((canPublish || canReviewHelpers) && canSendPayoutForReview(row, audience))
    || (canDeductAdvances && canDeductAdvanceFromPayout(row))), [audience, canDeductAdvances, canPublish, canReviewHelpers, filtered]);
  const selectableIds = useMemo(() => new Set(selectable.map((row) => row.id)), [selectable]);
  const selectedRows = useMemo(() => selectable.filter((row) => selected.has(row.id)), [selectable, selected]);
  const reviewSelectedRows = useMemo(() => selectedRows.filter((row) => canSendPayoutForReview(row, audience)), [audience, selectedRows]);
  const advanceSelectedRows = useMemo(() => selectedRows.filter(canDeductAdvanceFromPayout), [selectedRows]);
  const advanceSelectionConflictIds = useMemo(() => duplicateAdvanceWorkforceIds(advanceSelectedRows), [advanceSelectedRows]);
  const hasAdvanceSelectionConflict = advanceSelectionConflictIds.size > 0;
  const hasNonReviewSelection = reviewSelectedRows.length !== selectedRows.length;
  const actionSelectionTarget = useMemo(() => selectable.slice(0, maxActionSelection), [maxActionSelection, selectable]);
  const actionSelectionFull = actionSelectionTarget.length > 0 && actionSelectionTarget.every((row) => selected.has(row.id));
  const actionSelectionLimitReached = selectedRows.length >= maxActionSelection;
  const activeFilterCount = locations.length + designations.length + providers.length + methods.length + mappingStatuses.length + statuses.length;
  const tableColumnCount = showSelection ? 13 : 12;

  useEffect(() => {
    setSelected((current) => new Set([...current].filter((id) => selectableIds.has(id))));
  }, [selectableIds]);

  useEffect(() => {
    setSelected(new Set());
    setReviewState({ busy: false, error: "", notice: "" });
    setAdvanceState({ busy: false, error: "", notice: "" });
  }, [periodStart, periodEnd]);

  useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate = selectedRows.length > 0 && !actionSelectionFull;
  }, [actionSelectionFull, selectedRows.length]);

  useEffect(() => {
    const tableWrap = tableWrapRef.current;
    const stickyScroll = stickyScrollRef.current;
    if (!tableWrap || !stickyScroll) return;
    const tableWrapElement: HTMLDivElement = tableWrap;
    const stickyScrollElement: HTMLDivElement = stickyScroll;

    let syncing = false;
    function syncFromTable() {
      if (syncing) return;
      syncing = true;
      stickyScrollElement.scrollLeft = tableWrapElement.scrollLeft;
      syncing = false;
    }
    function syncFromSticky() {
      if (syncing) return;
      syncing = true;
      tableWrapElement.scrollLeft = stickyScrollElement.scrollLeft;
      syncing = false;
    }
    function updateStickyScroll() {
      const rect = tableWrapElement.getBoundingClientRect();
      const hasOverflow = tableWrapElement.scrollWidth > tableWrapElement.clientWidth + 1;
      setStickyScrollWidth(tableWrapElement.scrollWidth);
      setStickyScrollFrame({
        left: Math.max(0, rect.left),
        width: Math.max(0, Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left)),
        visible: hasOverflow && rect.top < window.innerHeight - 20 && rect.bottom > 28
      });
      syncFromTable();
    }

    tableWrapElement.addEventListener("scroll", syncFromTable, { passive: true });
    stickyScrollElement.addEventListener("scroll", syncFromSticky, { passive: true });
    window.addEventListener("scroll", updateStickyScroll, { passive: true });
    window.addEventListener("resize", updateStickyScroll);
    const resizeObserver = new ResizeObserver(updateStickyScroll);
    resizeObserver.observe(tableWrapElement);
    const table = tableWrapElement.querySelector("table");
    if (table) resizeObserver.observe(table);
    updateStickyScroll();
    return () => {
      tableWrapElement.removeEventListener("scroll", syncFromTable);
      stickyScrollElement.removeEventListener("scroll", syncFromSticky);
      window.removeEventListener("scroll", updateStickyScroll);
      window.removeEventListener("resize", updateStickyScroll);
      resizeObserver.disconnect();
    };
  }, [expandedId, filtered.length, safePage, visible.length]);

  function clearFilters() {
    setLocations([]); setDesignations([]); setProviders([]); setMethods([]); setMappingStatuses([]); setStatuses([]); setPage(1);
  }

  function toggleBreakup(rowId: string, button: HTMLButtonElement) {
    const opening = expandedId !== rowId;
    setExpandedId(opening ? rowId : "");
    const scrollArea = button.closest<HTMLElement>(".payout-table-wrap");
    if (opening && scrollArea?.scrollLeft) requestAnimationFrame(() => scrollArea.scrollTo({ left: 0, behavior: "smooth" }));
  }

  function exportRows() {
    const exportableRows = rows.filter((row) => matchesWorkforcePayoutFilters(row, search, { locations, designations, providers, methods, mappingStatuses, statuses }));
    const csv = buildWorkforcePayoutCsv(exportableRows, subjectLabel);
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); link.download = `${audience}-payouts.csv`; link.click(); URL.revokeObjectURL(link.href);
  }

  function toggleSelected(rowId: string) {
    if (!selected.has(rowId) && actionSelectionLimitReached) {
      setReviewState({ busy: false, error: `Submit at most ${maxActionSelection.toLocaleString("en-IN")} payouts at a time. Deselect one or narrow the filters.`, notice: "" });
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId); else next.add(rowId);
      return next;
    });
    setReviewState((current) => ({ ...current, error: "", notice: "" }));
  }

  function toggleAll() {
    if (actionSelectionFull) {
      setSelected(new Set());
      setReviewState((current) => ({ ...current, error: "", notice: "" }));
      return;
    }
    setSelected(new Set(actionSelectionTarget.map((row) => row.id)));
    setReviewState((current) => ({
      ...current,
      error: "",
      notice: selectable.length > maxActionSelection
        ? `Selected the first ${maxActionSelection.toLocaleString("en-IN")} matching payouts. Narrow the filters to select a different batch.`
        : ""
    }));
  }

  async function sendNotification() {
    if (!selectedRows.length || reviewState.busy) return;
    if (hasNonReviewSelection) {
      setReviewState({ busy: false, error: audience === "workforce"
        ? "Some selected payouts do not have a complete payment setup. Deselect them before sending notifications."
        : "Some selected payouts are not Ready for review or Returned. Deselect them before sending for review.", notice: "" });
      return;
    }
    if (audience === "workforce") {
      const confirmed = window.confirm(
        `Publish ${reviewSelectedRows.length} selected payout${reviewSelectedRows.length === 1 ? "" : "s"} for ${periodStart.slice(0, 7)}?\n\n`
        + "This freezes each selected DropX ID's provider mapping, remapping and direct-pay allocation for the month, publishes the payment in DropX One, and queues the enabled App and WhatsApp notifications."
      );
      if (!confirmed) return;
    }
    setReviewState({ busy: true, error: "", notice: "" });
    try {
      const response = await fetch("/api/payments/workforce-payouts/send-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periodStart,
          periodEnd,
          items: reviewSelectedRows.map((row) => ({
            subjectType: row.reviewSubjectType,
            subjectId: row.reviewSubjectId,
            locationId: row.locationId,
            reviewToken: row.reviewToken
          }))
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? (audience === "workforce" ? "Unable to publish payouts and queue notifications." : "Unable to send Helper payouts for review."));
      setSelected(new Set());
      if (audience === "workforce") {
        const appNotifications = Number(payload.appNotifications ?? 0);
        const whatsappNotifications = Number(payload.whatsappNotifications ?? payload.notifications ?? 0);
        const channelSummary = [
          appNotifications ? `${appNotifications} App notification${appNotifications === 1 ? "" : "s"}` : "",
          whatsappNotifications ? `${whatsappNotifications} WhatsApp notification${whatsappNotifications === 1 ? "" : "s"}` : ""
        ].filter(Boolean).join(" and ");
        setReviewState({
          busy: false,
          error: "",
          notice: `${payload.submitted} payout${payload.submitted === 1 ? "" : "s"} published${channelSummary ? `; ${channelSummary} queued.` : "."}`
        });
      } else {
        setReviewState({ busy: false, error: "", notice: `${payload.submitted} Helper payout${payload.submitted === 1 ? "" : "s"} sent for review.` });
      }
      router.refresh();
    } catch (error) {
      setReviewState({ busy: false, error: error instanceof Error ? error.message : audience === "workforce" ? "Unable to publish payouts and queue notifications." : "Unable to send Helper payouts for review.", notice: "" });
    }
  }

  async function deductPendingAdvances() {
    if (!advanceSelectedRows.length || advanceState.busy) return;
    if (hasAdvanceSelectionConflict) {
      setAdvanceState({
        busy: false,
        error: "Select one location row per Workforce member before deducting advances.",
        notice: ""
      });
      return;
    }
    const confirmed = window.confirm(
      `Deduct pending advances from ${advanceSelectedRows.length} selected payout${advanceSelectedRows.length === 1 ? "" : "s"}? `
      + "The ADVANCE deduction will use the oldest pending advances first and will never reduce net pay below zero."
    );
    if (!confirmed) return;
    setAdvanceState({ busy: true, error: "", notice: "" });
    setReviewState((current) => ({ ...current, error: "", notice: "" }));
    try {
      const response = await fetch("/api/payments/workforce-payouts/deduct-advances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periodStart,
          periodEnd,
          items: advanceSelectedRows.map((row) => ({ workforceId: row.reviewSubjectId, stationId: row.locationId }))
        })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error ?? "Unable to deduct pending advances.");
      setSelected(new Set());
      setAdvanceState({
        busy: false,
        error: "",
        notice: payload.updated
          ? `${money(Number(payload.deducted ?? 0))} deducted from ${payload.updated} payout${payload.updated === 1 ? "" : "s"} under ADVANCE.`
          : "No pending advance could be deducted from the selected payouts."
      });
      router.refresh();
    } catch (error) {
      setAdvanceState({ busy: false, error: error instanceof Error ? error.message : "Unable to deduct pending advances.", notice: "" });
    }
  }

  return <>
    <div className="payout-search-strip">
      <label>
        <span className="payout-toolbar-label">Search {subjectLabelLower}</span>
        <input className="field" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder={audience === "helpers" ? "DropX ID, helper, designation or location" : "DropX ID, worker, designation or provider ID"} />
      </label>
      <div className="payout-search-controls">
        <span aria-live="polite" className="payout-result-count">{filtered.length.toLocaleString("en-IN")} matching {filtered.length === 1 ? "record" : "records"}</span>
        {showSelection ? <span className="payout-result-count">Up to {maxActionSelection.toLocaleString("en-IN")} payouts per action.</span> : null}
        {canDeductAdvances ? <button aria-describedby={hasAdvanceSelectionConflict ? "advance-deduction-selection-help" : undefined} className="button secondary" disabled={!advanceSelectedRows.length || hasAdvanceSelectionConflict || reviewState.busy || advanceState.busy} onClick={deductPendingAdvances} title={hasAdvanceSelectionConflict ? "Advance deduction requires one location row per Workforce member. Send Notification requires every publishable location row for that ID." : undefined} type="button">{advanceState.busy ? "Deducting…" : `Deduct pending advances${advanceSelectedRows.length ? ` (${advanceSelectedRows.length})` : ""}`}</button> : null}
        {canEdit ? <button className="button" disabled={(audience === "workforce" && !canPublish) || !selectedRows.length || hasNonReviewSelection || reviewState.busy || advanceState.busy} onClick={sendNotification} title={audience === "workforce" && !canPublishNotifications ? "Send Notification requires all-location access so every payout row for the DropX ID can be frozen together." : audience === "workforce" && !canPublishPeriod ? "Send Notification is available only for a complete monthly payout worksheet." : hasNonReviewSelection ? audience === "workforce" ? "Deselect payouts without a complete payment setup." : "Deselect payouts that are not Ready for review or Returned." : undefined} type="button">{reviewState.busy ? audience === "workforce" ? "Queuing…" : "Sending…" : `${audience === "workforce" ? "Send Notification" : "Send for review"}${selectedRows.length ? ` (${selectedRows.length})` : ""}`}</button> : null}
        <button className="button secondary" type="button" onClick={exportRows}>Export full CSV</button>
      </div>
    </div>
    {reviewState.error || reviewState.notice ? <div aria-live="polite" className={`payout-inline-message ${reviewState.error ? "error" : "success"}`}>{reviewState.error || reviewState.notice}</div> : null}
    {canEdit && audience === "workforce" && !canPublishNotifications ? <div className="payout-inline-message">Send Notification requires all-location access because every publishable location row for a DropX ID must be published and frozen together.</div> : null}
    {advanceState.error || advanceState.notice ? <div aria-live="polite" className={`payout-inline-message ${advanceState.error ? "error" : "success"}`}>{advanceState.error || advanceState.notice}</div> : null}
    {hasAdvanceSelectionConflict ? <div aria-live="polite" className="payout-inline-message error" id="advance-deduction-selection-help">Advance deduction requires one location row per Workforce member. Send Notification requires every publishable location row, so the extra row may be required for publication.</div> : null}
    <div aria-label="Payout filters" className="payout-filter-panel" id="payout-filter-panel">
      <PayoutMultiFilter allLabel="All allocated locations" label="Location" onChange={(values) => { setLocations(values); setPage(1); }} options={locationOptions} selected={locations} />
      <PayoutMultiFilter allLabel="All designations" label="Designation" onChange={(values) => { setDesignations(values); setPage(1); }} options={designationOptions} selected={designations} />
      <PayoutMultiFilter allLabel="All providers" label="Provider" onChange={(values) => { setProviders(values); setPage(1); }} options={providerOptions} selected={providers} />
      <PayoutMultiFilter allLabel="All methods" label="Payment method" onChange={(values) => { setMethods(values); setPage(1); }} options={methodOptions} selected={methods} />
      <PayoutMultiFilter allLabel="All mapping statuses" label="Mapping status" onChange={(values) => { setMappingStatuses(values); setPage(1); }} options={mappingStatusOptions} selected={mappingStatuses} />
      <PayoutMultiFilter allLabel="All statuses" label="Status" onChange={(values) => { setStatuses(values); setPage(1); }} options={statusOptions} selected={statuses} />
      <button className="button secondary" disabled={!activeFilterCount} onClick={clearFilters} type="button">Clear filters</button>
    </div>
    <div className="table-wrap payout-table-wrap" ref={tableWrapRef}>
      <table className="workforce-payout-table workforce-payout-detail-table payout-view-overview">
        <caption className="sr-only">{subjectLabel} payout totals</caption>
        <thead><tr>
          {showSelection ? <th className="payout-select-cell" scope="col"><input aria-label={`Select up to ${maxActionSelection.toLocaleString("en-IN")} matching ${subjectLabelLower} payouts for available actions`} checked={actionSelectionFull} disabled={!selectable.length} onChange={toggleAll} ref={selectAllRef} type="checkbox" /></th> : null}
          <th className="payout-sticky-id" scope="col">DropX ID</th>
          <th className="payout-sticky-worker" scope="col">{subjectLabel} / payment source</th>
          <th scope="col">Designation</th>
          <th scope="col">Location</th>
          <th scope="col">Allocation</th>
          <th scope="col">Payment Method</th>
          <th className="work-days-group" scope="col">Work Days</th>
          <th className="payout-money" scope="col">Gross Payment</th>
          <th className="payout-money" scope="col">Gross Deductions</th>
          <th className="payout-money" scope="col">Net Pay</th>
          <th scope="col">Status</th>
          <th scope="col">Details</th>
        </tr></thead>
        <tbody>
          {visible.length ? visible.flatMap((row) => {
            const expanded = expandedId === row.id;
            const detailId = `payout-breakup-${row.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
            const reviewDays = row.dailyBreakdown.filter(day => day.deliveryReview);
            const paymentTotals = row.productionBreakdown.filter((item) => item.amount !== 0 || item.reportedCount !== undefined);
            const deductionTotals = row.deductionBreakdown.filter((item) => item.amount !== 0);
            const hasRowAdvanceSelectionConflict = Boolean(row.reviewSubjectId && advanceSelectionConflictIds.has(row.reviewSubjectId));
            const selectionTitle = actionSelectionLimitReached && !selected.has(row.id)
              ? `Maximum ${maxActionSelection.toLocaleString("en-IN")} payouts selected`
              : hasRowAdvanceSelectionConflict
                ? "More than one selected location row belongs to this Workforce member. Keep one row only for advance deduction; Send Notification requires all publishable location rows."
                : !canSendPayoutForReview(row, audience) && canDeductAdvances && canDeductAdvanceFromPayout(row)
                  ? "Available for advance deduction only."
                  : undefined;
            const attendanceRanges = [...new Map(row.dailyBreakdown.flatMap((day) => day.attendanceRange ? [[
              `${day.attendanceRange.basis}|${day.attendanceRange.effectiveFrom}|${day.attendanceRange.effectiveTo}`,
              day.attendanceRange
            ] as const] : [])).values()];
            return [
              <tr key={row.id} className={row.mappingStatus === "ID not mapped" || row.mappingStatus === "Mapping conflict" ? "payout-id-unmapped" : row.panAadhaarStatus === "NOT LINKED" ? "payout-pan-aadhaar-unlinked" : undefined}>
                {showSelection ? <td className="payout-select-cell"><input aria-label={`Select ${row.dropxId || row.name} for payout actions`} checked={selected.has(row.id)} disabled={!selectableIds.has(row.id) || (actionSelectionLimitReached && !selected.has(row.id))} onChange={() => toggleSelected(row.id)} title={selectionTitle} type="checkbox" /></td> : null}
                <td className="payout-sticky-id">{row.dropxId ? <><strong>{row.dropxId}</strong><small className="payout-dropx-status" title={`DropX ID status: ${row.dropxStatus}`}>{row.dropxStatus}</small></> : <span className="sr-only">No DropX ID mapped</span>}</td>
                <td className="payout-sticky-worker"><strong>{row.name}</strong><small title={`${row.providerMemberName} · ${row.providerMemberId}`}>{row.providerMemberName} · {row.providerMemberId}</small></td>
                <td>{row.designation ? <strong>{row.designation}</strong> : <span aria-hidden="true">—</span>}</td>
                <td><strong>{row.location}</strong></td>
                <td><strong>{row.provider}</strong><small>{row.model}</small></td>
                <td>{row.paymentDetailsAvailable ? <strong>{row.paymentMethod}</strong> : <span className="sr-only">Payment method unavailable</span>}</td>
                <td className="work-days-cell">{row.paymentDetailsAvailable ? <><strong>{workDaysDisplay(row.workDays, row.workDaysSource)}</strong><small>{row.workDaysSource}</small></> : null}</td>
                <td className="payout-money">{row.paymentDetailsAvailable ? <strong>{money(row.grossPayment)}</strong> : null}</td>
                <td className="negative payout-money">{row.paymentDetailsAvailable ? row.deductions ? `- ${money(row.deductions)}` : "—" : null}</td>
                <td className="payout-money payout-net-pay">{row.paymentDetailsAvailable ? <strong>{money(row.netAmount)}</strong> : null}</td>
                <td><div className="payout-status-stack">{reviewDays.length > 0 && <span className="status-pill warn">{reviewDays.length} low-delivery days</span>}<span className={`status-pill ${statusTone(row.status)}`}>{row.status}</span>{row.paymentDetailsAvailable && row.panAadhaarStatus ? <span className={`status-pill ${row.panAadhaarStatus === "LINKED" ? "good" : "warn"}`}>{row.panAadhaarStatus === "LINKED" ? "PAN linked" : "PAN not linked"}</span> : null}</div></td>
                <td><div className="payout-detail-actions">{row.paymentDetailsAvailable ? <button aria-controls={detailId} aria-expanded={expanded} className="button secondary compact" onClick={(event) => toggleBreakup(row.id, event.currentTarget)} type="button">{expanded ? "Close" : "Breakup"}</button> : <span className="sr-only">No payment breakup until mapping and payment setup are complete</span>}<PaymentAllocationHistoryButton entries={row.history} subjectLabel={`${row.dropxId || row.providerMemberId || row.name} · ${row.name}`} /></div></td>
              </tr>,
              expanded ? <tr className="payout-total-detail-row" key={`${row.id}-totals`}>
                <td colSpan={tableColumnCount}>
                  <section className="payout-total-detail" id={detailId}>
                    <header>
                      <span><small>DropX associate</small><strong>{row.name}</strong></span>
                      <span><small>Partner ID</small><strong>{row.providerMemberId}</strong></span>
                      <span><small>Partner name</small><strong>{row.providerMemberName}</strong></span>
                    </header>
                    <div className="payout-breakup-summary">
                      <span><small>Gross payment</small><strong>{money(row.grossPayment)}</strong></span>
                      <span><small>Gross deductions</small><strong className={row.deductions ? "negative" : undefined}>{row.deductions ? `- ${money(row.deductions)}` : money(0)}</strong></span>
                      <span><small>Net pay</small><strong>{money(row.netAmount)}</strong></span>
                    </div>
                    {attendanceRanges.length ? <div className="payout-breakup-summary">
                      {attendanceRanges.map((range) => <span key={`${range.basis}|${range.effectiveFrom}|${range.effectiveTo}`}>
                        <small>Uploaded attendance range</small>
                        <strong>{units(range.quantity)} work {range.basis} · {dateLabel(range.effectiveFrom)}–{dateLabel(range.effectiveTo)}</strong>
                      </span>)}
                    </div> : null}
                    {reviewDays.length > 0 && <details className="payout-breakup-summary"><summary>Review low-delivery days · pay is included</summary><ul>{reviewDays.map(day => <li key={day.date}>{dateLabel(day.date)}: {day.deliveryReview!.deliveries} deliveries · below {day.deliveryReview!.threshold}</li>)}</ul></details>}
                    <div className="payout-total-groups">
                      <section className="payout-total-group">
                        <h3>Payment totals</h3>
                        <div className="table-wrap payout-total-table-wrap">
                          <table>
                            <caption className="sr-only">Payment-head totals for {row.name}</caption>
                            <thead><tr><th scope="col">Payment</th><th className="payout-money" scope="col">Units</th><th className="payout-money" scope="col">Rate</th><th className="payout-money" scope="col">Amount</th></tr></thead>
                            <tbody>
                              {paymentTotals.map((item) => <tr key={`${item.code}|${item.componentType}|${item.rate}|${item.reportedCount === undefined ? "standard" : `${item.thresholdPeriod}|${item.thresholdMinimum}|${item.thresholdConfigurationMissing === true}`}`}>
                                <td>
                                  <strong>{item.label}</strong>
                                  {item.reportedCount !== undefined ? <small>{item.thresholdConfigurationMissing
                                    ? "Combined threshold · minimum not saved"
                                    : `${item.thresholdPeriod === "month" ? "Monthly" : "Daily"} combined minimum · ${units(item.thresholdMinimum ?? 0)} units`}</small> : null}
                                </td>
                                <td className="payout-money">{item.reportedCount === undefined
                                  ? units(item.count)
                                  : <span className="payout-threshold-units">
                                    <span><small>Reported Units</small><strong>{units(item.reportedCount)}</strong></span>
                                    <span><small>Threshold / Excluded Units</small><strong>{units(item.thresholdDeducted ?? 0)}</strong></span>
                                    <span><small>Payable Units</small><strong>{units(item.count)}</strong></span>
                                  </span>}</td>
                                <td className="payout-money">{rateMoney(item.rate)}</td>
                                <td className="payout-money"><strong>{money(item.amount)}</strong></td>
                              </tr>)}
                              {(row.additionalPaymentBreakdown ?? []).filter((item) => item.amount !== 0).map((item) => <tr key={`additional-${item.fieldId}`}>
                                <td><strong>{item.label}</strong><small>{item.code} · Additional payment</small></td>
                                <td className="payout-money">{item.calculationType === "manual_amount" ? "—" : units(item.inputValue)}</td>
                                <td className="payout-money">{item.rateValue === null ? "—" : rateMoney(item.rateValue)}</td>
                                <td className="positive payout-money"><strong>+ {money(item.amount)}</strong></td>
                              </tr>)}
                              {row.additions && !(row.additionalPaymentBreakdown ?? []).some((item) => item.amount !== 0) ? <tr><td><strong>Additional payments</strong></td><td className="payout-money">—</td><td className="payout-money">—</td><td className="positive payout-money"><strong>+ {money(row.additions)}</strong></td></tr> : null}
                              {!paymentTotals.length && !row.additions ? <tr><td className="empty-cell" colSpan={4}>No payment amount for this period.</td></tr> : null}
                            </tbody>
                            <tfoot><tr><th colSpan={3} scope="row">Gross payment</th><td className="payout-money"><strong>{money(row.grossPayment)}</strong></td></tr></tfoot>
                          </table>
                        </div>
                      </section>
                      <section className="payout-total-group">
                        <h3>Deduction totals</h3>
                        <div className="table-wrap payout-total-table-wrap">
                          <table>
                            <caption className="sr-only">Deduction-head totals for {row.name}</caption>
                            <thead><tr><th scope="col">Deduction</th><th className="payout-money" scope="col">Total</th></tr></thead>
                            <tbody>
                              {deductionTotals.map((item) => <tr key={item.code}><td><strong>{item.label}</strong></td><td className="negative payout-money"><strong>- {money(item.amount)}</strong></td></tr>)}
                              {!deductionTotals.length ? <tr><td className="empty-cell" colSpan={2}>No deductions for this period.</td></tr> : null}
                            </tbody>
                            <tfoot><tr><th scope="row">Gross deductions</th><td className={`${row.deductions ? "negative " : ""}payout-money`}><strong>{row.deductions ? `- ${money(row.deductions)}` : money(0)}</strong></td></tr></tfoot>
                          </table>
                        </div>
                      </section>
                    </div>
                  </section>
                </td>
              </tr> : null
            ].filter(Boolean) as ReactElement[];
          }) : <tr><td className="empty-cell" colSpan={tableColumnCount}>No {subjectLabelLower} payouts match the selected period and filters.</td></tr>}
        </tbody>
      </table>
    </div>
    <div
      aria-label={`${subjectLabel} payout horizontal scrollbar`}
      className={`payout-sticky-scroll ${stickyScrollFrame.visible ? "visible" : ""}`}
      ref={stickyScrollRef}
      role="region"
      style={{ left: stickyScrollFrame.left, width: stickyScrollFrame.width }}
      tabIndex={stickyScrollFrame.visible ? 0 : -1}
    >
      <div style={{ width: stickyScrollWidth }} />
    </div>
    <div className="pagination payout-pagination">
      <label className="payout-page-size">Rows per page<select className="field" value={size} onChange={(event) => { setSize(event.target.value); setPage(1); }}>{["50","100","500","1000","all"].map((value) => <option value={value} key={value}>{value === "all" ? "All" : value}</option>)}</select></label>
      <span>Showing {filtered.length ? (safePage - 1) * pageSize + 1 : 0}–{Math.min(safePage * pageSize, filtered.length)} of {filtered.length}</span>
      <div><button className="button secondary compact" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} type="button">Previous</button><span>Page {safePage} of {pages}</span><button className="button secondary compact" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)} type="button">Next</button></div>
    </div>
  </>;
}
