/** Manager analytics for Activities & Handover checklists. */
import {
  escalationLevel,
  progress,
  type ChecklistStatus,
  type Settings,
  type SiChecklist,
} from "./model";
import {
  applyBucketTrends,
  buildPersonActivity as buildPersonActivityCore,
  formatQuietLabel,
  formatTrendDelta,
  type PersonActivity as PersonActivityCore,
  type PersonActivityItem as PersonActivityItemCore,
} from "./report-insights";

export {
  applyBucketTrends,
  formatQuietLabel,
  formatTrendDelta,
};

export type StoreRef = {
  id: string;
  station_code: string;
  city?: string | null;
};

export type ProgressRow = {
  id: string;
  location_id: string;
  store_code: string;
  shift_date: string;
  shift_slot: string;
  status: ChecklistStatus;
  outgoing_user_id: string;
  outgoing_name: string;
  incoming_name: string | null;
  started_at: string;
  updated_at: string;
  submitted_at: string | null;
  accepted_at: string | null;
  answered: number;
  total: number;
  pct: number;
  escalate: "none" | "store" | "cluster";
  /** Open checklist quiet longer than store escalate window. */
  staleOpen: boolean;
  quietMinutes: number;
};

export type Bucket = {
  key: string;
  label: string;
  shifts: number;
  open: number;
  submitted: number;
  accepted: number;
  rejected: number;
  avgPct: number;
  overdue: number;
  staleOpen: number;
  /** Earliest start in range (ISO) or null. */
  firstStartedAt: string | null;
  /** Most recent activity (ISO) or null. */
  lastUpdatedAt: string | null;
  /** avgPct − prior-window avgPct for same key; null if no prior. */
  trendDelta: number | null;
};

export type PersonActivityItem = PersonActivityItemCore & {
  shift_date: string;
  shift_slot: string;
  status: ChecklistStatus;
};

export type PersonActivity = Omit<PersonActivityCore, "items"> & {
  items: PersonActivityItem[];
};

export type ReportSummary = {
  shifts: number;
  open: number;
  submitted: number;
  accepted: number;
  rejected: number;
  cancelled: number;
  avgPct: number;
  submitRate: number;
  acceptRate: number;
  overdueAccept: number;
  staleOpen: number;
  byStore: Bucket[];
  bySi: Bucket[];
  bySlot: Bucket[];
  personActivity: PersonActivity[];
};

function avg(nums: number[]) {
  if (!nums.length) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function lastActivityAt(row: SiChecklist) {
  let latest = row.updated_at || row.started_at;
  for (const e of row.events || []) {
    if (e?.at && Date.parse(e.at) > Date.parse(latest)) latest = e.at;
  }
  return latest;
}

export function enrichChecklistRows(
  rows: SiChecklist[],
  stores: StoreRef[],
  settings: Settings,
  now = Date.now(),
): ProgressRow[] {
  const cityById = new Map(stores.map((s) => [s.id, s.city || null]));
  return rows.map((row) => {
    const p = progress(row, {
      city: cityById.get(row.location_id),
      settings,
    });
    const updatedAt = lastActivityAt(row);
    const quietMinutes = Math.max(
      0,
      Math.round((now - Date.parse(updatedAt)) / 60000),
    );
    const staleOpen =
      row.status === "open" &&
      quietMinutes >= (settings.escalateStoreMinutes || 30);
    return {
      id: row.id,
      location_id: row.location_id,
      store_code: row.store_code,
      shift_date: row.shift_date,
      shift_slot: row.shift_slot,
      status: row.status,
      outgoing_user_id: row.outgoing_user_id,
      outgoing_name: row.outgoing_name || "—",
      incoming_name: row.incoming_name,
      started_at: row.started_at,
      updated_at: updatedAt,
      submitted_at: row.submitted_at,
      accepted_at: row.accepted_at,
      answered: p.answered,
      total: p.total,
      pct: p.pct,
      escalate:
        row.status === "submitted"
          ? escalationLevel(row.submitted_at, settings, now)
          : "none",
      staleOpen,
      quietMinutes,
    };
  });
}

function bucketize(
  rows: ProgressRow[],
  keyFn: (r: ProgressRow) => string,
  labelFn: (r: ProgressRow) => string,
): Bucket[] {
  const map = new Map<string, { label: string; rows: ProgressRow[] }>();
  for (const row of rows) {
    const key = keyFn(row);
    const cur = map.get(key) || { label: labelFn(row), rows: [] };
    cur.rows.push(row);
    map.set(key, cur);
  }
  return [...map.entries()]
    .map(([key, { label, rows: list }]) => {
      const starts = list
        .map((r) => r.started_at)
        .filter(Boolean)
        .sort();
      const updates = list
        .map((r) => r.updated_at)
        .filter(Boolean)
        .sort();
      return {
        key,
        label,
        shifts: list.length,
        open: list.filter((r) => r.status === "open").length,
        submitted: list.filter((r) => r.status === "submitted").length,
        accepted: list.filter((r) => r.status === "accepted").length,
        rejected: list.filter((r) => r.status === "rejected").length,
        avgPct: avg(list.map((r) => r.pct)),
        overdue: list.filter((r) => r.escalate !== "none").length,
        staleOpen: list.filter((r) => r.staleOpen).length,
        firstStartedAt: starts[0] || null,
        lastUpdatedAt: updates[updates.length - 1] || null,
        trendDelta: null as number | null,
      };
    })
    .sort((a, b) => b.shifts - a.shifts || a.label.localeCompare(b.label));
}

export function buildPersonActivity(rows: ProgressRow[]): PersonActivity[] {
  return buildPersonActivityCore(
    rows.map((r) => ({
      id: r.id,
      store_code: r.store_code,
      shift_date: r.shift_date,
      shift_slot: r.shift_slot,
      status: r.status,
      personKey: r.outgoing_user_id || r.outgoing_name,
      personLabel: r.outgoing_name,
      started_at: r.started_at,
      updated_at: r.updated_at,
      submitted_at: r.submitted_at,
      accepted_at: r.accepted_at,
      pct: r.pct,
      staleOpen: r.staleOpen,
    })),
  ) as PersonActivity[];
}

export function summarizeReport(
  rows: ProgressRow[],
  priorRows: ProgressRow[] = [],
): ReportSummary {
  const terminal = rows.filter((r) =>
    ["submitted", "accepted", "rejected"].includes(r.status),
  );
  const accepted = rows.filter((r) => r.status === "accepted");
  const priorSummary =
    priorRows.length > 0
      ? {
          byStore: bucketize(
            priorRows,
            (r) => r.location_id,
            (r) => r.store_code,
          ),
          bySi: bucketize(
            priorRows,
            (r) => r.outgoing_user_id || r.outgoing_name,
            (r) => r.outgoing_name,
          ),
        }
      : { byStore: [] as Bucket[], bySi: [] as Bucket[] };

  return {
    shifts: rows.length,
    open: rows.filter((r) => r.status === "open").length,
    submitted: rows.filter((r) => r.status === "submitted").length,
    accepted: accepted.length,
    rejected: rows.filter((r) => r.status === "rejected").length,
    cancelled: rows.filter((r) => r.status === "cancelled").length,
    avgPct: avg(rows.map((r) => r.pct)),
    submitRate: rows.length
      ? Math.round((100 * terminal.length) / rows.length)
      : 0,
    acceptRate: terminal.length
      ? Math.round((100 * accepted.length) / terminal.length)
      : 0,
    overdueAccept: rows.filter((r) => r.escalate !== "none").length,
    staleOpen: rows.filter((r) => r.staleOpen).length,
    byStore: applyBucketTrends(
      bucketize(
        rows,
        (r) => r.location_id,
        (r) => r.store_code,
      ),
      priorSummary.byStore,
    ),
    bySi: applyBucketTrends(
      bucketize(
        rows,
        (r) => r.outgoing_user_id || r.outgoing_name,
        (r) => r.outgoing_name,
      ),
      priorSummary.bySi,
    ),
    bySlot: bucketize(
      rows,
      (r) => r.shift_slot,
      (r) => r.shift_slot,
    ),
    personActivity: buildPersonActivity(rows),
  };
}

export type SortKey =
  | "date_desc"
  | "date_asc"
  | "pct_desc"
  | "pct_asc"
  | "store"
  | "si"
  | "status";

export function sortProgressRows(rows: ProgressRow[], sort: SortKey) {
  const copy = [...rows];
  const statusOrder: Record<string, number> = {
    submitted: 0,
    open: 1,
    rejected: 2,
    accepted: 3,
    cancelled: 4,
  };
  copy.sort((a, b) => {
    switch (sort) {
      case "date_asc":
        return (
          a.shift_date.localeCompare(b.shift_date) ||
          a.shift_slot.localeCompare(b.shift_slot)
        );
      case "pct_desc":
        return b.pct - a.pct || a.store_code.localeCompare(b.store_code);
      case "pct_asc":
        return a.pct - b.pct || a.store_code.localeCompare(b.store_code);
      case "store":
        return (
          a.store_code.localeCompare(b.store_code) ||
          b.shift_date.localeCompare(a.shift_date)
        );
      case "si":
        return (
          a.outgoing_name.localeCompare(b.outgoing_name) ||
          b.shift_date.localeCompare(a.shift_date)
        );
      case "status":
        return (
          (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9) ||
          b.shift_date.localeCompare(a.shift_date)
        );
      case "date_desc":
      default:
        return (
          b.shift_date.localeCompare(a.shift_date) ||
          b.shift_slot.localeCompare(a.shift_slot)
        );
    }
  });
  return copy;
}

export function filterProgressRows(
  rows: ProgressRow[],
  filters: {
    store?: string;
    si?: string;
    status?: string;
    slot?: string;
    q?: string;
  },
) {
  const q = (filters.q || "").trim().toLowerCase();
  return rows.filter((r) => {
    if (filters.store && r.location_id !== filters.store && r.store_code !== filters.store)
      return false;
    if (
      filters.si &&
      r.outgoing_user_id !== filters.si &&
      r.outgoing_name !== filters.si
    )
      return false;
    if (filters.status && r.status !== filters.status) return false;
    if (filters.slot && r.shift_slot !== filters.slot) return false;
    if (
      q &&
      ![
        r.store_code,
        r.outgoing_name,
        r.incoming_name || "",
        r.shift_date,
        r.shift_slot,
        r.status,
      ]
        .join(" ")
        .toLowerCase()
        .includes(q)
    )
      return false;
    return true;
  });
}

export function paginateRows<T>(rows: T[], page: number, pageSize: number) {
  const size = Math.min(100, Math.max(5, pageSize || 20));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, page || 1), pages);
  const start = (current - 1) * size;
  return {
    rows: rows.slice(start, start + size),
    page: current,
    pageSize: size,
    total,
    pages,
  };
}

/** Format quiet time for insight chips. */
