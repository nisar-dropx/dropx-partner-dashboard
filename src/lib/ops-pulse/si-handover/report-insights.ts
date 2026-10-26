/** Pure insight helpers for Activities report (no server/model imports). */

export type InsightBucket = {
  key: string;
  avgPct: number;
  trendDelta: number | null;
};

export function applyBucketTrends<T extends InsightBucket>(
  current: T[],
  prior: InsightBucket[],
): T[] {
  const priorPct = new Map(prior.map((b) => [b.key, b.avgPct]));
  return current.map((b) => {
    const prev = priorPct.get(b.key);
    return {
      ...b,
      trendDelta: prev == null ? null : b.avgPct - prev,
    };
  });
}

export function formatQuietLabel(quietMinutes: number) {
  if (quietMinutes < 60) return `${quietMinutes}m quiet`;
  const h = Math.floor(quietMinutes / 60);
  const m = quietMinutes % 60;
  return m ? `${h}h ${m}m quiet` : `${h}h quiet`;
}

export function formatTrendDelta(delta: number | null) {
  if (delta == null) return null;
  if (delta === 0) return "Trend · flat";
  return delta > 0 ? `Trend ↑ +${delta}%` : `Trend ↓ ${delta}%`;
}

export type PersonActivityKind = "completed" | "open" | "missed";

export type PersonActivityRowInput = {
  id: string;
  store_code: string;
  shift_date?: string;
  shift_slot?: string;
  work_date?: string;
  status: string;
  personKey: string;
  personLabel: string;
  started_at: string;
  updated_at: string;
  submitted_at: string | null;
  accepted_at?: string | null;
  pct: number;
  staleOpen: boolean;
};

export type PersonActivityItem = {
  id: string;
  store_code: string;
  shift_date?: string;
  shift_slot?: string;
  work_date?: string;
  kind: PersonActivityKind;
  pct: number;
  at: string;
  status: string;
};

export type PersonActivity = {
  key: string;
  label: string;
  completed: number;
  open: number;
  missed: number;
  lastCompletedAt: string | null;
  items: PersonActivityItem[];
};

export function buildPersonActivity(
  rows: PersonActivityRowInput[],
): PersonActivity[] {
  const map = new Map<string, PersonActivity>();
  for (const r of rows) {
    const key = r.personKey;
    const cur = map.get(key) || {
      key,
      label: r.personLabel,
      completed: 0,
      open: 0,
      missed: 0,
      lastCompletedAt: null as string | null,
      items: [] as PersonActivityItem[],
    };
    const completed =
      r.status === "submitted" ||
      r.status === "accepted" ||
      r.status === "rejected";
    const kind: PersonActivityKind = completed
      ? "completed"
      : r.staleOpen
        ? "missed"
        : r.status === "open"
          ? "open"
          : "completed";
    if (kind === "completed") cur.completed += 1;
    else if (kind === "missed") cur.missed += 1;
    else if (kind === "open") cur.open += 1;

    const at =
      r.accepted_at || r.submitted_at || r.updated_at || r.started_at;
    if (
      kind === "completed" &&
      (!cur.lastCompletedAt || Date.parse(at) > Date.parse(cur.lastCompletedAt))
    ) {
      cur.lastCompletedAt = at;
    }
    cur.items.push({
      id: r.id,
      store_code: r.store_code,
      shift_date: r.shift_date,
      shift_slot: r.shift_slot,
      work_date: r.work_date,
      kind,
      pct: r.pct,
      at,
      status: r.status,
    });
    map.set(key, cur);
  }
  return [...map.values()]
    .map((p) => ({
      ...p,
      items: p.items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    }))
    .sort(
      (a, b) =>
        b.completed + b.open + b.missed - (a.completed + a.open + a.missed) ||
        a.label.localeCompare(b.label),
    );
}

/** Slot cell state for store × date × shift continuity. */
export type ContinuityCellKind =
  | "missing"
  | "open"
  | "stale"
  | "submitted"
  | "accepted"
  | "rejected"
  | "cancelled";

export type ContinuityCell = {
  date: string;
  slot: string;
  kind: ContinuityCellKind;
  checklistId: string | null;
  pct: number;
  siName: string | null;
};

export type StoreContinuityHealth =
  | "continuous"
  | "in_progress"
  | "at_risk"
  | "broken"
  | "empty";

export type StoreContinuityRow = {
  locationId: string;
  storeCode: string;
  expected: number;
  covered: number;
  accepted: number;
  open: number;
  stale: number;
  missing: number;
  rejected: number;
  continuityPct: number;
  health: StoreContinuityHealth;
  cells: ContinuityCell[];
};

export type StoreContinuityBoard = {
  slots: string[];
  dates: string[];
  expected: number;
  covered: number;
  missing: number;
  stale: number;
  continuousStores: number;
  atRiskStores: number;
  brokenStores: number;
  emptyStores: number;
  continuityPct: number;
  stores: StoreContinuityRow[];
};

export type ContinuityRowInput = {
  id: string;
  location_id: string;
  store_code: string;
  shift_date: string;
  shift_slot: string;
  status: string;
  pct: number;
  staleOpen?: boolean;
  outgoing_name?: string | null;
};

export type ContinuityStoreRef = {
  id: string;
  station_code: string;
};

const CELL_RANK: Record<ContinuityCellKind, number> = {
  accepted: 6,
  submitted: 5,
  open: 4,
  stale: 3,
  rejected: 2,
  cancelled: 1,
  missing: 0,
};

export function datesInInclusiveRange(from: string, to: string): string[] {
  if (!from || !to) return [];
  const start = from <= to ? from : to;
  const end = from <= to ? to : from;
  const out: string[] = [];
  const cursor = new Date(`${start}T12:00:00+05:30`);
  const last = new Date(`${end}T12:00:00+05:30`);
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(last.getTime())) {
    return [];
  }
  // Cap runaway ranges (safety for bad query params).
  for (let i = 0; i < 93 && cursor <= last; i++) {
    out.push(cursor.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function cellKindFromRow(row: ContinuityRowInput): ContinuityCellKind {
  if (row.status === "accepted") return "accepted";
  if (row.status === "submitted") return "submitted";
  if (row.status === "rejected") return "rejected";
  if (row.status === "cancelled") return "cancelled";
  if (row.status === "open") return row.staleOpen ? "stale" : "open";
  return "missing";
}

function pickBestRow(rows: ContinuityRowInput[]): ContinuityRowInput | null {
  if (!rows.length) return null;
  return [...rows].sort((a, b) => {
    const ka = CELL_RANK[cellKindFromRow(a)];
    const kb = CELL_RANK[cellKindFromRow(b)];
    return kb - ka || b.pct - a.pct;
  })[0]!;
}

function healthForRow(input: {
  expected: number;
  covered: number;
  accepted: number;
  missing: number;
  stale: number;
  rejected: number;
  open: number;
}): StoreContinuityHealth {
  if (input.expected <= 0) return "empty";
  if (input.covered === 0) return "empty";
  if (input.missing > 0 || input.rejected > 0) return "broken";
  if (input.stale > 0) return "at_risk";
  if (input.accepted === input.expected) return "continuous";
  // Covered but not fully accepted (open / submitted) = still in flight.
  return "in_progress";
}

/**
 * Build per-store shift continuity across every configured slot for each day
 * in [from, to], including stores with zero checklists (all missing).
 */
export function buildStoreContinuity(input: {
  stores: ContinuityStoreRef[];
  rows: ContinuityRowInput[];
  slots: string[];
  from: string;
  to: string;
}): StoreContinuityBoard {
  const slots = (input.slots.length ? input.slots : ["06:00", "22:00"]).filter(
    Boolean,
  );
  const dates = datesInInclusiveRange(input.from, input.to);
  const byKey = new Map<string, ContinuityRowInput[]>();
  for (const row of input.rows) {
    if (row.status === "cancelled") continue;
    const key = `${row.location_id}|${row.shift_date}|${row.shift_slot}`;
    const list = byKey.get(key) || [];
    list.push(row);
    byKey.set(key, list);
  }

  // Include any store that appears in rows even if not in the master store list.
  const storeMap = new Map<string, ContinuityStoreRef>();
  for (const s of input.stores) storeMap.set(s.id, s);
  for (const row of input.rows) {
    if (!storeMap.has(row.location_id)) {
      storeMap.set(row.location_id, {
        id: row.location_id,
        station_code: row.store_code,
      });
    }
  }

  const stores: StoreContinuityRow[] = [...storeMap.values()]
    .sort((a, b) => a.station_code.localeCompare(b.station_code))
    .map((store) => {
      const cells: ContinuityCell[] = [];
      for (const date of dates) {
        for (const slot of slots) {
          const best = pickBestRow(
            byKey.get(`${store.id}|${date}|${slot}`) || [],
          );
          if (!best) {
            cells.push({
              date,
              slot,
              kind: "missing",
              checklistId: null,
              pct: 0,
              siName: null,
            });
            continue;
          }
          cells.push({
            date,
            slot,
            kind: cellKindFromRow(best),
            checklistId: best.id,
            pct: best.pct,
            siName: best.outgoing_name || null,
          });
        }
      }
      const expected = cells.length;
      const missing = cells.filter((c) => c.kind === "missing").length;
      const covered = expected - missing;
      const accepted = cells.filter((c) => c.kind === "accepted").length;
      const open = cells.filter((c) => c.kind === "open").length;
      const stale = cells.filter((c) => c.kind === "stale").length;
      const rejected = cells.filter((c) => c.kind === "rejected").length;
      const continuityPct = expected
        ? Math.round((100 * accepted) / expected)
        : 0;
      return {
        locationId: store.id,
        storeCode: store.station_code,
        expected,
        covered,
        accepted,
        open,
        stale,
        missing,
        rejected,
        continuityPct,
        health: healthForRow({
          expected,
          covered,
          accepted,
          missing,
          stale,
          rejected,
          open,
        }),
        cells,
      };
    });

  const expected = stores.reduce((n, s) => n + s.expected, 0);
  const covered = stores.reduce((n, s) => n + s.covered, 0);
  const missing = stores.reduce((n, s) => n + s.missing, 0);
  const stale = stores.reduce((n, s) => n + s.stale, 0);
  const continuousStores = stores.filter((s) => s.health === "continuous").length;
  const atRiskStores = stores.filter(
    (s) => s.health === "at_risk" || s.health === "in_progress",
  ).length;
  const brokenStores = stores.filter((s) => s.health === "broken").length;
  const emptyStores = stores.filter((s) => s.health === "empty").length;
  const accepted = stores.reduce((n, s) => n + s.accepted, 0);

  return {
    slots,
    dates,
    expected,
    covered,
    missing,
    stale,
    continuousStores,
    atRiskStores,
    brokenStores,
    emptyStores,
    continuityPct: expected ? Math.round((100 * accepted) / expected) : 0,
    stores: stores.sort(
      (a, b) =>
        Number(b.health === "broken") - Number(a.health === "broken") ||
        Number(b.health === "at_risk") - Number(a.health === "at_risk") ||
        b.missing - a.missing ||
        a.storeCode.localeCompare(b.storeCode),
    ),
  };
}
