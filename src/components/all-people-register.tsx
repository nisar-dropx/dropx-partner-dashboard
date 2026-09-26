"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download, EllipsisVertical, Eye, Pencil, Save, Search, ShieldCheck, X } from "lucide-react";
import { PendingLink } from "@/components/pending-link";
import { StatusPill } from "@/components/status-pill";
import { allPeopleExportColumns, type AllPeopleExportKey, type AllPeopleExportValues } from "@/lib/all-people-export";
import { saveAllPeopleSheetRow } from "@/app/people/all/actions";

export type AllPeopleRow = {
  id: string;
  category: string;
  categoryCode: string;
  code: string;
  biometricId: string;
  fullName: string;
  mobile: string;
  email: string;
  location: string;
  model: string;
  provider: string;
  designation: string;
  status: string;
  viewHref?: string;
  editHref?: string;
  canEdit: boolean;
  version?: string;
  locationId?: string;
  designationId?: string;
  editableKeys?: AllPeopleExportKey[];
  exportValues: AllPeopleExportValues;
  verificationNotes?: Partial<Record<AllPeopleExportKey, string>>;
};

type PageSize = 20 | 50 | 100 | 500 | "all";

type SheetVerificationKind = "pan" | "pan_aadhaar" | "dl" | "vehicle" | "bank" | "pf_uan";
type SheetVerificationResult = {
  kind: SheetVerificationKind;
  inputKey?: string;
  verified?: boolean;
  manualReview?: boolean;
  blockSubmit?: boolean;
  name?: string;
  accountName?: string;
  ownerName?: string;
  fuelType?: string;
  message?: string;
  warning?: string;
  expiryDate?: string;
  registrationExpiryDate?: string;
  insuranceExpiryDate?: string;
  pollutionExpiryDate?: string;
};

const pageSizeOptions: Array<{ value: PageSize; label: string }> = [
  { value: 20, label: "20" },
  { value: 50, label: "50" },
  { value: 100, label: "100" },
  { value: 500, label: "500" },
  { value: "all", label: "All" }
];

const yesNoOptions = [
  { value: "Yes", label: "Yes" },
  { value: "No", label: "No" }
];

const genderOptions = [
  { value: "Male", label: "Male" },
  { value: "Female", label: "Female" },
  { value: "Other", label: "Other" }
];

const bloodGroupOptions = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]
  .map((value) => ({ value, label: value }));

const stateCodeOptions = [
  "AP", "AR", "AS", "BR", "CG", "GA", "GJ", "HR", "HP", "JH", "KA", "KL", "MP", "MH", "MN", "ML", "MZ", "NL", "OD", "PB", "RJ", "SK", "TN", "TS", "TR", "UP", "UK", "WB", "AN", "CH", "DN", "DL", "JK", "LA", "LD", "PY"
].map((value) => ({ value, label: value }));

const statutoryOptions = [
  { value: "not_applicable", label: "Not applicable" },
  { value: "pf", label: "PF" },
  { value: "esi", label: "ESI" }
];

const dateFieldKeys = new Set<AllPeopleExportKey>([
  "dateOfJoin", "dateOfBirth", "drivingLicenseExpiry", "vehicleRegistrationExpiry", "vehicleInsuranceExpiry", "pollutionExpiry"
]);

const fileFieldKeys = new Set<AllPeopleExportKey>([
  "aadhaarFrontFile", "aadhaarBackFile", "panFile", "drivingLicenseFrontFile", "drivingLicenseBackFile", "profilePhotoFile"
]);

const verificationFields: Record<Exclude<SheetVerificationKind, "pan_aadhaar">, AllPeopleExportKey[]> = {
  pan: ["fullName", "panNumber", "aadhaarNumber"],
  bank: ["bankAccountNumber", "ifsc"],
  dl: ["fullName", "drivingLicenseNumber", "dateOfBirth"],
  vehicle: ["vehicleRegistrationNumber"],
  pf_uan: ["fullName", "pfUan"]
};

const verificationAnchorByField: Partial<Record<AllPeopleExportKey, Exclude<SheetVerificationKind, "pan_aadhaar">>> = {
  panNumber: "pan",
  ifsc: "bank",
  drivingLicenseNumber: "dl",
  vehicleRegistrationNumber: "vehicle",
  pfUan: "pf_uan"
};

const verificationKindsByField: Partial<Record<AllPeopleExportKey, Array<Exclude<SheetVerificationKind, "pan_aadhaar">>>> = {
  fullName: ["pan", "dl", "pf_uan"],
  panNumber: ["pan"],
  aadhaarNumber: ["pan"],
  bankAccountNumber: ["bank"],
  ifsc: ["bank"],
  drivingLicenseNumber: ["dl"],
  dateOfBirth: ["dl"],
  vehicleRegistrationNumber: ["vehicle"],
  pfUan: ["pf_uan"]
};

const sheetLeadingKeys: AllPeopleExportKey[] = ["dropxId", "fullName", "biometricId"];
const sheetColumns = [
  ...sheetLeadingKeys.map((key) => allPeopleExportColumns.find((column) => column.key === key)!),
  ...allPeopleExportColumns.filter((column) => !sheetLeadingKeys.includes(column.key))
];

const editableKeys = new Set<AllPeopleExportKey>([
  "fullName", "mobileCountryCode", "mobileNumber", "email", "dateOfJoin", "location", "designation",
  "active", "statutoryApplicability", "gender", "dateOfBirth", "aadhaarNumber", "panNumber",
  "eshramUan", "fatherName", "bloodGroup", "handicapped", "address", "stateCode", "pincode", "landmark",
  "bankAccountNumber", "ifsc", "pfUan", "pfAccountNumber", "esiNumber", "emergencyContactNumber",
  "emergencyContactName", "emergencyContactRelation", "drivingLicenseNumber", "drivingLicenseExpiry",
  "vehicleRegistrationNumber", "vehicleRegistrationExpiry", "vehicleInsuranceExpiry", "pollutionExpiry",
  "returnRemarks"
]);

const workforceEditableKeys = new Set<AllPeopleExportKey>([
  "fullName", "mobileCountryCode", "mobileNumber", "email", "dateOfJoin", "location", "designation",
  "active", "bankAccountNumber", "ifsc", "returnRemarks"
]);

type FilterOption = { value: string; label: string; categoryCodes?: string[] };
type SheetEditOptions = Partial<Record<"location" | "designation" | "status" | "active", FilterOption[]>>;

function MultiCheckFilter({
  allLabel,
  label,
  onChange,
  options,
  selected
}: {
  allLabel: string;
  label: string;
  onChange: (values: string[]) => void;
  options: FilterOption[];
  selected: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filteredOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    return options.filter((option) => !term || option.label.toLowerCase().includes(term));
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  function toggle(value: string) {
    onChange(selectedSet.has(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  return (
    <div className="bulk-multi-filter all-people-filter" ref={rootRef}>
      <button className={`bulk-multi-filter-trigger ${open ? "open" : ""}`} onClick={() => setOpen((current) => !current)} type="button">
        <strong>{selected.length ? `${label}: ${selected.length}` : allLabel}</strong>
        <span>v</span>
      </button>
      {open ? (
        <div className="bulk-multi-filter-menu">
          <div className="bulk-multi-filter-search">
            <input className="field" onChange={(event) => setQuery(event.target.value)} placeholder={`Search ${label.toLowerCase()}`} value={query} />
          </div>
          <div className="bulk-multi-filter-options">
            <label className="bulk-multi-filter-option all">
              <input checked={!selected.length} onChange={() => onChange([])} type="checkbox" />
              <span>All</span>
            </label>
            {filteredOptions.map((option) => (
              <label className="bulk-multi-filter-option" key={option.value}>
                <input checked={selectedSet.has(option.value)} onChange={() => toggle(option.value)} type="checkbox" />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function optionsFrom(values: string[]) {
  return Array.from(new Set(values.filter((value) => value && value !== "-")))
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({ value, label: value }));
}

function toDateInputValue(value: string) {
  const raw = value.trim();
  const display = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return display ? `${display[3]}-${display[2]}-${display[1]}` : raw;
}

function toDisplayDateValue(value?: string) {
  const raw = String(value ?? "").trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const display = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  return display ? `${display[1].padStart(2, "0")}/${display[2].padStart(2, "0")}/${display[3]}` : raw;
}

function parseStatutoryValue(value: string) {
  return Array.from(new Set(value.split(/[,;|]/).map((item) => item.trim().toLowerCase().replace(/[ -]+/g, "_")).filter(Boolean)));
}

function sheetDocumentHref(row: AllPeopleRow, field: AllPeopleExportKey) {
  const params = new URLSearchParams({ category: row.categoryCode, id: row.id, field });
  return `/api/people/all-profile-file?${params.toString()}#toolbar=0&navpanes=0`;
}

function verificationConfig(categoryCode: string) {
  const configs: Record<string, { pageCode: string; profileType: string }> = {
    employees: { pageCode: "employees", profileType: "employee" },
    contractors: { pageCode: "contractors", profileType: "contractor" },
    vendors: { pageCode: "vendors", profileType: "vendor" },
    workers: { pageCode: "workers", profileType: "worker" },
    workforce: { pageCode: "delivery_associates", profileType: "field_executive" }
  };
  return configs[categoryCode] ?? null;
}

function verificationResultMessage(result?: SheetVerificationResult) {
  if (!result) return "";
  const status = result.verified ? "Verified" : result.manualReview ? "Manual review" : "Failed";
  const details = [
    result.name ? `${result.kind === "pf_uan" ? "PF UAN" : result.kind === "dl" ? "DL" : "PAN"} name: ${result.name}` : "",
    result.accountName ? `Bank name: ${result.accountName}` : "",
    result.ownerName ? `RC owner: ${result.ownerName}` : "",
    result.fuelType ? `Fuel type: ${result.fuelType}` : "",
    result.warning || result.message || ""
  ].filter(Boolean);
  const uniqueDetails = [...new Set(details)];
  return uniqueDetails.length ? `${status}: ${uniqueDetails.join(" · ")}` : status;
}

function SheetStatutorySelect({ disabled, label, onChange, value }: {
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selected = parseStatutoryValue(value);
  const selectedSet = new Set(selected);

  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  function toggle(nextValue: string) {
    if (nextValue === "not_applicable") {
      onChange("not_applicable");
      return;
    }
    const withoutNotApplicable = selected.filter((item) => item !== "not_applicable");
    const next = selectedSet.has(nextValue)
      ? withoutNotApplicable.filter((item) => item !== nextValue)
      : [...withoutNotApplicable, nextValue];
    onChange(next.length ? next.join(", ") : "not_applicable");
  }

  return (
    <div className="sheet-statutory-select" ref={rootRef}>
      <button aria-expanded={open} aria-label={label} className="sheet-statutory-trigger" disabled={disabled} onClick={() => setOpen((current) => !current)} type="button">
        <span className="sheet-statutory-tags">
          {selected.length ? selected.map((item) => <span className="sheet-statutory-tag" key={item}>{statutoryOptions.find((option) => option.value === item)?.label ?? item}</span>) : <span className="sheet-statutory-placeholder">Select…</span>}
        </span>
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="sheet-statutory-menu">
          {statutoryOptions.map((option) => (
            <label key={option.value}>
              <input checked={selectedSet.has(option.value)} onChange={() => toggle(option.value)} type="checkbox" />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SheetVerificationControl({
  disabled,
  kind,
  onDerivedValue,
  onResults,
  results,
  row,
  values
}: {
  disabled: boolean;
  kind: Exclude<SheetVerificationKind, "pan_aadhaar">;
  onDerivedValue: (key: AllPeopleExportKey, value: string) => void;
  onResults: (results: SheetVerificationResult[]) => void;
  results: Partial<Record<SheetVerificationKind, SheetVerificationResult>>;
  row: AllPeopleRow;
  values: AllPeopleExportValues;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const config = verificationConfig(row.categoryCode);

  const payload = {
    accountId: row.id,
    profileType: config?.profileType,
    pageCode: config?.pageCode,
    fullName: values.fullName,
    panNumber: values.panNumber,
    aadhaarNumber: values.aadhaarNumber,
    dateOfBirth: values.dateOfBirth,
    drivingLicenseNo: values.drivingLicenseNumber,
    vehicleRegNo: values.vehicleRegistrationNumber,
    bankAccountNo: values.bankAccountNumber,
    ifsc: values.ifsc,
    pfUan: values.pfUan
  };
  const missing = kind === "pan" && (!payload.panNumber || !payload.aadhaarNumber)
    ? "PAN and Aadhaar are required."
    : kind === "dl" && (!payload.drivingLicenseNo || !payload.dateOfBirth)
      ? "DL number and date of birth are required."
      : kind === "vehicle" && !payload.vehicleRegNo
        ? "Vehicle number is required."
        : kind === "bank" && (!payload.bankAccountNo || !payload.ifsc)
          ? "Bank account and IFSC are required."
          : kind === "pf_uan" && !payload.pfUan
            ? "PF UAN is required."
            : "";

  async function request(target: SheetVerificationKind) {
    const response = await fetch("/api/profile-verification", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, kind: target })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Unable to verify.");
    return { ...body, kind: target } as SheetVerificationResult;
  }

  async function verify() {
    if (!config || missing) return;
    setRunning(true);
    setError("");
    try {
      const result = await request(kind);
      const next = [result];
      if (kind === "pan" && !result.blockSubmit) next.push(await request("pan_aadhaar"));
      if (kind === "dl" && result.expiryDate) onDerivedValue("drivingLicenseExpiry", toDisplayDateValue(result.expiryDate));
      if (kind === "vehicle") {
        if (result.registrationExpiryDate) onDerivedValue("vehicleRegistrationExpiry", toDisplayDateValue(result.registrationExpiryDate));
        if (result.insuranceExpiryDate) onDerivedValue("vehicleInsuranceExpiry", toDisplayDateValue(result.insuranceExpiryDate));
        const electric = /electric|\bev\b/i.test(result.fuelType ?? "");
        onDerivedValue("pollutionExpiry", electric ? "" : toDisplayDateValue(result.pollutionExpiryDate));
      }
      onResults(next);
    } catch (exception) {
      setError(exception instanceof Error ? exception.message : "Unable to verify.");
    } finally {
      setRunning(false);
    }
  }

  if (!config) return <small className="sheet-verification-note">Verification is unavailable for this custom category.</small>;
  return (
    <div className="sheet-verification-control">
      <button className="sheet-verify-button" disabled={disabled || running || Boolean(missing)} onClick={verify} type="button">
        <ShieldCheck aria-hidden="true" size={14} /> {running ? "Verifying…" : results[kind] ? "Verify again" : "Verify"}
      </button>
      {missing ? <small className="sheet-verification-note">{missing}</small> : null}
      {error ? <small className="sheet-save-error">{error}</small> : null}
    </div>
  );
}

function AllPeopleActionMenu({ row }: { row: AllPeopleRow }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const tableWrap = menuRef.current?.closest(".employee-table-wrap");
    tableWrap?.classList.add("menu-open");
    function closeMenu(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      tableWrap?.classList.remove("menu-open");
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (!row.viewHref) return null;

  return (
    <div className="row-action-menu" ref={menuRef}>
      <button aria-expanded={open} aria-haspopup="menu" aria-label={`Actions for ${row.fullName}`} className="icon-button" onClick={() => setOpen((current) => !current)} type="button">
        <EllipsisVertical aria-hidden="true" size={17} />
      </button>
      {open ? (
        <div className="row-action-popover">
          <PendingLink className="row-action-item" href={row.viewHref}>
            <Eye aria-hidden="true" size={15} /> View
          </PendingLink>
          {row.canEdit && row.editHref ? (
            <PendingLink className="row-action-item" href={row.editHref}>
              <Pencil aria-hidden="true" size={15} /> Edit
            </PendingLink>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function AllPeopleRegister({ rows, editOptions = {} }: { rows: AllPeopleRow[]; editOptions?: SheetEditOptions }) {
  const searchParams = useSearchParams();
  const editableSheet = searchParams.get("layout") === "edit-sheet";
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const stickyScrollRef = useRef<HTMLDivElement | null>(null);
  const [search, setSearch] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>([]);
  const [designations, setDesignations] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [sheetEditMode, setSheetEditMode] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportColumnSearch, setExportColumnSearch] = useState("");
  const [selectedExportColumns, setSelectedExportColumns] = useState<AllPeopleExportKey[]>(() => allPeopleExportColumns.map((column) => column.key));
  const [drafts, setDrafts] = useState<Record<string, Partial<AllPeopleExportValues>>>({});
  const [savedValues, setSavedValues] = useState<Record<string, Partial<AllPeopleExportValues>>>({});
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(() => new Set());
  const [savingAll, setSavingAll] = useState(false);
  const [saveMessage, setSaveMessage] = useState<Record<string, string>>({});
  const [sheetVerificationResults, setSheetVerificationResults] = useState<Record<string, Partial<Record<SheetVerificationKind, SheetVerificationResult>>>>({});
  const [verificationNoteOverrides, setVerificationNoteOverrides] = useState<Record<string, Partial<Record<AllPeopleExportKey, string>>>>({});
  const [documentPreview, setDocumentPreview] = useState<{ href: string; label: string } | null>(null);
  const [sheetScrollWidth, setSheetScrollWidth] = useState(0);
  const [stickyScrollFrame, setStickyScrollFrame] = useState({ left: 0, width: 0, visible: false });

  const categoryOptions = useMemo(() => (
    Array.from(new Map(rows.map((row) => [row.categoryCode, row.category])).entries())
      .sort((left, right) => left[1].localeCompare(right[1]))
      .map(([value, label]) => ({ value, label }))
  ), [rows]);
  const locationOptions = useMemo(() => editOptions.location ?? optionsFrom(rows.map((row) => row.location)), [editOptions.location, rows]);
  const designationOptions = useMemo<FilterOption[]>(() => editOptions.designation ?? optionsFrom(rows.map((row) => row.designation)), [editOptions.designation, rows]);
  const statusOptions = useMemo(() => editOptions.status ?? optionsFrom(rows.map((row) => row.status)), [editOptions.status, rows]);
  const activeOptions = useMemo(() => editOptions.active ?? yesNoOptions, [editOptions.active]);

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (categories.length && !categories.includes(row.categoryCode)) return false;
      if (locations.length && !locations.includes(row.location)) return false;
      if (designations.length && !designations.includes(row.designation)) return false;
      if (statuses.length && !statuses.includes(row.status)) return false;
      return !term || `${row.code} ${row.biometricId} ${row.fullName} ${row.mobile} ${row.email} ${row.location} ${row.model} ${row.provider} ${row.designation} ${row.category}`.toLowerCase().includes(term);
    });
  }, [categories, designations, locations, rows, search, statuses]);
  const totalPages = pageSize === "all" ? 1 : Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleRows = pageSize === "all"
    ? filteredRows
    : filteredRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const firstVisibleRecord = filteredRows.length && pageSize !== "all" ? ((currentPage - 1) * pageSize) + 1 : filteredRows.length ? 1 : 0;
  const lastVisibleRecord = pageSize === "all" ? filteredRows.length : Math.min(currentPage * pageSize, filteredRows.length);

  useEffect(() => setPage(1), [categories, designations, locations, pageSize, search, statuses]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  useEffect(() => {
    if (!editableSheet) setSheetEditMode(false);
  }, [editableSheet]);
  useEffect(() => {
    if (!documentPreview) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setDocumentPreview(null);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [documentPreview]);
  useEffect(() => {
    if (!editableSheet) return;
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
      setSheetScrollWidth(tableWrapElement.scrollWidth);
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
  }, [editableSheet, visibleRows.length]);

  const selectedExportSet = useMemo(() => new Set(selectedExportColumns), [selectedExportColumns]);
  const visibleExportColumns = useMemo(() => {
    const term = exportColumnSearch.trim().toLowerCase();
    return allPeopleExportColumns.filter((column) => !term || column.label.toLowerCase().includes(term));
  }, [exportColumnSearch]);

  function toggleExportColumn(key: AllPeopleExportKey) {
    setSelectedExportColumns((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }

  function rowKey(row: AllPeopleRow) { return `${row.categoryCode}:${row.id}`; }
  function baseValuesFor(row: AllPeopleRow): AllPeopleExportValues {
    return { ...row.exportValues, ...(savedValues[rowKey(row)] ?? {}) };
  }
  function valuesFor(row: AllPeopleRow): AllPeopleExportValues {
    return { ...baseValuesFor(row), ...(drafts[rowKey(row)] ?? {}) };
  }
  function canEditField(row: AllPeopleRow, key: AllPeopleExportKey) {
    if (!row.canEdit || !row.version) return false;
    if (row.editableKeys) return row.editableKeys.includes(key);
    return row.categoryCode === "workforce" ? workforceEditableKeys.has(key) : editableKeys.has(key);
  }
  function changeValue(row: AllPeopleRow, key: AllPeopleExportKey, value: string) {
    const keyValue = rowKey(row);
    const baseValue = baseValuesFor(row)[key] ?? "";
    setDrafts((current) => {
      const next = { ...current };
      const patch = { ...(next[keyValue] ?? {}) };
      if (value === baseValue) delete patch[key];
      else patch[key] = value;
      if (Object.keys(patch).length) next[keyValue] = patch;
      else delete next[keyValue];
      return next;
    });
    setSaveMessage((current) => ({ ...current, [keyValue]: "" }));
    const verificationKinds = verificationKindsByField[key] ?? [];
    if (verificationKinds.length) {
      setSheetVerificationResults((current) => {
        const next = { ...current };
        const rowResults = { ...(next[keyValue] ?? {}) };
        for (const verificationKind of verificationKinds) {
          delete rowResults[verificationKind];
          if (verificationKind === "pan") delete rowResults.pan_aadhaar;
        }
        if (Object.keys(rowResults).length) next[keyValue] = rowResults;
        else delete next[keyValue];
        return next;
      });
    }
  }

  function setRowVerificationResults(row: AllPeopleRow, nextResults: SheetVerificationResult[]) {
    const keyValue = rowKey(row);
    setSheetVerificationResults((current) => {
      const rowResults = { ...(current[keyValue] ?? {}) };
      for (const result of nextResults) rowResults[result.kind] = result;
      return { ...current, [keyValue]: rowResults };
    });
  }

  function verificationKindsForPatch(patch: Partial<AllPeopleExportValues>) {
    return Array.from(new Set((Object.keys(patch) as AllPeopleExportKey[])
      .flatMap((key) => verificationKindsByField[key] ?? [])
      .filter((kind): kind is Exclude<SheetVerificationKind, "pan_aadhaar"> => Boolean(kind))));
  }

  function updateVerificationNotesAfterSave(row: AllPeopleRow, patch: Partial<AllPeopleExportValues>) {
    const keyValue = rowKey(row);
    const results = sheetVerificationResults[keyValue] ?? {};
    const kinds = verificationKindsForPatch(patch);
    if (!kinds.length) return;
    setVerificationNoteOverrides((current) => {
      const rowNotes = { ...(current[keyValue] ?? {}) };
      for (const kind of kinds) {
        const result = results[kind];
        const panAadhaar = kind === "pan" ? results.pan_aadhaar : undefined;
        const messages = [verificationResultMessage(result), verificationResultMessage(panAadhaar)].filter(Boolean);
        const message = messages.length ? messages.join(" · ") : "Needs review: Reverification required after profile field update.";
        const anchor = Object.entries(verificationAnchorByField).find(([, candidate]) => candidate === kind)?.[0] as AllPeopleExportKey | undefined;
        if (anchor) rowNotes[anchor] = message;
      }
      return { ...current, [keyValue]: rowNotes };
    });
  }

  async function persistRow(row: AllPeopleRow, patch: Partial<AllPeopleExportValues>) {
    const keyValue = rowKey(row);
    setSaveMessage((current) => ({ ...current, [keyValue]: "" }));
    const expectedUpdatedAt = versions[keyValue] ?? row.version;
    if (!expectedUpdatedAt) {
      setSaveMessage((current) => ({ ...current, [keyValue]: "This row cannot be safely updated. Refresh the page and try again." }));
      return false;
    }
    const result = await saveAllPeopleSheetRow({
      categoryCode: row.categoryCode,
      id: row.id,
      changes: patch,
      expectedUpdatedAt
    });
    setSaveMessage((current) => ({
      ...current,
      [keyValue]: result.ok ? result.warning ?? "Saved" : result.error ?? "Unable to save."
    }));
    if (!result.ok) return false;

    const savedPatch = "savedValues" in result ? result.savedValues : patch;
    setSavedValues((current) => ({ ...current, [keyValue]: { ...(current[keyValue] ?? {}), ...savedPatch } }));
    updateVerificationNotesAfterSave(row, patch);
    const updatedAt = "updatedAt" in result && typeof result.updatedAt === "string" ? result.updatedAt : undefined;
    if (updatedAt) setVersions((current) => ({ ...current, [keyValue]: updatedAt }));
    setDrafts((current) => {
      const remainingPatch = { ...(current[keyValue] ?? {}) };
      for (const [key, value] of Object.entries(patch) as Array<[AllPeopleExportKey, string]>) {
        if (remainingPatch[key] === value) delete remainingPatch[key];
      }
      const next = { ...current };
      if (Object.keys(remainingPatch).length) next[keyValue] = remainingPatch;
      else delete next[keyValue];
      return next;
    });
    return true;
  }

  async function saveRow(row: AllPeopleRow) {
    const keyValue = rowKey(row);
    const patch = drafts[keyValue];
    if (!patch || !Object.keys(patch).length) return;
    setSavingIds((current) => new Set(current).add(keyValue));
    try {
      await persistRow(row, patch);
    } finally {
      setSavingIds((current) => { const next = new Set(current); next.delete(keyValue); return next; });
    }
  }

  const rowByKey = new Map(rows.map((row) => [rowKey(row), row]));
  const dirtyRows = Object.entries(drafts)
    .filter(([, patch]) => Object.keys(patch).length)
    .flatMap(([key, patch]) => rowByKey.has(key) ? [{ key, row: rowByKey.get(key)!, patch }] : []);

  async function saveAllRows() {
    if (!dirtyRows.length || savingAll) return;
    const targets = dirtyRows.map((entry) => ({ ...entry, patch: { ...entry.patch } }));
    setSavingAll(true);
    setSavingIds((current) => new Set([...current, ...targets.map((entry) => entry.key)]));
    try {
      for (const target of targets) await persistRow(target.row, target.patch);
    } finally {
      setSavingIds((current) => {
        const next = new Set(current);
        for (const target of targets) next.delete(target.key);
        return next;
      });
      setSavingAll(false);
    }
  }

  function toggleSheetEditMode() {
    if (!sheetEditMode) {
      setSheetEditMode(true);
      return;
    }
    if (dirtyRows.length && !window.confirm(`Discard unsaved changes in ${dirtyRows.length} row${dirtyRows.length === 1 ? "" : "s"}?`)) return;
    if (dirtyRows.length) {
      setDrafts({});
      setSheetVerificationResults({});
    }
    setSheetEditMode(false);
  }

  const sheetRows = visibleRows;

  async function exportPeople() {
    if (!selectedExportColumns.length || !filteredRows.length) return;
    setExporting(true);
    try {
      const XLSX = await import("xlsx");
      const columns = allPeopleExportColumns.filter((column) => selectedExportSet.has(column.key));
      const data = [
        columns.map((column) => column.label),
        ...filteredRows.map((row) => columns.map((column) => row.exportValues[column.key] ?? ""))
      ];
      const worksheet = XLSX.utils.aoa_to_sheet(data);

      // Excel must receive identifiers as text or it removes leading zeroes and rounds values over 15 digits.
      for (let rowIndex = 1; rowIndex < data.length; rowIndex += 1) {
        for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
          const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
          const cell = worksheet[address];
          if (cell) {
            cell.t = "s";
            cell.v = String(data[rowIndex][columnIndex] ?? "");
            cell.z = "@";
          }
        }
      }
      worksheet["!cols"] = columns.map((column) => ({ wch: Math.min(42, Math.max(14, column.label.length + 3)) }));
      worksheet["!autofilter"] = { ref: worksheet["!ref"] ?? "A1:A1" };
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "All People");
      const date = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(workbook, `all-people-${date}.xlsx`, { compression: true });
      setExportOpen(false);
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-head toolbar">
        <div>
          <h2>{editableSheet ? "People sheet" : "People register"}</h2>
          <p className="subtle">
            {filteredRows.length} of {rows.length} records
            {editableSheet ? ` · ${sheetEditMode ? `${dirtyRows.length} unsaved row${dirtyRows.length === 1 ? "" : "s"}` : "View only"}` : ""}
          </p>
        </div>
        <div className="all-people-filters">
          <input className="field all-people-search" onChange={(event) => setSearch(event.target.value)} placeholder="Search ID, name, mobile, email" value={search} />
          <MultiCheckFilter allLabel="All categories" label="Category" onChange={setCategories} options={categoryOptions} selected={categories} />
          <MultiCheckFilter allLabel="All locations" label="Location" onChange={setLocations} options={locationOptions} selected={locations} />
          <MultiCheckFilter allLabel="All designations" label="Designation" onChange={setDesignations} options={designationOptions} selected={designations} />
          <MultiCheckFilter allLabel="All statuses" label="Status" onChange={setStatuses} options={statusOptions} selected={statuses} />
          {editableSheet ? (
            <>
              <button className={sheetEditMode ? "button secondary" : "button"} disabled={savingAll} onClick={toggleSheetEditMode} type="button">
                {sheetEditMode ? <X aria-hidden="true" size={16} /> : <Pencil aria-hidden="true" size={16} />}
                {sheetEditMode ? "Cancel editing" : "Edit"}
              </button>
              {sheetEditMode ? (
                <button className="button" disabled={!dirtyRows.length || savingAll || savingIds.size > 0} onClick={saveAllRows} type="button">
                  <Save aria-hidden="true" size={16} /> {savingAll ? "Saving all…" : `Save all${dirtyRows.length ? ` (${dirtyRows.length})` : ""}`}
                </button>
              ) : null}
            </>
          ) : null}
          <button className="button secondary all-people-export-trigger" disabled={!filteredRows.length} onClick={() => {
            setExportColumnSearch("");
            setExportOpen(true);
          }} type="button">
            <Download aria-hidden="true" size={16} /> Export
          </button>
          <PendingLink className="button secondary" href={editableSheet ? "/people/all" : "/people/all?layout=edit-sheet"}>{editableSheet ? "Register view" : "Editable sheet"}</PendingLink>
        </div>
      </div>
      <div className="table-wrap field-executive-table-wrap employee-table-wrap all-people-table-wrap" ref={tableWrapRef}>
        {editableSheet ? <table className="all-people-edit-sheet">
          <thead><tr>{sheetColumns.map((column) => <th className={`sheet-column-${column.key}`} key={column.key}>{column.label}</th>)}<th className="sheet-row-actions">Save</th></tr></thead>
          <tbody>
            {sheetRows.map((row) => {
              const rowId = rowKey(row);
              const values = valuesFor(row);
              const rowPatch = drafts[rowId] ?? {};
              const rowDirty = Object.keys(rowPatch).length > 0;
              const rowSaving = savingIds.has(rowId);
              return (
                <tr className={rowDirty ? "sheet-row-dirty" : undefined} key={rowId}>
                  {sheetColumns.map((column) => {
                    const editable = canEditField(row, column.key);
                    const cellDirty = Object.prototype.hasOwnProperty.call(rowPatch, column.key);
                    const fieldOptions = column.key === "location"
                      ? locationOptions
                      : column.key === "designation"
                        ? designationOptions.filter((option) => option.categoryCodes === undefined || option.categoryCodes.includes(row.categoryCode))
                        : column.key === "active" || column.key === "handicapped"
                          ? activeOptions
                          : column.key === "gender"
                            ? genderOptions
                            : column.key === "bloodGroup"
                              ? bloodGroupOptions
                              : column.key === "stateCode"
                                ? stateCodeOptions
                          : undefined;
                    const cellValue = values[column.key] ?? "";
                    const linkedField = column.key === "model" || column.key === "provider";
                    const fileField = fileFieldKeys.has(column.key);
                    const dateField = dateFieldKeys.has(column.key);
                    const verificationKind = verificationAnchorByField[column.key];
                    const groupDirty = verificationKind
                      ? verificationFields[verificationKind].some((key) => Object.prototype.hasOwnProperty.call(rowPatch, key))
                      : false;
                    const rowVerificationResults = sheetVerificationResults[rowId] ?? {};
                    const note = groupDirty
                      ? [verificationResultMessage(verificationKind ? rowVerificationResults[verificationKind] : undefined), verificationKind === "pan" ? verificationResultMessage(rowVerificationResults.pan_aadhaar) : ""].filter(Boolean).join(" · ") || "Reverification required after this edit."
                      : verificationNoteOverrides[rowId]?.[column.key] ?? row.verificationNotes?.[column.key];
                    return (
                      <td className={`${cellDirty ? "sheet-cell-dirty" : ""} ${!editable ? "sheet-cell-readonly" : ""} sheet-column-${column.key}`.trim()} key={column.key} title={linkedField ? "Linked to location and updated automatically" : !editable && !fileField ? "Read-only field" : undefined}>
                        {fileField ? (
                          cellValue ? (
                            <button
                              aria-label={`View ${column.label} for ${row.fullName}`}
                              className="icon-button sheet-file-view"
                              onClick={() => setDocumentPreview({ href: sheetDocumentHref(row, column.key), label: `${column.label} · ${row.fullName}` })}
                              title={`View ${column.label}`}
                              type="button"
                            >
                              <Eye aria-hidden="true" size={17} />
                            </button>
                          ) : <span className="sheet-cell-value">-</span>
                        ) : sheetEditMode && editable ? (
                          column.key === "statutoryApplicability" ? (
                            <SheetStatutorySelect
                              disabled={rowSaving}
                              label={`${column.label} for ${row.fullName}`}
                              onChange={(value) => changeValue(row, column.key, value)}
                              value={cellValue}
                            />
                          ) : fieldOptions ? (
                            <select
                              aria-label={`${column.label} for ${row.fullName}`}
                              className="sheet-cell-input sheet-cell-select"
                              disabled={rowSaving}
                              onChange={(event) => changeValue(row, column.key, event.target.value)}
                              value={cellValue}
                            >
                              <option value="">Select…</option>
                              {cellValue && !fieldOptions.some((option) => option.value === cellValue) ? <option value={cellValue}>{cellValue}</option> : null}
                              {fieldOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </select>
                          ) : (
                            <input
                              aria-label={`${column.label} for ${row.fullName}`}
                              className="sheet-cell-input"
                              disabled={rowSaving}
                              onChange={(event) => changeValue(row, column.key, dateField ? toDisplayDateValue(event.target.value) : event.target.value)}
                              type={dateField ? "date" : "text"}
                              value={dateField ? toDateInputValue(cellValue) : cellValue}
                            />
                          )
                        ) : <span className="sheet-cell-value">{cellValue || "-"}</span>}
                        {note ? <small className="sheet-verification-note">{note}</small> : null}
                        {sheetEditMode && verificationKind && groupDirty ? (
                          <SheetVerificationControl
                            disabled={rowSaving || savingAll}
                            kind={verificationKind}
                            onDerivedValue={(key, value) => changeValue(row, key, value)}
                            onResults={(results) => setRowVerificationResults(row, results)}
                            results={rowVerificationResults}
                            row={row}
                            values={values}
                          />
                        ) : null}
                      </td>
                    );
                  })}
                  <td className="sheet-row-actions">
                    {sheetEditMode ? (
                      <button className="button sheet-save-button" disabled={!row.canEdit || !rowDirty || rowSaving || savingAll} onClick={() => saveRow(row)} type="button">
                        {rowSaving ? "Saving…" : "Save"}
                      </button>
                    ) : <span className="sheet-view-only-label">View only</span>}
                    {saveMessage[rowId] ? (
                      <small className={saveMessage[rowId] === "Saved" ? "sheet-save-ok" : saveMessage[rowId].startsWith("Profile saved") ? "sheet-save-warning" : "sheet-save-error"}>
                        {saveMessage[rowId]}
                      </small>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {!sheetRows.length ? <tr><td className="empty-cell" colSpan={sheetColumns.length + 1}>No people match the selected filters.</td></tr> : null}
          </tbody>
        </table> : <table>
          <thead><tr><th>DropX ID</th><th>Biometric ID</th><th>Full name</th><th>Category</th><th>Mobile</th><th>Email</th><th>Location</th><th>Model</th><th>Provider</th><th>Designation</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={`${row.categoryCode}:${row.id}`}>
                <td><strong>{row.code}</strong></td><td>{row.biometricId}</td><td><strong>{row.fullName}</strong></td>
                <td>{row.category}</td><td>{row.mobile}</td><td>{row.email}</td><td>{row.location}</td><td>{row.model}</td><td>{row.provider}</td><td>{row.designation}</td>
                <td><StatusPill status={row.status} /></td>
                <td><AllPeopleActionMenu row={row} /></td>
              </tr>
            ))}
            {!filteredRows.length ? <tr><td className="empty-cell" colSpan={12}>No people match the selected filters.</td></tr> : null}
          </tbody>
        </table>}
      </div>
      {editableSheet ? (
        <div
          aria-label="People sheet horizontal scrollbar"
          className={`all-people-sticky-scroll ${stickyScrollFrame.visible ? "visible" : ""}`}
          ref={stickyScrollRef}
          style={{ left: stickyScrollFrame.left, width: stickyScrollFrame.width }}
          tabIndex={stickyScrollFrame.visible ? 0 : -1}
        >
          <div style={{ width: sheetScrollWidth }} />
        </div>
      ) : null}
      {filteredRows.length ? (
        <div className="panel-foot pagination all-people-pagination">
          <label className="all-people-page-size">
            <span>Rows</span>
            <select className="field" onChange={(event) => setPageSize(event.target.value === "all" ? "all" : Number(event.target.value) as PageSize)} value={pageSize}>
              {pageSizeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <button className="pager-button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} type="button">Previous</button>
          <span>{firstVisibleRecord}–{lastVisibleRecord} of {filteredRows.length} · Page {currentPage} of {totalPages}</span>
          <button className="pager-button" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)} type="button">Next</button>
        </div>
      ) : null}
      {exportOpen ? (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target && !exporting) setExportOpen(false);
        }}>
          <section aria-labelledby="all-people-export-title" aria-modal="true" className="modal-panel all-people-export-dialog" role="dialog">
            <div className="panel-head">
              <div>
                <h2 id="all-people-export-title">Export people</h2>
                <p className="subtle">Choose the Excel columns. All titles are selected by default.</p>
              </div>
              <button aria-label="Close export" className="icon-button" disabled={exporting} onClick={() => setExportOpen(false)} type="button">
                <X aria-hidden="true" size={18} />
              </button>
            </div>
            <div className="all-people-export-body">
              <div className="all-people-export-toolbar">
                <label className="all-people-export-select-all">
                  <input
                    checked={selectedExportColumns.length === allPeopleExportColumns.length}
                    onChange={(event) => setSelectedExportColumns(event.target.checked ? allPeopleExportColumns.map((column) => column.key) : [])}
                    type="checkbox"
                  />
                  <strong>Select all titles</strong>
                </label>
                <span className="subtle">{filteredRows.length} filtered record{filteredRows.length === 1 ? "" : "s"}</span>
              </div>
              <label className="all-people-export-search">
                <Search aria-hidden="true" size={17} />
                <input
                  autoComplete="off"
                  className="field"
                  onChange={(event) => setExportColumnSearch(event.target.value)}
                  placeholder="Search titles"
                  type="search"
                  value={exportColumnSearch}
                />
              </label>
              <div className="all-people-export-columns">
                {visibleExportColumns.map((column) => (
                  <label key={column.key}>
                    <input checked={selectedExportSet.has(column.key)} onChange={() => toggleExportColumn(column.key)} type="checkbox" />
                    <span>{column.label}</span>
                  </label>
                ))}
                {!visibleExportColumns.length ? (
                  <p className="all-people-export-empty subtle">No titles match your search.</p>
                ) : null}
              </div>
            </div>
            <div className="all-people-export-actions">
              <button className="button secondary" disabled={exporting} onClick={() => setExportOpen(false)} type="button">Cancel</button>
              <button className="button" disabled={exporting || !selectedExportColumns.length || !filteredRows.length} onClick={exportPeople} type="button">
                <Download aria-hidden="true" size={16} /> {exporting ? "Preparing..." : "Export Excel"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {documentPreview ? (
        <div className="modal-backdrop sheet-document-backdrop" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setDocumentPreview(null);
        }}>
          <section aria-labelledby="sheet-document-preview-title" aria-modal="true" className="modal-panel sheet-document-preview" role="dialog">
            <div className="panel-head">
              <div>
                <h2 id="sheet-document-preview-title">{documentPreview.label}</h2>
                <p className="subtle">View only</p>
              </div>
              <button aria-label="Close document preview" className="icon-button" onClick={() => setDocumentPreview(null)} type="button">
                <X aria-hidden="true" size={18} />
              </button>
            </div>
            <iframe referrerPolicy="no-referrer" sandbox="" src={documentPreview.href} title={documentPreview.label} />
          </section>
        </div>
      ) : null}
    </section>
  );
}
