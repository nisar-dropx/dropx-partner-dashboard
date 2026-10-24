export type DocumentScope = { scope_type: string; scope_id: string | null; additional_scope_ids?: string[] | null };
type Location = { id: string; state?: string | null; provider_id?: string | null };
/** Company documents are shared; geographic/provider documents must intersect the workspace. */
export function documentInWorkspace(document: DocumentScope, locations: Location[]) {
  if (!locations.length) return false;
  if (document.scope_type === "company") return true;
  const ids = [document.scope_id, ...(document.additional_scope_ids ?? [])].filter(Boolean) as string[];
  if (document.scope_type === "location") return locations.some(l => ids.includes(l.id));
  if (document.scope_type === "provider") return locations.some(l => l.provider_id && ids.includes(l.provider_id));
  if (document.scope_type === "state") return locations.some(l => ids.some(id => id.trim().toUpperCase() === l.state?.trim().toUpperCase()));
  return false;
}
