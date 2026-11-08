import { AppShell } from '@/components/app-shell';
import { PageHead } from '@/components/page-head';
import { requirePagePermission, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { loadOpsWorkforceLocations } from '@/lib/ops-workforce-locations';
import { workforceStationPolicy } from '@/lib/workforce-register-policy';
import { AmazonDaDesk } from './view';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|undefined>>}) {
  const auth=await requirePagePermission('ops_amazon_da','access');
  const stations=(await loadOpsWorkforceLocations(requireCompanyId(auth),auth)).filter(s=>workforceStationPolicy(s).requiresStationEmail);
  const params=await searchParams;
  return <AppShell active="Amazon DA Onboarding" pageCode="ops_amazon_da"><div className="ops-command-center">
    <PageHead eyebrow="Workforce" title="Amazon DA onboarding" subtitle="Invitations, milestones and approved ID changes."/>
    <AmazonDaDesk stations={stations.map(s=>({id:s.id,code:s.station_code || ''}))} initialView={['invite','approvals','history'].includes(params.view||'')?params.view:'onboarding'} initialStation={params.station} notice={params.notice} initialError={params.error} canEdit={hasPermission(auth,'ops_amazon_da','edit')}/>
  </div></AppShell>;
}
