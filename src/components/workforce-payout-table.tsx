"use client";

import { ChevronDown, Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { buildWorkforcePayoutCsv } from "@/lib/workforce-payout-export";
import {
  WORKFORCE_PAYOUT_FILTER_NONE,
  matchesWorkforcePayoutFilters,
  reconcileWorkforcePayoutFilterSelection,
  toggleWorkforcePayoutFilterOption,
  workforcePayoutFacetValues
} from "@/lib/workforce-payout-filters";
import {
  buildWorkforcePayoutBankSelectionIndex,
  buildWorkforcePayoutPreliminaryBalanceIndex,
  chunkPayoutRowsBySubject,
  duplicateAdvanceWorkforceIds,
  resolveWorkforcePayoutBankSelection,
  selectedWorkforcePayoutBankIds,
  workforcePayoutMappingLockSelectionIds,
  type WorkforcePayoutPublicationLockState
} from "@/lib/workforce-payout-action-selection";
import { chunkedValues } from "@/lib/bounded-concurrency";
import { WORKFORCE_PAYOUT_INPUTS_CHANGED_EVENT } from "@/lib/workforce-payout-client-events";
import { isWorkforcePayoutDisplayPublishable } from "@/lib/workforce-payout-publication-eligibility";
import { MAX_WORKFORCE_PAYOUT_NOTIFICATION_SELECTION } from "@/lib/workforce-payout-publication-limits";
import { buildWorkforcePayoutPublicationSnapshot } from "@/lib/workforce-payout-publication-snapshot";
import { PaymentAllocationHistoryButton } from "@/components/payment-allocation-history-button";
import {
  WorkforcePayoutBankDialog,
  type WorkforcePayoutBankOption
} from "@/components/workforce-payout-bank-dialog";
import { WorkforcePayoutManualEditor } from "@/components/workforce-payout-manual-editor";
import { WorkforcePayoutPaymentHistoryButton } from "@/components/workforce-payout-payment-history-button";
import type { PaymentAllocationHistoryEntry } from "@/lib/payment-allocation-history";
import {
  isWorkforcePayoutPaymentBalanceAvailable,
  workforcePayoutPaymentEligibilityLabel,
  type WorkforcePayoutPaymentSummary
} from "@/lib/workforce-payout-payment-summary";

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
  reviewSubjectType?: "workforce" | "helper"; reviewSubjectId?: string | null; reviewToken?: string | null; publicationDependencyHash?: string | null;
  publicationLocations?: Array<{ id: string; label: string }>;
  publicationLockState?: WorkforcePayoutPublicationLockState | null;
  publicationPaymentReady?: boolean;
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
  paymentSummary?: WorkforcePayoutPaymentSummary;
  baseAmount: number; additions: number; grossPayment: number; deductions: number; deductionBreakdown: Array<{ code: string; label: string; amount: number }>; panAadhaarStatus: "LINKED" | "NOT LINKED" | ""; netAmount: number; status: string;
};

export type WorkforcePayoutMappingUnlock = {
  id: string;
  workforceId: string;
  dropxId: string;
  name: string;
  reason: string;
  unlockedAt: string;
};

function money(value: number) { return `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`; }
function exactMoney(value: number) { return `Rs ${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function rateMoney(value: number) { return `Rs ${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`; }
function units(value: number) { return value.toLocaleString("en-IN", { maximumFractionDigits: 2 }); }
function dateLabel(value: string) { return value.split("-").reverse().join("/"); }
function workDaysValue(value: number, source: string) { return source.toLowerCase().includes("unavailable") ? "" : value; }
function workDaysDisplay(value: number, source: string) { return workDaysValue(value, source) === "" ? "—" : units(value); }
const PAYOUT_ACTION_REQUEST_CHUNK_SIZE = 50;
const ADVANCE_ACTION_REQUEST_CHUNK_SIZE = 1000;
const ADVANCE_DEDUCTION_LOCKED_STATUSES = new Set(["approved", "paid", "finalized", "finalised"]);
const BANK_PAYMENT_BLOCKED_STATUSES = new Set(["payment processing", "payment on hold", "pan not linked"]);
function canSendPayoutForReview(row: WorkforcePayoutRow, audience: "workforce" | "helpers") {
  if (row.paymentSummary?.status === "Payment Processing") return false;
  return Boolean(row.reviewSubjectId && row.locationId && row.reviewToken && row.paymentDetailsAvailable)
    && (audience === "workforce"
      ? isWorkforcePayoutDisplayPublishable(row.status)
      : row.status === "Ready for review" || row.status === "Returned");
}
function canDeductAdvanceFromPayout(row: WorkforcePayoutRow) {
  return Boolean(row.reviewSubjectId && row.locationId && row.paymentDetailsAvailable)
    && row.paymentSummary?.status !== "Payment Processing"
    && row.publicationLockState !== "unlocked"
    && !ADVANCE_DEDUCTION_LOCKED_STATUSES.has(row.status.trim().toLowerCase());
}
function canManuallyEditPayout(row: WorkforcePayoutRow) {
  return Boolean(row.reviewSubjectId && row.locationId && row.dropxId)
    && row.paymentSummary?.status !== "Payment Processing";
}
function publicationRefreshPending(row: WorkforcePayoutRow) {
  return row.paymentSummary?.eligible === false
    && row.paymentSummary.eligibilityCode?.trim().toLowerCase() === "publication_refresh_pending";
}
function canCreateBankPayment(row: WorkforcePayoutRow, preliminaryAvailableToPay = 0) {
  const visibleStatus = String(row.paymentSummary?.status ?? row.status).trim().toLowerCase();
  const hasAuthoritativeCandidate = row.publicationPaymentReady === true
    && row.paymentSummary?.eligible === true
    && Number(row.paymentSummary?.availableToPay ?? 0) > 0;
  const canRefreshCandidate = publicationRefreshPending(row) && preliminaryAvailableToPay > 0;
  return Boolean(row.reviewSubjectId && row.paymentDetailsAvailable)
    && row.publicationLockState === "locked"
    && row.paymentSummary?.status !== "Payment Processing"
    && !BANK_PAYMENT_BLOCKED_STATUSES.has(visibleStatus)
    && row.panAadhaarStatus !== "NOT LINKED"
    && (hasAuthoritativeCandidate || canRefreshCandidate);
}
function missingPayoutNotificationLocations(allRows: WorkforcePayoutRow[], selectedRows: WorkforcePayoutRow[]) {
  const selectedLocations = new Set(selectedRows.map((row) => `${String(row.reviewSubjectId ?? "")}|${String(row.locationId ?? "")}`));
  const missingBySubject = new Map<string, { dropxId: string; name: string; locations: Set<string> }>();
  const selectedBySubject = new Map<string, WorkforcePayoutRow>();
  selectedRows.forEach((row) => {
    const subjectId = String(row.reviewSubjectId ?? "");
    if (subjectId && !selectedBySubject.has(subjectId)) selectedBySubject.set(subjectId, row);
  });
  selectedBySubject.forEach((selectedRow, subjectId) => {
    const requiredLocations = selectedRow.publicationLocations?.length
      ? selectedRow.publicationLocations
      : allRows.flatMap((row) => row.reviewSubjectId === subjectId && canSendPayoutForReview(row, "workforce") && row.locationId
        ? [{ id: row.locationId, label: row.location || "Unassigned location" }]
        : []);
    requiredLocations.forEach((location) => {
      if (selectedLocations.has(`${subjectId}|${location.id}`)) return;
      const current = missingBySubject.get(subjectId) ?? {
        dropxId: selectedRow.dropxId || subjectId,
        name: selectedRow.name,
        locations: new Set<string>()
      };
      current.locations.add(location.label || "Unassigned location");
      missingBySubject.set(subjectId, current);
    });
  });
  return [...missingBySubject.values()].map((entry) => ({
    dropxId: entry.dropxId,
    name: entry.name,
    locations: [...entry.locations].sort((left, right) => left.localeCompare(right))
  }));
}
function statusTone(status: string) {
  if (status === "Ready for review" || status === "Approved" || status === "Payment published" || status === "Paid") return "good";
  if (status === "Under Review" || status === "Returned" || status === "Notification queued" || status === "Delivery needs review" || status === "Mapping unlocked" || status === "Payment Processing" || status === "Payment On Hold" || status === "PAN Not Linked" || status === "Partially paid" || status === "Publication refresh pending" || status === "Republish required" || status === "Relock required" || status === "No positive balance") return "warn";
  if (status === "ID not mapped" || status === "Mapping conflict" || status === "Notification failed" || status === "Payment Failed" || status === "Payment Cancelled" || status === "Payment profile unavailable" || status === "Payment unavailable") return "bad";
  if (status === "Configuration incomplete" || status === "Payment method not allocated" || status === "Payment details required" || status === "Current location required") return "warn";
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
  const implicitAll = selected.length === 0;
  const selectedOptions = useMemo(() => options.filter((option) => selectedSet.has(option)), [options, selectedSet]);
  const visibleOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    return options.filter((option) => !term || option.toLowerCase().includes(term));
  }, [options, query]);
  const summary = selected.length === 0
    ? allLabel
    : selectedOptions.length === 0
      ? "None selected"
      : selectedOptions.length <= 2
        ? selectedOptions.join(", ")
        : `${selectedOptions.length} selected`;

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
    onChange(toggleWorkforcePayoutFilterOption(options, selected, value));
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
          <input
            checked={selected.length === 0}
            onChange={(event) => onChange(event.target.checked ? [] : [WORKFORCE_PAYOUT_FILTER_NONE])}
            type="checkbox"
          />
          <span>{allLabel}</span>
        </label>
        <div aria-label={label} className="multi-select-options" role="group">
          {visibleOptions.map((option) => <label className={`multi-select-option ${implicitAll || selectedSet.has(option) ? "selected" : ""}`} key={option}>
            <input checked={implicitAll || selectedSet.has(option)} onChange={() => toggle(option)} type="checkbox" />
            <span>{option}</span>
          </label>)}
          {!visibleOptions.length ? <p className="payout-filter-empty">No matching options</p> : null}
        </div>
      </div> : null}
    </div>
  </div>;
}

export function WorkforcePayoutTable({ audience = "workforce", banks = [], canDeductAdvances = false, canEdit = false, canManageMappingLocks = false, canProcessPayments = false, canPublishNotifications = false, mappingUnlocks = [], periodEnd, periodStart, rows }: { audience?: "workforce" | "helpers"; banks?: WorkforcePayoutBankOption[]; canDeductAdvances?: boolean; canEdit?: boolean; canManageMappingLocks?: boolean; canProcessPayments?: boolean; canPublishNotifications?: boolean; mappingUnlocks?: WorkforcePayoutMappingUnlock[]; periodStart: string; periodEnd: string; rows: WorkforcePayoutRow[] }) {
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
  const [mappingState, setMappingState] = useState<{ busy: boolean; error: string; notice: string }>({ busy: false, error: "", notice: "" });
  const [bankBusy, setBankBusy] = useState(false);
  const [mappingDialog, setMappingDialog] = useState<null | {
    action: "unlock" | "relock";
    explanation: string;
    operationId: string;
  }>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const stickyScrollRef = useRef<HTMLDivElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const mappingDialogRef = useRef<HTMLElement>(null);
  const mappingDialogTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mappingDialogOpen = mappingDialog !== null;
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
  const canManuallyEdit = canEdit && audience === "workforce";
  const canManageLocks = canManageMappingLocks && audience === "workforce";
  const showSelection = canPublish || canReviewHelpers || canDeductAdvances || canManuallyEdit || canManageLocks || canProcessPayments;
  const locationOptions = useMemo(() => Array.from(new Set(rows.flatMap((row) => workforcePayoutFacetValues(row.location || "-"))).values()).sort(), [rows]);
  const designationOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.designation).filter(Boolean))).sort((left, right) => left.localeCompare(right)), [rows]);
  const providerOptions = useMemo(() => Array.from(new Set(rows.flatMap((row) => workforcePayoutFacetValues(row.provider || "-"))).values()).sort(), [rows]);
  const mappingStatusOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.mappingStatus).filter(Boolean))).sort(), [rows]);
  const statusOptions = useMemo(() => Array.from(new Set(rows.map((row) => row.status || "-")).values()).sort(), [rows]);
  const methodOptions = useMemo(() => Array.from(new Set(rows.flatMap((row) => row.paymentMethodBreakdown.map((item) => item.label)))).sort((left, right) => left.localeCompare(right)), [rows]);
  const filtered = useMemo(() => rows.filter((row) => matchesWorkforcePayoutFilters(row, deferredSearch, { locations, designations, providers, methods, mappingStatuses, statuses })), [rows, deferredSearch, locations, designations, providers, methods, mappingStatuses, statuses]);
  const preliminaryBankBalances = useMemo(
    () => buildWorkforcePayoutPreliminaryBalanceIndex(rows),
    [rows]
  );
  const bankActionableIds = useMemo(() => new Set(rows
    .filter((row) => canCreateBankPayment(
      row,
      preliminaryBankBalances.get(String(row.reviewSubjectId ?? "").trim()) ?? 0
    ))
    .map((row) => row.id)), [preliminaryBankBalances, rows]);
  const pageSize = size === "all" ? Math.max(filtered.length, 1) : Number(size);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selectable = useMemo(() => filtered.filter((row) => ((canPublish || canReviewHelpers) && canSendPayoutForReview(row, audience))
    || (canDeductAdvances && canDeductAdvanceFromPayout(row))
    || (canManuallyEdit && canManuallyEditPayout(row))
    || (canManageLocks && row.publicationLockState === "locked" && row.paymentSummary?.status !== "Payment Processing")
    || (canProcessPayments && bankActionableIds.has(row.id))), [audience, bankActionableIds, canDeductAdvances, canManageLocks, canManuallyEdit, canProcessPayments, canPublish, canReviewHelpers, filtered]);
  const selectableIds = useMemo(() => new Set(selectable.map((row) => row.id)), [selectable]);
  const selectedRows = useMemo(() => selectable.filter((row) => selected.has(row.id)), [selectable, selected]);
  const reviewSelectedRows = useMemo(() => selectedRows.filter((row) => canSendPayoutForReview(row, audience)), [audience, selectedRows]);
  const advanceSelectedRows = useMemo(() => selectedRows.filter(canDeductAdvanceFromPayout), [selectedRows]);
  const manualSelectedRows = useMemo(() => selectedRows.filter(canManuallyEditPayout), [selectedRows]);
  const bankSelectionIndex = useMemo(() => buildWorkforcePayoutBankSelectionIndex(
    rows,
    (row) => bankActionableIds.has(row.id),
    (row) => publicationRefreshPending(row)
      ? preliminaryBankBalances.get(String(row.reviewSubjectId ?? "").trim()) ?? 0
      : Number(row.paymentSummary?.availableToPay ?? 0)
  ), [bankActionableIds, preliminaryBankBalances, rows]);
  const selectedBankWorkforceIds = useMemo(
    () => selectedWorkforcePayoutBankIds(selectedRows, (row) => bankActionableIds.has(row.id)),
    [bankActionableIds, selectedRows]
  );
  const bankSelection = useMemo(() => resolveWorkforcePayoutBankSelection(
    bankSelectionIndex,
    selected,
    selectedBankWorkforceIds
  ), [bankSelectionIndex, selected, selectedBankWorkforceIds]);
  const bankWorkforceIds = bankSelection.workforceIds;
  const bankTotalAmount = bankSelection.totalAmount;
  const bankProfilesWithImplicitRows = bankWorkforceIds.filter((workforceId) =>
    bankSelectionIndex.get(workforceId)?.rowIds.some((rowId) => !selected.has(rowId))
  ).length;
  const bankRefreshPendingWorkforceIds = useMemo(() => new Set(rows
    .filter((row) => bankActionableIds.has(row.id) && publicationRefreshPending(row))
    .flatMap((row) => row.reviewSubjectId ? [row.reviewSubjectId.trim()] : [])), [bankActionableIds, rows]);
  const selectedBankRefreshPendingCount = bankWorkforceIds
    .filter((workforceId) => bankRefreshPendingWorkforceIds.has(workforceId))
    .length;
  const mappingUnlockWorkforceIds = useMemo(
    () => workforcePayoutMappingLockSelectionIds(selectedRows, "locked"),
    [selectedRows]
  );
  const relockTargets = mappingUnlocks;
  const advanceSelectionConflictIds = useMemo(() => duplicateAdvanceWorkforceIds(advanceSelectedRows), [advanceSelectedRows]);
  const hasAdvanceSelectionConflict = advanceSelectionConflictIds.size > 0;
  const skippedReviewSelectionCount = selectedRows.length - reviewSelectedRows.length;
  const actionSelectionFull = selectable.length > 0 && selectable.every((row) => selected.has(row.id));
  const activeFilterCount = locations.length + designations.length + providers.length + methods.length + mappingStatuses.length + statuses.length;
  const tableColumnCount = showSelection ? 13 : 12;
  const actionBusy = reviewState.busy || advanceState.busy || mappingState.busy || bankBusy;

  useEffect(() => {
    setSelected((current) => new Set([...current].filter((id) => selectableIds.has(id))));
  }, [selectableIds]);

  useEffect(() => {
    setLocations((current) => reconcileWorkforcePayoutFilterSelection(locationOptions, current));
    setDesignations((current) => reconcileWorkforcePayoutFilterSelection(designationOptions, current));
    setProviders((current) => reconcileWorkforcePayoutFilterSelection(providerOptions, current));
    setMethods((current) => reconcileWorkforcePayoutFilterSelection(methodOptions, current));
    setMappingStatuses((current) => reconcileWorkforcePayoutFilterSelection(mappingStatusOptions, current));
    setStatuses((current) => reconcileWorkforcePayoutFilterSelection(statusOptions, current));
  }, [designationOptions, locationOptions, mappingStatusOptions, methodOptions, providerOptions, statusOptions]);

  useEffect(() => {
    function handlePayoutInputsChanged(event: Event) {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setSelected(new Set());
      setExpandedId("");
      setReviewState({
        busy: false,
        error: "",
        notice: detail?.message || "Payout inputs were updated and the worksheet has been refreshed."
      });
    }
    window.addEventListener(WORKFORCE_PAYOUT_INPUTS_CHANGED_EVENT, handlePayoutInputsChanged);
    return () => window.removeEventListener(WORKFORCE_PAYOUT_INPUTS_CHANGED_EVENT, handlePayoutInputsChanged);
  }, []);

  useEffect(() => {
    setSelected(new Set());
    setReviewState({ busy: false, error: "", notice: "" });
    setAdvanceState({ busy: false, error: "", notice: "" });
    setMappingState({ busy: false, error: "", notice: "" });
    setMappingDialog(null);
  }, [periodStart, periodEnd]);

  useEffect(() => {
    if (!mappingDialogOpen) return;
    const dialog = mappingDialogRef.current;
    dialog?.querySelector<HTMLElement>("textarea, button:not([disabled])")?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !mappingState.busy) {
        setMappingDialog(null);
        requestAnimationFrame(() => mappingDialogTriggerRef.current?.focus());
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), textarea:not([disabled])"
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [mappingDialogOpen, mappingState.busy]);

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
    setSelected(new Set(selectable.map((row) => row.id)));
    setReviewState((current) => ({ ...current, error: "", notice: "" }));
  }

  async function sendNotification() {
    if (!reviewSelectedRows.length || reviewState.busy) return;
    if (audience === "workforce") {
      const missingLocations = missingPayoutNotificationLocations(rows, reviewSelectedRows);
      if (missingLocations.length) {
        const details = missingLocations
          .map((entry) => `${entry.dropxId}${entry.name ? ` (${entry.name})` : ""}: ${entry.locations.join(", ")}`)
          .join("; ");
        setReviewState({
          busy: false,
          error: `Select every publishable location row for each DropX ID. Missing locations: ${details}. Clear or change the filters, then select those rows too.`,
          notice: ""
        });
        return;
      }
      if (reviewSelectedRows.some((row) => !row.publicationDependencyHash)) {
        setReviewState({ busy: false, error: "The payout worksheet version is unavailable. Refresh the page and select the payouts again.", notice: "" });
        return;
      }
      const confirmed = window.confirm(
        `Publish ${reviewSelectedRows.length} selected payout${reviewSelectedRows.length === 1 ? "" : "s"} for ${periodStart.slice(0, 7)}?\n\n`
        + "This freezes each selected DropX ID's provider mapping, remapping and direct-pay allocation for the month, publishes the payment in DropX One, and queues the enabled App and WhatsApp notifications."
      );
      if (!confirmed) return;
    }
    setReviewState({ busy: true, error: "", notice: "" });
    let completedChunks = 0;
    try {
      const requestChunks = chunkPayoutRowsBySubject(reviewSelectedRows, MAX_WORKFORCE_PAYOUT_NOTIFICATION_SELECTION);
      const totals = { submitted: 0, appNotifications: 0, whatsappNotifications: 0 };
      for (const chunk of requestChunks) {
        const response = await fetch("/api/payments/workforce-payouts/send-review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            periodStart,
            periodEnd,
            items: chunk.map((row) => ({
              subjectType: row.reviewSubjectType,
              subjectId: row.reviewSubjectId,
              locationId: row.locationId,
              reviewToken: row.reviewToken,
              ...(audience === "workforce" ? {
                calculationSnapshot: buildWorkforcePayoutPublicationSnapshot(
                  row,
                  periodStart,
                  periodEnd,
                  row.publicationDependencyHash ?? ""
                )
              } : {})
            }))
          })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error ?? (audience === "workforce" ? "Unable to publish payouts and queue notifications." : "Unable to send Helper payouts for review."));
        totals.submitted += Number(payload.submitted ?? chunk.length);
        totals.appNotifications += Number(payload.appNotifications ?? 0);
        totals.whatsappNotifications += Number(payload.whatsappNotifications ?? payload.notifications ?? 0);
        completedChunks += 1;
      }
      setSelected(new Set());
      if (audience === "workforce") {
        const channelSummary = [
          totals.appNotifications ? `${totals.appNotifications} App notification${totals.appNotifications === 1 ? "" : "s"}` : "",
          totals.whatsappNotifications ? `${totals.whatsappNotifications} WhatsApp notification${totals.whatsappNotifications === 1 ? "" : "s"}` : ""
        ].filter(Boolean).join(" and ");
        setReviewState({
          busy: false,
          error: "",
          notice: `${totals.submitted} payout${totals.submitted === 1 ? "" : "s"} published${channelSummary ? `; ${channelSummary} queued.` : "."}`
        });
      } else {
        setReviewState({ busy: false, error: "", notice: `${totals.submitted} Helper payout${totals.submitted === 1 ? "" : "s"} sent for review.` });
      }
      router.refresh();
    } catch (error) {
      if (completedChunks) {
        setSelected(new Set());
        router.refresh();
      }
      const message = error instanceof Error ? error.message : audience === "workforce" ? "Unable to publish payouts and queue notifications." : "Unable to send Helper payouts for review.";
      setReviewState({ busy: false, error: completedChunks ? `${completedChunks} request batch${completedChunks === 1 ? " was" : "es were"} completed before the next batch failed. The worksheet is refreshing; select the remaining payouts and retry. ${message}` : message, notice: "" });
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
    let completedChunks = 0;
    try {
      const totals = { deducted: 0, updated: 0 };
      for (const chunk of chunkedValues(advanceSelectedRows, ADVANCE_ACTION_REQUEST_CHUNK_SIZE)) {
        const response = await fetch("/api/payments/workforce-payouts/deduct-advances", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            periodStart,
            periodEnd,
            items: chunk.map((row) => ({ workforceId: row.reviewSubjectId, stationId: row.locationId }))
          })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error ?? "Unable to deduct pending advances.");
        totals.deducted += Number(payload.deducted ?? 0);
        totals.updated += Number(payload.updated ?? 0);
        completedChunks += 1;
      }
      setSelected(new Set());
      setAdvanceState({
        busy: false,
        error: "",
        notice: totals.updated
          ? `${money(totals.deducted)} deducted from ${totals.updated} payout${totals.updated === 1 ? "" : "s"} under ADVANCE.`
          : "No pending advance could be deducted from the selected payouts."
      });
      router.refresh();
    } catch (error) {
      if (completedChunks) {
        setSelected(new Set());
        router.refresh();
      }
      const message = error instanceof Error ? error.message : "Unable to deduct pending advances.";
      setAdvanceState({ busy: false, error: completedChunks ? `${completedChunks} advance batch${completedChunks === 1 ? " was" : "es were"} applied before the next batch failed. The worksheet is refreshing. ${message}` : message, notice: "" });
    }
  }

  function openMappingLockDialog(action: "unlock" | "relock", trigger: HTMLButtonElement) {
    const hasTargets = action === "unlock"
      ? mappingUnlockWorkforceIds.length > 0
      : relockTargets.length > 0;
    if (!hasTargets || mappingState.busy) return;
    mappingDialogTriggerRef.current = trigger;
    setMappingState((current) => ({ ...current, error: "", notice: "" }));
    setMappingDialog({ action, explanation: "", operationId: crypto.randomUUID() });
  }

  function closeMappingLockDialog() {
    if (mappingState.busy) return;
    setMappingDialog(null);
    requestAnimationFrame(() => mappingDialogTriggerRef.current?.focus());
  }

  async function submitMappingLockChange() {
    if (!mappingDialog || mappingState.busy) return;
    const explanation = mappingDialog.explanation.trim();
    if (explanation.length < 10 || explanation.length > 500) {
      setMappingState({ busy: false, error: "Enter 10 to 500 characters for the audit record.", notice: "" });
      return;
    }
    const action = mappingDialog.action;
    const targetIds = action === "unlock"
      ? mappingUnlockWorkforceIds
      : relockTargets.map((entry) => entry.id);
    if (!targetIds.length) {
      setMappingState({ busy: false, error: "The mapping lock selection changed. Refresh and try again.", notice: "" });
      return;
    }
    setMappingState({ busy: true, error: "", notice: "" });
    let completedChunks = 0;
    try {
      const totals = { unlocked: 0, relocked: 0, published: 0 };
      const targetChunks = chunkedValues(targetIds, PAYOUT_ACTION_REQUEST_CHUNK_SIZE);
      for (const [index, chunk] of targetChunks.entries()) {
        const response = await fetch("/api/payments/workforce-payouts/mapping-locks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            periodStart,
            periodEnd,
            operationId: index === 0 ? mappingDialog.operationId : crypto.randomUUID(),
            ...(action === "unlock"
              ? { workforceIds: chunk, reason: explanation }
              : { unlockIds: chunk, changeSummary: explanation })
          })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error ?? `Unable to ${action} payout mappings.`);
        totals.unlocked += Number(payload.unlocked ?? (action === "unlock" ? chunk.length : 0));
        totals.relocked += Number(payload.relocked ?? (action === "relock" ? chunk.length : 0));
        totals.published += Number(payload.published ?? 0);
        completedChunks += 1;
      }
      setSelected(new Set());
      setMappingDialog(null);
      setMappingState({
        busy: false,
        error: "",
        notice: action === "unlock"
          ? `${totals.unlocked} Workforce mapping${totals.unlocked === 1 ? " is" : "s are"} unlocked for ${periodStart.slice(0, 7)}. Remap the IDs, then relock this month.`
          : `${totals.relocked} mapping unlock${totals.relocked === 1 ? " was" : "s were"} relocked; ${totals.published} revised payout${totals.published === 1 ? " is" : "s are"} now available in DropX One.`
      });
      router.refresh();
      requestAnimationFrame(() => mappingDialogTriggerRef.current?.focus());
    } catch (error) {
      if (completedChunks) {
        setSelected(new Set());
        setMappingDialog(null);
        router.refresh();
      }
      const message = error instanceof Error ? error.message : `Unable to ${action} payout mappings.`;
      setMappingState({
        busy: false,
        error: completedChunks ? `${completedChunks} mapping batch${completedChunks === 1 ? " was" : "es were"} completed before the next batch failed. The worksheet is refreshing. ${message}` : message,
        notice: ""
      });
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
        {selectedRows.length ? <span className="payout-result-count">{selectedRows.length.toLocaleString("en-IN")} selected</span> : null}
        {selectedRows.length && skippedReviewSelectionCount ? <span className="payout-result-count">{reviewSelectedRows.length} of {selectedRows.length} selected eligible for {audience === "workforce" ? "notification" : "review"}</span> : null}
        {canManageLocks && mappingUnlockWorkforceIds.length ? <button className="button secondary" disabled={actionBusy} onClick={(event) => openMappingLockDialog("unlock", event.currentTarget)} type="button">Unlock mapping ({mappingUnlockWorkforceIds.length} {mappingUnlockWorkforceIds.length === 1 ? "ID" : "IDs"})</button> : null}
        {canManageLocks && relockTargets.length ? <button className="button secondary" disabled={actionBusy} onClick={(event) => openMappingLockDialog("relock", event.currentTarget)} type="button">Relock &amp; republish {relockTargets.length}</button> : null}
        {canManuallyEdit ? <WorkforcePayoutManualEditor buttonLabel="Edit payout inputs" fromDate={periodStart} selectedRows={manualSelectedRows.map((row) => ({ id: row.id, dropxId: row.dropxId, name: row.name, location: row.location, locationId: row.locationId, status: row.status }))} toDate={periodEnd} /> : null}
        {canDeductAdvances ? <button aria-describedby={hasAdvanceSelectionConflict ? "advance-deduction-selection-help" : undefined} className="button secondary" disabled={!advanceSelectedRows.length || hasAdvanceSelectionConflict || actionBusy} onClick={deductPendingAdvances} title={hasAdvanceSelectionConflict ? "Advance deduction requires one location row per Workforce member. Send Notification requires every publishable location row for that ID." : undefined} type="button">{advanceState.busy ? "Deducting…" : `Deduct pending advances${advanceSelectedRows.length ? ` (${advanceSelectedRows.length})` : ""}`}</button> : null}
        {canEdit ? <button className="button" disabled={(audience === "workforce" && !canPublish) || !reviewSelectedRows.length || actionBusy} onClick={sendNotification} title={audience === "workforce" && !canPublishNotifications ? "Send Notification requires all-location access so every payout row for the DropX ID can be frozen together." : audience === "workforce" && !canPublishPeriod ? "Send Notification is available only for a complete monthly payout worksheet." : skippedReviewSelectionCount ? `${skippedReviewSelectionCount} selected payout${skippedReviewSelectionCount === 1 ? " is" : "s are"} available for manual editing but not eligible for ${audience === "workforce" ? "notification" : "review"}; only the eligible count will be submitted.` : undefined} type="button">{reviewState.busy ? audience === "workforce" ? "Queuing…" : "Sending…" : `${audience === "workforce" ? "Send Notification" : "Send for review"}${reviewSelectedRows.length ? ` (${reviewSelectedRows.length})` : ""}`}</button> : null}
        {canProcessPayments ? <WorkforcePayoutBankDialog banks={banks} disabled={actionBusy && !bankBusy} onBusyChange={setBankBusy} periodEnd={periodEnd} periodStart={periodStart} publicationRefreshCount={selectedBankRefreshPendingCount} totalAmount={bankTotalAmount} workforceIds={bankWorkforceIds} /> : null}
        <button className="button secondary" type="button" onClick={exportRows}>Export full CSV</button>
      </div>
    </div>
    {reviewState.error || reviewState.notice ? <div aria-live="polite" className={`payout-inline-message ${reviewState.error ? "error" : "success"}`}>{reviewState.error || reviewState.notice}</div> : null}
    {mappingState.error || mappingState.notice ? <div aria-live="polite" className={`payout-inline-message ${mappingState.error ? "error" : "success"}`}>{mappingState.error || mappingState.notice}</div> : null}
    {mappingUnlocks.length ? <div className="payout-inline-message" role="status"><strong>{mappingUnlocks.length} mapping {mappingUnlocks.length === 1 ? "correction is" : "corrections are"} open for this month.</strong> The last stable payout remains in DropX One as revising until you relock and republish. <span>{mappingUnlocks.slice(0, 5).map((entry) => entry.dropxId || entry.name).join(", ")}{mappingUnlocks.length > 5 ? ` and ${mappingUnlocks.length - 5} more` : ""}.</span></div> : null}
    {canEdit && audience === "workforce" && !canPublishNotifications ? <div className="payout-inline-message">Send Notification requires all-location access because every publishable location row for a DropX ID must be published and frozen together.</div> : null}
    {advanceState.error || advanceState.notice ? <div aria-live="polite" className={`payout-inline-message ${advanceState.error ? "error" : "success"}`}>{advanceState.error || advanceState.notice}</div> : null}
    {hasAdvanceSelectionConflict ? <div aria-live="polite" className="payout-inline-message error" id="advance-deduction-selection-help">Advance deduction requires one location row per Workforce member. Send Notification requires every publishable location row, so the extra row may be required for publication.</div> : null}
    {bankProfilesWithImplicitRows ? <div aria-live="polite" className="payout-inline-message warn"><strong>Bank payment is profile-wide.</strong> One bank-eligible checked row is enough to select the DropX ID, but the bank file uses its complete monthly balance across every published location row, including deductions. It creates one bank line per DropX ID, not one line per table row.</div> : null}
    {selectedBankRefreshPendingCount ? <div aria-live="polite" className="payout-inline-message warn"><strong>{selectedBankRefreshPendingCount} selected profile{selectedBankRefreshPendingCount === 1 ? " has" : "s have"} a publication refresh pending.</strong> The refresh runs before bank-file generation, then current balance and every payment eligibility rule are checked again. No stale publication will be paid.</div> : null}
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
          {showSelection ? <th className="payout-select-cell" scope="col"><input aria-label={`Select all matching ${subjectLabelLower} payouts for available actions`} checked={actionSelectionFull} disabled={!selectable.length || actionBusy} onChange={toggleAll} ref={selectAllRef} type="checkbox" /></th> : null}
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
            const paymentBalanceAvailable = row.paymentSummary
              ? isWorkforcePayoutPaymentBalanceAvailable(row.paymentSummary)
              : false;
            const paymentEligibilityLabel = row.paymentSummary
              ? workforcePayoutPaymentEligibilityLabel(row.paymentSummary)
              : null;
            const preliminaryBankBalance = preliminaryBankBalances.get(String(row.reviewSubjectId ?? "").trim()) ?? 0;
            const refreshBeforeBankFile = canProcessPayments
              && bankActionableIds.has(row.id)
              && publicationRefreshPending(row);
            const hasRowAdvanceSelectionConflict = Boolean(row.reviewSubjectId && advanceSelectionConflictIds.has(row.reviewSubjectId));
            const selectionTitle = hasRowAdvanceSelectionConflict
                ? "More than one selected location row belongs to this Workforce member. Keep one row only for advance deduction; Send Notification requires all publishable location rows."
                : refreshBeforeBankFile
                  ? "Available for bank-file action. The publication refreshes first, then current balance and payment eligibility are checked again."
                : !canSendPayoutForReview(row, audience) && canDeductAdvances && canDeductAdvanceFromPayout(row)
                  ? canManuallyEdit && canManuallyEditPayout(row)
                    ? "Available for advance deduction or manual payout input editing."
                    : "Available for advance deduction only."
                  : canManuallyEdit && !canSendPayoutForReview(row, audience) && canManuallyEditPayout(row)
                    ? "Available for manual payout input editing."
                  : undefined;
            const attendanceRanges = [...new Map(row.dailyBreakdown.flatMap((day) => day.attendanceRange ? [[
              `${day.attendanceRange.basis}|${day.attendanceRange.effectiveFrom}|${day.attendanceRange.effectiveTo}`,
              day.attendanceRange
            ] as const] : [])).values()];
            return [
              <tr key={row.id} className={row.mappingStatus === "ID not mapped" || row.mappingStatus === "Mapping conflict" ? "payout-id-unmapped" : row.panAadhaarStatus === "NOT LINKED" ? "payout-pan-aadhaar-unlinked" : undefined}>
                {showSelection ? <td className="payout-select-cell"><input aria-label={`Select ${row.dropxId || row.name} for payout actions`} checked={selected.has(row.id)} disabled={actionBusy || !selectableIds.has(row.id)} onChange={() => toggleSelected(row.id)} title={selectionTitle} type="checkbox" /></td> : null}
                <td className="payout-sticky-id">{row.dropxId ? <><strong>{row.dropxId}</strong><small className="payout-dropx-status" title={`DropX ID status: ${row.dropxStatus}`}>{row.dropxStatus}</small></> : <span className="sr-only">No DropX ID mapped</span>}</td>
                <td className="payout-sticky-worker"><strong>{row.name}</strong><small title={`${row.providerMemberName} · ${row.providerMemberId}`}>{row.providerMemberName} · {row.providerMemberId}</small></td>
                <td>{row.designation ? <strong>{row.designation}</strong> : <span aria-hidden="true">—</span>}</td>
                <td><strong>{row.location}</strong></td>
                <td><strong>{row.provider}</strong><small>{row.model}</small></td>
                <td>{row.paymentDetailsAvailable ? <strong>{row.paymentMethod}</strong> : <span className="sr-only">Payment method unavailable</span>}</td>
                <td className="work-days-cell">{row.paymentDetailsAvailable ? <><strong>{workDaysDisplay(row.workDays, row.workDaysSource)}</strong><small>{row.workDaysSource}</small></> : null}</td>
                <td className="payout-money">{row.paymentDetailsAvailable ? <strong>{money(row.grossPayment)}</strong> : null}</td>
                <td className="negative payout-money">{row.paymentDetailsAvailable ? row.deductions ? `- ${money(row.deductions)}` : "—" : null}</td>
                <td className="payout-money payout-net-pay">{row.paymentDetailsAvailable ? <><strong>{money(row.netAmount)}</strong>{row.paymentSummary ? <small className="payout-payment-balance" title={row.paymentSummary.eligibilityMessage ?? undefined}>{row.paymentSummary.processingAmount > 0 ? <span>Frozen profile net {exactMoney(row.paymentSummary.currentNetAmount)}</span> : null}<span>Paid {exactMoney(row.paymentSummary.paidAmount)}</span>{row.paymentSummary.processingAmount > 0 ? <span>Processing {exactMoney(row.paymentSummary.processingAmount)}</span> : null}{refreshBeforeBankFile ? <span>Preliminary balance {exactMoney(preliminaryBankBalance)}</span> : paymentBalanceAvailable ? <span>Balance payable {exactMoney(row.paymentSummary.balancePayable)}</span> : <span>Balance payable —</span>}{refreshBeforeBankFile ? <span>Refresh before bank file · eligibility rechecked</span> : paymentEligibilityLabel ? <span className="negative">{paymentEligibilityLabel}</span> : null}{row.paymentSummary.overpaidAmount > 0 ? <span className="negative">Overpaid {exactMoney(row.paymentSummary.overpaidAmount)}</span> : null}</small> : null}</> : null}</td>
                <td><div className="payout-status-stack">{reviewDays.length > 0 && <span className="status-pill warn">{reviewDays.length} low-delivery days</span>}<span className={`status-pill ${statusTone(row.status)}`}>{row.status}</span>{row.paymentDetailsAvailable && row.panAadhaarStatus ? <span className={`status-pill ${row.panAadhaarStatus === "LINKED" ? "good" : "warn"}`}>{row.panAadhaarStatus === "LINKED" ? "PAN linked" : "PAN not linked"}</span> : null}</div></td>
                <td><div className="payout-detail-actions">{row.paymentDetailsAvailable ? <button aria-controls={detailId} aria-expanded={expanded} className="button secondary compact" onClick={(event) => toggleBreakup(row.id, event.currentTarget)} type="button">{expanded ? "Close" : "Breakup"}</button> : <span className="sr-only">No payment breakup until mapping and payment setup are complete</span>}<PaymentAllocationHistoryButton entries={row.history} subjectLabel={`${row.dropxId || row.providerMemberId || row.name} · ${row.name}`} />{canProcessPayments && row.reviewSubjectId && row.paymentSummary ? <WorkforcePayoutPaymentHistoryButton canManageStatus={canProcessPayments} historyCount={row.paymentSummary.historyCount} periodEnd={periodEnd} periodStart={periodStart} subjectLabel={`${row.dropxId || row.name} · ${row.name}`} workforceId={row.reviewSubjectId} /> : null}</div></td>
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
    {mappingDialog ? <div className="modal-backdrop confirmation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeMappingLockDialog(); }} role="presentation">
      <section aria-describedby="mapping-lock-dialog-description" aria-labelledby="mapping-lock-dialog-title" aria-modal="true" className="modal-panel confirmation-dialog" ref={mappingDialogRef} role="alertdialog">
        <div className="panel-head">
          <div>
            <p className="eyebrow">Published payout mapping</p>
            <h2 id="mapping-lock-dialog-title">{mappingDialog.action === "unlock" ? "Unlock ID mapping" : "Relock and republish"}</h2>
          </div>
          <button aria-label="Close mapping lock dialog" className="button secondary compact" disabled={mappingState.busy} onClick={closeMappingLockDialog} type="button">Close</button>
        </div>
        <div className="panel-body">
          <p id="mapping-lock-dialog-description">{mappingDialog.action === "unlock"
            ? `Unlock ${mappingUnlockWorkforceIds.length} selected DropX ID${mappingUnlockWorkforceIds.length === 1 ? "" : "s"} only for ${periodStart.slice(0, 7)}. You can then correct the provider ID mapping. The current DropX One payout stays visible as revising until relock.`
            : `Recalculate and freeze the ${relockTargets.length} open mapping correction${relockTargets.length === 1 ? "" : "s"} for ${periodStart.slice(0, 7)}. This creates a silent payout revision in Dashboard and DropX One; it does not send another notification.`}</p>
          <div className="payout-inline-message">
            <strong>{mappingDialog.action === "unlock" ? "Selected IDs" : "Open corrections"}</strong>
            <p>{(mappingDialog.action === "unlock"
              ? mappingUnlockWorkforceIds.map((workforceId) => {
                const row = selectedRows.find((entry) => entry.reviewSubjectId === workforceId);
                return row?.dropxId || row?.name || workforceId;
              })
              : relockTargets.map((entry) => entry.dropxId || entry.name || entry.workforceId)
            ).slice(0, 8).join(", ")}{(mappingDialog.action === "unlock" ? mappingUnlockWorkforceIds.length : relockTargets.length) > 8 ? " and more" : ""}</p>
          </div>
          <label>
            <span>{mappingDialog.action === "unlock" ? "Reason for unlocking" : "What was corrected"}</span>
            <textarea
              aria-describedby="mapping-lock-explanation-help"
              className="field"
              disabled={mappingState.busy}
              maxLength={500}
              minLength={10}
              onChange={(event) => setMappingDialog((current) => current ? { ...current, explanation: event.target.value } : current)}
              placeholder={mappingDialog.action === "unlock" ? "Example: Provider ID was mapped to the wrong DropX ID." : "Example: Provider ID was reassigned to the correct DropX ID."}
              required
              rows={4}
              value={mappingDialog.explanation}
            />
          </label>
          <p className="subtle" id="mapping-lock-explanation-help">10–500 characters. This note is kept in the permanent payout audit history.</p>
          {mappingState.error ? <p className="payout-inline-message error" role="alert">{mappingState.error}</p> : null}
          <div className="form-actions">
            <button className="button secondary" disabled={mappingState.busy} onClick={closeMappingLockDialog} type="button">Cancel</button>
            <button className="button" disabled={mappingState.busy || mappingDialog.explanation.trim().length < 10} onClick={submitMappingLockChange} type="button">{mappingState.busy ? mappingDialog.action === "unlock" ? "Unlocking…" : "Relocking…" : mappingDialog.action === "unlock" ? "Unlock mapping" : "Relock & republish"}</button>
          </div>
        </div>
      </section>
    </div> : null}
    <div className="pagination payout-pagination">
      <label className="payout-page-size">Rows per page<select className="field" value={size} onChange={(event) => { setSize(event.target.value); setPage(1); }}>{["50","100","500","1000","all"].map((value) => <option value={value} key={value}>{value === "all" ? "All" : value}</option>)}</select></label>
      <span>Showing {filtered.length ? (safePage - 1) * pageSize + 1 : 0}–{Math.min(safePage * pageSize, filtered.length)} of {filtered.length}</span>
      <div><button className="button secondary compact" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} type="button">Previous</button><span>Page {safePage} of {pages}</span><button className="button secondary compact" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)} type="button">Next</button></div>
    </div>
  </>;
}
