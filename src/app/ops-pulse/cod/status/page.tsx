import { PageHead } from '@/components/page-head';
import { CodSectionTabs } from '@/components/cod-section-tabs';
import { requirePagePermission } from '@/lib/authorization';
import { firstRelation, loadCodStationSettings } from '@/lib/ops-pulse/cod';
import { loadCodStatusLocations } from '@/lib/ops-pulse/cod-status-server';
import { requireCompanyId } from '@/lib/company-scope';
import { pickupDefaults, pickupPolicy } from '@/lib/ops-pulse/cod-pickup';
import { codStatusOwner } from '@/lib/ops-pulse/cod-status';
import { codCmsContact } from '@/lib/ops-pulse/cod-cms-followup';
import { loadCodTeamDirectory } from '@/lib/ops-pulse/cod-station-team';
import { isStationLead } from '@/lib/ops-pulse/cod-station-team-core';
import { CodStatusClient } from './status-client';
export const dynamic = 'force-dynamic';
export default async function CodStatusPage() {
  const auth = await requirePagePermission('cod_reports', 'access');
  try {
    const [locations, settings] = await Promise.all([loadCodStatusLocations(auth), loadCodStationSettings(requireCompanyId(auth), auth.locationScopeIds, auth.hasAllLocationAccess)]);
    if(settings.error) throw new Error('COD settings unavailable');
    let teamUnavailable=false;
    const team=await loadCodTeamDirectory(requireCompanyId(auth),locations.map(l=>l.id)).catch(error=>{console.error('[cod-team-leads]',error);teamUnavailable=true;return [];});
    return <>
      <PageHead eyebrow="Operations · COD" title="COD status" subtitle="DA reconciliation, prepared deposits and remittances — together for each station." />
      <CodSectionTabs active="status" />
      <CodStatusClient locations={locations.map(row => {
        const setting = settings.rows.find(s=>s.location_id===row.id);
        return { id:row.id,code:row.station_code,name:row.station_name || '',model:firstRelation(row.location_models)?.code || '',region:row.region || row.state || '',...codStatusOwner(row),teamUnavailable,
          leads:team.filter(person=>person.locationId===row.id && isStationLead(person)).map(({name,role,phone})=>({name,role,phone})),
          pickup:pickupPolicy(setting),cmsContact:codCmsContact(setting),ageFlagDays:setting?.recon_age_flag_days ?? pickupDefaults.recon_age_flag_days,
          maxAgeMinutes:setting?.cod_status_max_age_minutes ?? pickupDefaults.cod_status_max_age_minutes,reconDueTime:setting ? setting.driver_recon_due_time?.slice(0,5) || null : pickupDefaults.driver_recon_due_time };
      })} />
    </>;
  } catch {
    return <><PageHead title="COD status" subtitle="Locations could not be loaded. Please reload to try again." /><CodSectionTabs active="status" /></>;
  }
}
