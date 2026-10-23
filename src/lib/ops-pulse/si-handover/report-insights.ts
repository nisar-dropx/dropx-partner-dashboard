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
