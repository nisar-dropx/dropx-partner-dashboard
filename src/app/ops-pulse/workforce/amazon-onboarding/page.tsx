import { AppShell } from '@/components/app-shell';
import { PageHead } from '@/components/page-head';
import { requirePagePermission, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { loadOpsWorkforceLocations } from '@/lib/ops-workforce-locations';
import { workforceStationPolicy } from '@/lib/workforce-register-policy';
import { AmazonDaDesk } from './view';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|undefined>>}) {
  const auth=await requirePagePermission('delivery_associates','access');
  const stations=(await loadOpsWorkforceLocations(requireCompanyId(auth),auth)).filter(s=>workforceStationPolicy(s).requiresStationEmail);
  const params=await searchParams;
  return <AppShell active="Amazon DA Onboarding" pageCode="delivery_associates"><div className="ops-command-center">
    <PageHead eyebrow="Operations" title="Amazon DA onboarding" subtitle="Invitations, onboarding progress and associate status."/>
    <AmazonDaDesk stations={stations.map(s=>({id:s.id,code:s.station_code || ''}))} initialView={params.view==='invite'?'invite':'onboarding'} initialStation={params.station} notice={params.notice} initialError={params.error} canEdit={hasPermission(auth,'delivery_associates','edit') && !auth.readOnly && !auth.isPreview}/>
  </div></AppShell>;
}
