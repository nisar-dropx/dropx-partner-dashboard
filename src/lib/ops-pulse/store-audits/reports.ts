/** Apollo programme reports for City Manager & above (and per-store views). */
import {
  auditTypeLabels,
  isScored,
  questions,
  score,
  scoreBand,
  type AuditType,
  type ScoreBand,
  type StoreAudit,
} from "./model";

export type StoreAuditListRow = Pick<
  StoreAudit,
  | "id"
  | "number"
  | "location_id"
  | "store_name"
  | "assigned_to"
  | "assigned_name"
  | "scheduled_for"
  | "status"
  | "completed_at"
  | "findings"
  | "answers"
  | "audit_type"
  | "score"
  | "score_band"
  | "amazon_score"
  | "template"
>;

export function auditScore(row: StoreAuditListRow) {
  if (row.audit_type === "amazon" && row.amazon_score != null)
    return row.amazon_score;
  return row.score ?? score(row);
}

export function auditBand(row: StoreAuditListRow): ScoreBand | null {
  return row.score_band ?? scoreBand(auditScore(row));
}

export function storeHistory(rows: StoreAuditListRow[]) {
  return [...rows]
    .filter((r) => r.completed_at)
    .sort(
      (a, b) =>
        Date.parse(b.completed_at || b.scheduled_for) -
        Date.parse(a.completed_at || a.scheduled_for),
    )
    .map((r) => ({
      id: r.id,
      store: r.store_name,
      locationId: r.location_id,
      type: r.audit_type || "mock",
      typeLabel: auditTypeLabels[(r.audit_type || "mock") as AuditType],
      score: auditScore(r),
      band: auditBand(r),
      date: r.completed_at || r.scheduled_for,
      auditor: r.assigned_name,
      amazonScore: r.amazon_score,
    }));
}

/** Latest completed audit of each type per store × section %. */
export function sectionHeatmap(rows: StoreAuditListRow[]) {
  const latest = new Map<string, StoreAuditListRow>();
  for (const r of storeHistory(rows)) {
    const full = rows.find((x) => x.id === r.id);
    if (!full?.template) continue;
    const key = `${full.location_id}:${full.audit_type || "mock"}`;
    if (!latest.has(key)) latest.set(key, full);
  }
  const sectionNames = new Map<string, string>();
  const cells: {
    locationId: string;
    store: string;
    type: string;
    sectionId: string;
    section: string;
    percentage: number | null;
  }[] = [];
  for (const row of latest.values()) {
    for (const s of row.template.sections) {
      sectionNames.set(s.id, s.name);
      const qs = s.questions.filter(isScored);
      const answered = qs.filter((q) =>
        ["pass", "gap"].includes(row.answers?.[q.id]?.outcome || ""),
      );
      const compliant = answered.filter(
        (q) => row.answers?.[q.id]?.outcome === "pass",
      ).length;
      cells.push({
        locationId: row.location_id,
        store: row.store_name,
        type: row.audit_type || "mock",
        sectionId: s.id,
        section: s.name,
        percentage: answered.length
          ? Math.round((1000 * compliant) / answered.length) / 10
          : null,
      });
    }
  }
  return { sections: [...sectionNames.entries()].map(([id, name]) => ({ id, name })), cells };
}

export function topFailedQuestions(
  rows: StoreAuditListRow[],
  days = 30,
  now = Date.now(),
) {
  const since = now - days * 86400000;
  const tallies = new Map<
    string,
    { id: string; label: string; stores: Set<string>; instances: number; fails: number }
  >();
  for (const row of rows) {
    if (!row.completed_at || Date.parse(row.completed_at) < since) continue;
    for (const q of questions(row.template || { sections: [] })) {
      if (!isScored(q) || row.answers?.[q.id]?.outcome !== "gap") continue;
      const t = tallies.get(q.id) || {
        id: q.id,
        label: q.label,
        stores: new Set<string>(),
        instances: 0,
        fails: 0,
      };
      t.stores.add(row.location_id);
      t.fails++;
      t.instances += Number(row.answers[q.id]?.instances) || 1;
      tallies.set(q.id, t);
    }
  }
  return [...tallies.values()]
    .map((t) => ({
      id: t.id,
      label: t.label,
      storesFailed: t.stores.size,
      fails: t.fails,
      instances: t.instances,
    }))
    .sort(
      (a, b) =>
        b.storesFailed - a.storesFailed ||
        b.instances - a.instances ||
        a.label.localeCompare(b.label),
    );
}

export function repeatFailures(rows: StoreAuditListRow[]) {
  const byStore = new Map<string, StoreAuditListRow[]>();
  for (const r of storeHistory(rows)) {
    const full = rows.find((x) => x.id === r.id);
    if (!full) continue;
    const list = byStore.get(full.location_id) || [];
    list.push(full);
    byStore.set(full.location_id, list);
  }
  const out: {
    locationId: string;
    store: string;
    questionId: string;
    label: string;
    fails: number;
  }[] = [];
  for (const [locationId, list] of byStore) {
    const last3 = list.slice(0, 3);
    if (last3.length < 2) continue;
    const failCounts = new Map<string, { label: string; n: number }>();
    for (const row of last3) {
      for (const q of questions(row.template || { sections: [] })) {
        if (!isScored(q) || row.answers?.[q.id]?.outcome !== "gap") continue;
        const cur = failCounts.get(q.id) || { label: q.label, n: 0 };
        cur.n++;
        failCounts.set(q.id, cur);
      }
    }
    for (const [questionId, v] of failCounts) {
      if (v.n >= 2)
        out.push({
          locationId,
          store: last3[0].store_name,
          questionId,
          label: v.label,
          fails: v.n,
        });
    }
  }
  return out.sort((a, b) => b.fails - a.fails || a.store.localeCompare(b.store));
}

export function openActions(rows: StoreAuditListRow[], now = Date.now()) {
  const out: {
    auditId: string;
    store: string;
    questionId: string;
    label: string;
    owner: string;
    dueAt: string;
    overdue: boolean;
    ageingHours: number;
    state: string;
  }[] = [];
  for (const row of rows) {
    if (!row.completed_at) continue;
    for (const f of row.findings || []) {
      if (f.state === "closed") continue;
      const q = questions(row.template || { sections: [] }).find(
        (x) => x.id === f.questionId,
      );
      const dueAt = row.answers?.[f.questionId]?.dueAt || "";
      const due = Date.parse(dueAt);
      out.push({
        auditId: row.id,
        store: row.store_name,
        questionId: f.questionId,
        label: q?.label || f.questionId,
        owner: row.answers?.[f.questionId]?.owner || "—",
        dueAt,
        overdue: Number.isFinite(due) && due < now,
        ageingHours: Number.isFinite(due)
          ? Math.max(0, Math.round((now - due) / 3600000))
          : 0,
        state: f.state,
      });
    }
  }
  return out.sort(
    (a, b) => Number(b.overdue) - Number(a.overdue) || b.ageingHours - a.ageingHours,
  );
}

export function readiness(rows: StoreAuditListRow[], now = Date.now()) {
  const byStore = new Map<
    string,
    { store: string; locationId: string; lastSelf: number | null; lastMock: number | null }
  >();
  for (const row of rows) {
    if (!row.completed_at) continue;
    const cur = byStore.get(row.location_id) || {
      store: row.store_name,
      locationId: row.location_id,
      lastSelf: null,
      lastMock: null,
    };
    const t = Date.parse(row.completed_at);
    if (row.audit_type === "self")
      cur.lastSelf = Math.max(cur.lastSelf ?? 0, t) || t;
    if (row.audit_type === "mock")
      cur.lastMock = Math.max(cur.lastMock ?? 0, t) || t;
    byStore.set(row.location_id, cur);
  }
  return [...byStore.values()]
    .map((s) => ({
      ...s,
      daysSinceSelf:
        s.lastSelf == null ? null : Math.floor((now - s.lastSelf) / 86400000),
      daysSinceMock:
        s.lastMock == null ? null : Math.floor((now - s.lastMock) / 86400000),
      flagNoSelf7d: s.lastSelf == null || now - s.lastSelf > 7 * 86400000,
    }))
    .sort((a, b) => Number(b.flagNoSelf7d) - Number(a.flagNoSelf7d));
}

export function mockVsAmazon(rows: StoreAuditListRow[]) {
  const byStore = new Map<string, StoreAuditListRow[]>();
  for (const r of storeHistory(rows)) {
    const full = rows.find((x) => x.id === r.id);
    if (!full) continue;
    const list = byStore.get(full.location_id) || [];
    list.push(full);
    byStore.set(full.location_id, list);
  }
  const out: {
    locationId: string;
    store: string;
    mockScore: number | null;
    amazonScore: number | null;
    gap: number | null;
    lenient: boolean;
  }[] = [];
  for (const [locationId, list] of byStore) {
    const amazon = list.find((r) => r.audit_type === "amazon");
    if (!amazon) continue;
    const amazonAt = Date.parse(amazon.completed_at || amazon.scheduled_for);
    const mock = list.find(
      (r) =>
        r.audit_type === "mock" &&
        Date.parse(r.completed_at || r.scheduled_for) <= amazonAt,
    );
    const mockScore = mock ? auditScore(mock) : null;
    const amazonScore = auditScore(amazon);
    const gap =
      mockScore != null && amazonScore != null
        ? Math.round((mockScore - amazonScore) * 10) / 10
        : null;
    out.push({
      locationId,
      store: amazon.store_name,
      mockScore,
      amazonScore,
      gap,
      lenient: gap != null && gap > 10,
    });
  }
  return out.sort((a, b) => (b.gap ?? -999) - (a.gap ?? -999));
}
