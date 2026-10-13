import { firstRelation, loadCodLocations, type CodLocationRow } from './cod';
import type { AuthorizationContext } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';

export function isCodStatusLocation(row: CodLocationRow) {
  const model = firstRelation(row.location_models);
  const provider = firstRelation(row.providers);
  return !row.is_ho && !row.hide_from_location_list && /amazon/i.test(`${provider?.code ?? ''} ${provider?.name ?? ''}`)
    && [model?.code,model?.name].some(value => ['EDSP','XPT','AMXL'].includes(String(value ?? '').trim().toUpperCase()));
}
export async function loadCodStatusLocations(auth: AuthorizationContext) {
  const result = await loadCodLocations(requireCompanyId(auth), auth.locationScopeIds, auth.hasAllLocationAccess);
  if (result.error) throw new Error('Unable to load authorized locations. Please retry.');
  return result.locations.filter(isCodStatusLocation);
}
/** Refresh only needs the authorized station identity, not the whole People hierarchy. */
export async function loadCodStatusLocation(auth: AuthorizationContext, locationId: string) {
  if (!locationId || (!auth.hasAllLocationAccess && !auth.locationScopeIds.includes(locationId))) return null;
  if (!supabaseAdmin) throw new Error('Unable to load authorized locations. Please retry.');
  const result = await supabaseAdmin.from('stations')
    .select('id, station_code, station_name, hide_from_location_list, is_ho, providers (code, name), location_models (code, name)')
    .eq('company_id',requireCompanyId(auth)).eq('id',locationId).eq('is_active',true).maybeSingle();
  if (result.error) throw new Error('Unable to load authorized locations. Please retry.');
  const row = result.data as CodLocationRow | null;
  return row && isCodStatusLocation(row) ? row : null;
}
export async function codStatusPortalStation(auth: AuthorizationContext, location: CodLocationRow) {
  if (!supabaseAdmin) throw new Error('Unable to read COD Master settings. Please retry.');
  const companyId = requireCompanyId(auth);
  const fields = 'portal_station_code, is_active';
  let result = await supabaseAdmin.from('cod_station_settings').select(fields).eq('company_id',companyId).eq('location_id',location.id).maybeSingle();
  if (!result.error && !result.data) result = await supabaseAdmin.from('cod_station_settings').select(fields).eq('company_id',companyId).is('location_id',null).eq('station_code',location.station_code).maybeSingle();
  if (result.error) throw new Error('Unable to read COD Master settings. Please retry.');
  const config = result.data;
  // portal_checks_enabled controls the older scheduled scraper, not an authorized
  // user's on-demand read through the COD worker. Keep that scheduler setting intact.
  if (config?.is_active === false) throw new Error('This location is inactive in COD Master.');
  return String(config?.portal_station_code || location.station_code).trim().toUpperCase();
}
