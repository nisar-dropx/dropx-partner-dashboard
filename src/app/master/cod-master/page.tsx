import { cookies } from 'next/headers';
import { AppShell } from '@/components/app-shell';
import { PageHead } from '@/components/page-head';
import { requirePagePermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { loadCodLocations, loadCodStationSettings } from '@/lib/ops-pulse/cod';
import { pickupDefaults } from '@/lib/ops-pulse/cod-pickup';
import { PickupMasterClient } from './pickup-master-client';
export const dynamic = 'force-dynamic';
export default async function CodMasterPage() {
  const auth = await requirePagePermission('cod_master', 'access');
  const companyId = requireCompanyId(auth);
  const [stations, settings] = await Promise.all([
    loadCodLocations(companyId, auth.locationScopeIds, auth.hasAllLocationAccess),
    loadCodStationSettings(companyId, auth.locationScopeIds, auth.hasAllLocationAccess)
  ]);
  let flash: {error?: string; notice?: string} = {};
  try { flash = JSON.parse(cookies().get('dropx_cod_master_flash')?.value || '{}'); } catch {}
  const error = stations.error || settings.error;
  return <AppShell active="COD Pickup Master" pageCode="cod_master">
    <PageHead eyebrow="Ops Masters · COD" title="COD Pickup Master" subtitle="Station pickup schedules and deposit expectations. All pickup times are in IST." />
    {error ? <section className="panel"><div className="panel-body"><h2>Pickup setup could not be loaded</h2><p>Please reload. Existing pickup rules have not been changed.</p></div></section> : <PickupMasterClient
      locations={stations.locations.map(s => ({id: s.id, code: s.station_code, name: s.station_name || '', state: s.state || ''}))}
      rows={settings.rows.filter(r => r.pickup_configured).map(r => ({remittance_variance_tolerance:r.remittance_variance_tolerance ?? pickupDefaults.remittance_variance_tolerance,pickup_window_basis:r.pickup_window_basis || '',recon_age_flag_days:Number(r.recon_age_flag_days),cod_status_max_age_minutes:Number(r.cod_status_max_age_minutes),id:r.id, location_id:r.location_id, station_code:r.station_code || '', state:r.state || '', cms_agency:r.cms_agency || '', agent_name:r.agent_name || '', agent_mobile:r.agent_mobile || '', pickup_rule:r.pickup_rule || '', next_day_preparation_from:r.next_day_preparation_from?.slice(0,5) || '', pickup_window_start:r.pickup_window_start?.slice(0,5) || '', pickup_window_end:r.pickup_window_end?.slice(0,5) || '', updated_at:r.updated_at, portal_station_code:r.portal_station_code || r.station_code || '', portal_check_interval_minutes:Number(r.portal_check_interval_minutes || 30), portal_checks_enabled:!!r.portal_checks_enabled, cod_submission_due_time:r.cod_submission_due_time?.slice(0,5) || '', eod_submission_due_time:r.eod_submission_due_time?.slice(0,5) || '', driver_recon_due_time:r.driver_recon_due_time?.slice(0,5) || '', prepared_deposit_due_time:r.prepared_deposit_due_time?.slice(0,5) || '', escalation_contact:r.escalation_contact || '', escalation_email:r.escalation_email || ''}))}
      canAdd={auth.permissions.cod_master.canAdd} canEdit={auth.permissions.cod_master.canEdit} flash={flash} />}
  </AppShell>;
}
