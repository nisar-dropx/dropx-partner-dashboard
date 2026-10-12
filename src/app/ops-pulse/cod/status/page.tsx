import { PageHead } from '@/components/page-head';
import { CodSectionTabs } from '@/components/cod-section-tabs';
import { requirePagePermission } from '@/lib/authorization';
import { firstRelation } from '@/lib/ops-pulse/cod';
import { loadCodStatusLocations } from '@/lib/ops-pulse/cod-status-server';
import { CodStatusClient } from './status-client';
export const dynamic = 'force-dynamic';
export default async function CodStatusPage() {
  const auth = await requirePagePermission('cod_reports', 'access');
  try {
    const locations = await loadCodStatusLocations(auth);
    return <>
      <PageHead eyebrow="Operations · COD" title="COD status" subtitle="DA reconciliation, prepared deposits and remittances — together for each station." />
      <CodSectionTabs active="status" />
      <CodStatusClient locations={locations.map(row => ({ id:row.id,code:row.station_code,name:row.station_name || '',model:firstRelation(row.location_models)?.code || '',region:row.region || row.state || '',manager:row.cluster_manager || '' }))} />
    </>;
  } catch {
    return <><PageHead title="COD status" subtitle="Locations could not be loaded. Please reload to try again." /><CodSectionTabs active="status" /></>;
  }
}
