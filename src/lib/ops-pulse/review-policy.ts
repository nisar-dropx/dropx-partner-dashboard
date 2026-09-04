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
    canEditConnections: editor && (oversight || input.stationUser),
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
