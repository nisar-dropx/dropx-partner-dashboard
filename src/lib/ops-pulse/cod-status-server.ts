import { firstRelation, loadCodLocations, loadCodStationSettings, type CodLocationRow } from './cod';
import type { AuthorizationContext } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';

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
export async function codStatusPortalStation(auth: AuthorizationContext, location: CodLocationRow) {
  const settings = await loadCodStationSettings(requireCompanyId(auth), auth.locationScopeIds, auth.hasAllLocationAccess);
  if (settings.error) throw new Error('Unable to read COD Master settings. Please retry.');
  const config = settings.rows.find(row => row.location_id === location.id || (!row.location_id && row.station_code === location.station_code));
  if (config && (config.is_active === false || config.portal_checks_enabled === false)) throw new Error('Portal checks are disabled in COD Master for this location.');
  return String(config?.portal_station_code || location.station_code).trim().toUpperCase();
}
