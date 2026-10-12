import { PageHead } from '@/components/page-head';
import { CodSectionTabs } from '@/components/cod-section-tabs';
import { requirePagePermission } from '@/lib/authorization';
import { firstRelation, loadCodStationSettings } from '@/lib/ops-pulse/cod';
import { loadCodStatusLocations } from '@/lib/ops-pulse/cod-status-server';
import { requireCompanyId } from '@/lib/company-scope';
import { pickupPolicy } from '@/lib/ops-pulse/cod-pickup';
import { CodStatusClient } from './status-client';
export const dynamic = 'force-dynamic';
export default async function CodStatusPage() {
  const auth = await requirePagePermission('cod_reports', 'access');
  try {
    const [locations, settings] = await Promise.all([loadCodStatusLocations(auth), loadCodStationSettings(requireCompanyId(auth), auth.locationScopeIds, auth.hasAllLocationAccess)]);
    return <>
      <PageHead eyebrow="Operations · COD" title="COD status" subtitle="DA reconciliation, prepared deposits and remittances — together for each station." />
      <CodSectionTabs active="status" />
      <CodStatusClient locations={locations.map(row => ({ id:row.id,code:row.station_code,name:row.station_name || '',model:firstRelation(row.location_models)?.code || '',region:row.region || row.state || '',manager:row.cluster_manager || '',pickup:pickupPolicy(settings.rows.find(s=>s.location_id===row.id)) }))} />
    </>;
  } catch {
    return <><PageHead title="COD status" subtitle="Locations could not be loaded. Please reload to try again." /><CodSectionTabs active="status" /></>;
  }
}
