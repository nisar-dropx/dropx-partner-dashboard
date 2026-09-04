export type WeeklyRosterVersion = {
  id: string;
  effective_from: string;
  superseded_at: string | null;
  revision_no?: number | null;
};

export type WeeklyRosterEntry<T = unknown> = {
  plan_id: string;
  worker_type: "employee" | "contractor";
  worker_id: string;
  roster_date: string;
  value: T;
};

export function isoWeekday(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function mondayFor(date: string) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - (isoWeekday(date) - 1));
  return value.toISOString().slice(0, 10);
}

export function isWeeklyVersionActive(version: WeeklyRosterVersion, date: string) {
  return version.effective_from <= date && (!version.superseded_at || date < version.superseded_at);
}

export function buildWeeklyRosterIndex<T>(versions: WeeklyRosterVersion[], entries: WeeklyRosterEntry<T>[]) {
  const versionsById = new Map(versions.map((version) => [version.id, version]));
  const index = new Map<string, Array<{ version: WeeklyRosterVersion; value: T }>>();
  for (const entry of entries) {
    const version = versionsById.get(entry.plan_id);
    if (!version) continue;
    const key = `${entry.worker_type}:${entry.worker_id}:${isoWeekday(entry.roster_date)}`;
    index.set(key, [...(index.get(key) ?? []), { version, value: entry.value }]);
  }
  for (const values of index.values()) {
    values.sort((left, right) => right.version.effective_from.localeCompare(left.version.effective_from)
      || Number(right.version.revision_no ?? 0) - Number(left.version.revision_no ?? 0));
  }
  return index;
}

export function weeklyRosterValueForDate<T>(
  index: Map<string, Array<{ version: WeeklyRosterVersion; value: T }>>,
  workerType: "employee" | "contractor",
  workerId: string,
  date: string
) {
  return index.get(`${workerType}:${workerId}:${isoWeekday(date)}`)
    ?.find((candidate) => isWeeklyVersionActive(candidate.version, date))?.value ?? null;
}
