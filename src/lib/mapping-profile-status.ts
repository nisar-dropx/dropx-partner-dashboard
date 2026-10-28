export type MappingProfileState = "completed" | "pending" | "review" | "unknown";
export function mappingProfileState(status?: string | null): MappingProfileState {
  const value = String(status || "").trim().toLowerCase();
  if (value === "active") return "completed";
  if (["under_review", "submitted", "approved"].includes(value)) return "review";
  if (["pending", "returned", "rejected"].includes(value)) return "pending";
  return "unknown";
}
export const mappingProfileLabels = {
  completed: "Profile completed", pending: "Profile pending", review: "Awaiting review / activation", unknown: "Profile status unavailable",
};

/** Apply only after the Workforce loader has enforced the user's scope. */
export function filterMappingProfiles<T extends {id: string; registrationStatus?: string | null}>(
  rows: T[], profile?: string, ids?: string,
) {
  const selectedIds = ids === undefined ? null : new Set(ids.split(",").filter(Boolean));
  const state = profile && Object.hasOwn(mappingProfileLabels, profile) ? profile : null;
  return rows.filter(row => (!selectedIds || selectedIds.has(row.id))
    && (!state || mappingProfileState(row.registrationStatus) === state));
}

export function mappingProfileWorkspaceLinks(ids: string[], profile: string) {
  const uniqueIds = [...new Set(ids)];
  return Array.from({length: Math.ceil(uniqueIds.length / 150)}, (_, index) => {
    const start = index * 150;
    const batch = uniqueIds.slice(start, start + 150);
    return {
      href: "/work-force-register?" + new URLSearchParams({section: "register", profile, ids: batch.join(",")}),
      label: uniqueIds.length <= 150 ? `Open ${batch.length} in Workforce workspace ↗`
        : `Open profiles ${start + 1}–${start + batch.length} in Workforce ↗`,
    };
  });
}
