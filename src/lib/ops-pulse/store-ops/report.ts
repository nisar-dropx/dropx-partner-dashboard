/** Manager analytics for Store Operations daily checklists. */
import {
  progress,
  type ChecklistStatus,
  type Settings,
  type StoreOpsChecklist,
} from "./model";
import {
  applyBucketTrends,
  buildPersonActivity as buildPersonActivityCore,
  formatQuietLabel,
  formatTrendDelta,
  type PersonActivity as PersonActivityCore,
  type PersonActivityItem as PersonActivityItemCore,
} from "../si-handover/report-insights";

export {
  applyBucketTrends,
  formatQuietLabel,
  formatTrendDelta,
};

/** Quiet open checklists past this window count as stale (store has no SI escalate setting). */
export const STORE_OPS_STALE_OPEN_MINUTES = 30;

export type StoreRef = {
  id: string;
  station_code: string;
  city?: string | null;
};

export type ProgressRow = {
  id: string;
  location_id: string;
  store_code: string;
  work_date: string;
  status: ChecklistStatus;
  owner_user_id: string;
  owner_name: string;
  started_at: string;
  updated_at: string;
  submitted_at: string | null;
  answered: number;
  total: number;
  pct: number;
  staleOpen: boolean;
  quietMinutes: number;
};

export type Bucket = {
  key: string;
  label: string;
  days: number;
  open: number;
  submitted: number;
  avgPct: number;
  staleOpen: number;
  firstStartedAt: string | null;
  lastUpdatedAt: string | null;
  trendDelta: number | null;
};

export type PersonActivityItem = PersonActivityItemCore & {
  work_date: string;
  status: ChecklistStatus;
};

export type PersonActivity = Omit<PersonActivityCore, "items"> & {
  items: PersonActivityItem[];
};

export type ReportSummary = {
  days: number;
  open: number;
  submitted: number;
  cancelled: number;
  avgPct: number;
  submitRate: number;
  staleOpen: number;
  byStore: Bucket[];
  byOwner: Bucket[];
  personActivity: PersonActivity[];
};

function avg(nums: number[]) {
  if (!nums.length) return 0;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
}

function lastActivityAt(row: StoreOpsChecklist) {
  let latest = row.updated_at || row.started_at;
  for (const e of row.events || []) {
    if (e?.at && Date.parse(e.at) > Date.parse(latest)) latest = e.at;
  }
  return latest;
}

export function enrichChecklistRows(
  rows: StoreOpsChecklist[],
  stores: StoreRef[],
  settings: Settings,
  now = Date.now(),
  staleMinutes = STORE_OPS_STALE_OPEN_MINUTES,
): ProgressRow[] {
  const cityById = new Map(stores.map((s) => [s.id, s.city || null]));
  void settings;
  return rows.map((row) => {
    const p = progress(
      { template: row.template, answers: row.answers },
      {
        city: cityById.get(row.location_id),
        settings,
      },
    );
    const updatedAt = lastActivityAt(row);
    const quietMinutes = Math.max(
      0,
      Math.round((now - Date.parse(updatedAt)) / 60000),
    );
    const staleOpen = row.status === "open" && quietMinutes >= staleMinutes;
    return {
      id: row.id,
      location_id: row.location_id,
      store_code: row.store_code,
      work_date: row.work_date,
      status: row.status,
      owner_user_id: row.owner_user_id,
      owner_name: row.owner_name || "—",
      started_at: row.started_at,
      updated_at: updatedAt,
      submitted_at: row.submitted_at,
      answered: p.answered,
      total: p.total,
      pct: p.pct,
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
        days: list.length,
        open: list.filter((r) => r.status === "open").length,
        submitted: list.filter((r) => r.status === "submitted").length,
        avgPct: avg(list.map((r) => r.pct)),
        staleOpen: list.filter((r) => r.staleOpen).length,
        firstStartedAt: starts[0] || null,
        lastUpdatedAt: updates[updates.length - 1] || null,
        trendDelta: null as number | null,
      };
    })
    .sort((a, b) => b.days - a.days || a.label.localeCompare(b.label));
}

export function buildPersonActivity(rows: ProgressRow[]): PersonActivity[] {
  return buildPersonActivityCore(
    rows.map((r) => ({
      id: r.id,
      store_code: r.store_code,
      work_date: r.work_date,
      status: r.status,
      personKey: r.owner_user_id || r.owner_name,
      personLabel: r.owner_name,
      started_at: r.started_at,
      updated_at: r.updated_at,
      submitted_at: r.submitted_at,
      pct: r.pct,
      staleOpen: r.staleOpen,
    })),
  ) as PersonActivity[];
}

export function summarizeReport(
  rows: ProgressRow[],
  priorRows: ProgressRow[] = [],
): ReportSummary {
  const submitted = rows.filter((r) => r.status === "submitted");
  const priorSummary =
    priorRows.length > 0
      ? {
          byStore: bucketize(
            priorRows,
            (r) => r.location_id,
            (r) => r.store_code,
          ),
          byOwner: bucketize(
            priorRows,
            (r) => r.owner_user_id || r.owner_name,
            (r) => r.owner_name,
          ),
        }
      : { byStore: [] as Bucket[], byOwner: [] as Bucket[] };

  return {
    days: rows.length,
    open: rows.filter((r) => r.status === "open").length,
    submitted: submitted.length,
    cancelled: rows.filter((r) => r.status === "cancelled").length,
    avgPct: avg(rows.map((r) => r.pct)),
    submitRate: rows.length
      ? Math.round((100 * submitted.length) / rows.length)
      : 0,
    staleOpen: rows.filter((r) => r.staleOpen).length,
    byStore: applyBucketTrends(
      bucketize(
        rows,
        (r) => r.location_id,
        (r) => r.store_code,
      ),
      priorSummary.byStore,
    ),
    byOwner: applyBucketTrends(
      bucketize(
        rows,
        (r) => r.owner_user_id || r.owner_name,
        (r) => r.owner_name,
      ),
      priorSummary.byOwner,
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
  | "owner"
  | "status";

export function sortProgressRows(rows: ProgressRow[], sort: SortKey) {
  const copy = [...rows];
  const statusOrder: Record<string, number> = {
    open: 0,
    submitted: 1,
    cancelled: 2,
  };
  copy.sort((a, b) => {
    switch (sort) {
      case "date_asc":
        return a.work_date.localeCompare(b.work_date);
      case "pct_desc":
        return b.pct - a.pct || a.store_code.localeCompare(b.store_code);
      case "pct_asc":
        return a.pct - b.pct || a.store_code.localeCompare(b.store_code);
      case "store":
        return (
          a.store_code.localeCompare(b.store_code) ||
          b.work_date.localeCompare(a.work_date)
        );
      case "owner":
        return (
          a.owner_name.localeCompare(b.owner_name) ||
          b.work_date.localeCompare(a.work_date)
        );
      case "status":
        return (
          (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9) ||
          b.work_date.localeCompare(a.work_date)
        );
      case "date_desc":
      default:
        return b.work_date.localeCompare(a.work_date);
    }
  });
  return copy;
}

export function filterProgressRows(
  rows: ProgressRow[],
  filters: {
    store?: string;
    owner?: string;
    status?: string;
    q?: string;
  },
) {
  const q = (filters.q || "").trim().toLowerCase();
  return rows.filter((r) => {
    if (filters.store && r.location_id !== filters.store && r.store_code !== filters.store)
      return false;
    if (
      filters.owner &&
      r.owner_user_id !== filters.owner &&
      r.owner_name !== filters.owner
    )
      return false;
    if (filters.status && r.status !== filters.status) return false;
    if (
      q &&
      ![r.store_code, r.owner_name, r.work_date, r.status]
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

