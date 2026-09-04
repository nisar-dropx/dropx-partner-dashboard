/** Pure review policy shared by the page, server actions and regression tests. */
export function reviewRole(value: string | null | undefined) {
  const role = ` ${String(value ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ")} `;
  if (/\b(PGM|PROGRAM MANAGER|PROGRAM HEAD)\b/.test(role)) return "program";
  if (/\b(CLM|CLUSTER MANAGER|CLUSTER HEAD)\b/.test(role)) return "cluster";
  if (/\b(AOM|AREA OPERATIONS? MANAGER)\b/.test(role)) return "aom";
  if (/\b(NH|NATIONAL HEAD)\b/.test(role)) return "national";
  if (/\b(LOCATION|TL|ATL|STM|SSA|TEAM LEAD|TEAM LEADER|STATION MANAGER|STATION SUPPORT ASSOCIATE)\b/.test(role)) return "station";
  return "other";
}

export function managerReviewChain<T extends { role: string; personId: string; designationCode?: string | null }>(chain: T[]) {
  const seen = new Set<string>();
  return chain.filter((person) => {
    const role = reviewRole(`${person.designationCode ?? ""} ${person.role}`);
    if (!["cluster", "aom", "national"].includes(role) || seen.has(person.personId)) return false;
    seen.add(person.personId);
    return true;
  });
}

export function reviewCapabilities(input: {
  userId: string;
  owner: boolean;
  programManager: boolean;
  stationUser: boolean;
  inScope: boolean;
  canView: boolean;
  canAdd: boolean;
  canEdit: boolean;
  closed: boolean;
  firstReviewerId: string | null;
  currentReviewerId: string | null;
  currentRole: string | null;
}) {
  const visible = input.inScope && input.canView;
  const editor = visible && input.canEdit;
  const oversight = input.owner || input.programManager;
  const current = Boolean(input.currentReviewerId && input.currentReviewerId === input.userId);
  const first = Boolean(input.firstReviewerId && input.firstReviewerId === input.userId);
  return {
    canStart: visible && (input.canAdd || input.canEdit) && (oversight || first),
    // Station team always; first manager on their stage can also enter timings when TL access is missing.
    canEditConnections: editor && (oversight || input.stationUser || (!input.closed && current && first)),
    canEditRca: editor && (oversight || (!input.closed && current && first)),
    canComment: editor && (oversight || (!input.closed && current)),
    // Programme oversight does not silently approve somebody else's review.
    canComplete: editor && !input.closed && Boolean(input.currentRole) && (input.owner || current),
  };
}

export function connectionTimes(values: { arrival: string; unloading: string; clearance: string }, serviceDate: string) {
  const parsed = Object.fromEntries(Object.entries(values).map(([key, value]) => {
    if (!value) return [key, null];
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("Enter a valid date and time.");
    const timestamp = new Date(`${value}:00+05:30`);
    if (!Number.isFinite(timestamp.getTime())) throw new Error("Enter a valid date and time.");
    const local = new Date(timestamp.getTime() + 330 * 60000).toISOString().slice(0, 16);
    if (local !== value) throw new Error("Enter a valid date and time.");
    return [key, timestamp.toISOString()];
  })) as Record<keyof typeof values, string | null>;
  if (!parsed.arrival) throw new Error("Enter the vehicle arrival time first.");
  if (values.arrival.slice(0, 10) !== serviceDate) throw new Error("Arrival must be on the selected performance date.");
  if (parsed.clearance && !parsed.unloading) throw new Error("Enter unloading time before station clearance.");
  if (parsed.unloading && parsed.unloading < parsed.arrival) throw new Error("Unloading cannot be before arrival. Check the date for overnight connections.");
  if (parsed.clearance && parsed.unloading && parsed.clearance < parsed.unloading) throw new Error("Station clearance cannot be before unloading.");
  for (const value of Object.values(parsed)) {
    if (value && new Date(value).getTime() - new Date(parsed.arrival).getTime() > 48 * 3600000) throw new Error("A connection must finish within 48 hours of arrival.");
  }
  return parsed;
}

/** Discussion feed: comments / stage completions / system notes only — not RCA or takeaway saves. */
export function discussionFeedUpdates<T extends { id: string; update_type: string; note: string; created_by?: string | null; author_name?: string | null }>(updates: T[]) {
  const seen = new Set<string>();
  return updates.filter((update) => {
    if (update.update_type === "action") return false;
    if (update.update_type === "review" && /^takeaway:\s*/i.test(update.note.trim())) return false;
    const key = `${update.created_by ?? update.author_name ?? ""}|${update.update_type}|${update.note.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function istTimestamp(date: string, time: string | null) {
  if (!time) return null;
  const clock = String(time).slice(0, 8);
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(clock)) return null;
  const normalized = clock.length === 5 ? `${clock}:00` : clock;
  const timestamp = new Date(`${date}T${normalized}+05:30`);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function nextCalendarDay(date: string) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** Rebuild the pre-connections vehicle timings that still live on the review row. */
export function legacyConnectionsFromReview(review: {
  id: string;
  station_id: string;
  source_date: string;
  vehicle_arrival_time: string | null;
  unloading_complete_time: string | null;
  station_clear_time: string | null;
  updated_at: string;
} | null) {
  if (!review?.vehicle_arrival_time) return [] as Array<{
    id: string;
    station_id: string;
    service_date: string;
    label: string;
    arrival_at: string;
    unloading_at: string | null;
    clearance_at: string | null;
    version: number;
    updated_by_name: string;
    updated_at: string;
  }>;
  const arrival = istTimestamp(review.source_date, review.vehicle_arrival_time);
  if (!arrival) return [];
  const unloadingDate = review.unloading_complete_time && review.unloading_complete_time < review.vehicle_arrival_time
    ? nextCalendarDay(review.source_date)
    : review.source_date;
  const unloading = istTimestamp(unloadingDate, review.unloading_complete_time);
  const clearanceBase = review.station_clear_time && review.unloading_complete_time && review.station_clear_time < review.unloading_complete_time
    ? nextCalendarDay(unloadingDate)
    : unloadingDate;
  const clearance = unloading ? istTimestamp(clearanceBase, review.station_clear_time) : null;
  return [{
    id: `legacy-${review.id}`,
    station_id: review.station_id,
    service_date: review.source_date,
    label: "Connection 1",
    arrival_at: arrival,
    unloading_at: unloading,
    clearance_at: clearance,
    version: 1,
    updated_by_name: "Previous entry",
    updated_at: review.updated_at
  }];
}
