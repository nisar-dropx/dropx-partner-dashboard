import 'server-only';
import { hasPermission, isCompanyOwner, type AuthorizationContext } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import type { UnplannedFilters, UnplannedWorkspace } from './unplanned-leaves';

/** Reads the same cases as People, with live punch evidence. Never changes HR cases. */
export async function loadOpsUnplannedLeaves(auth: AuthorizationContext, filters: UnplannedFilters): Promise<UnplannedWorkspace> {
  if (!hasPermission(auth, 'ops_unplanned_leaves', 'access')) throw Error('Unplanned Leaves access is required.');
  if (!supabaseAdmin) throw Error('Attendance service unavailable.');
  const allLocations = isCompanyOwner(auth) || auth.hasAllLocationAccess;
  const { data, error } = await supabaseAdmin.rpc('ops_people_unplanned_leave_view', {
    p_company_id: requireCompanyId(auth), p_user_id: auth.userId, p_owner: isCompanyOwner(auth),
    p_all_locations: allLocations, p_location_ids: auth.locationScopeIds,
    p_from: filters.from, p_to: filters.to, p_backlog: filters.backlog
  });
  if (error) throw Error(error.code === '42501' ? 'Your OpsPulse access needs checking. Please contact your administrator.' : 'Attendance could not be loaded. Please retry.');
  if (!data || !Array.isArray(data.rows) || !Array.isArray(data.locations) || !Array.isArray(data.statuses)) throw Error('Attendance response is incomplete.');
  // Fail closed even if the database projection ever regresses. Never send another location to the browser/export.
  const allowed = new Set(auth.locationScopeIds);
  if (!allLocations && (data.rows.some((row: { location_id: string | null }) => !row.location_id || !allowed.has(row.location_id))
    || data.locations.some((location: { id: string }) => !allowed.has(location.id)))) throw Error('Attendance location access could not be verified.');
  return data as UnplannedWorkspace;
}
