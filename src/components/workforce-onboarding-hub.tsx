import {AppShell} from '@/components/app-shell';
import {getAuthorization,requirePagePermission,hasPermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {loadOpsWorkforceLocations} from '@/lib/ops-workforce-locations';
import {workforceStationPolicy} from '@/lib/workforce-register-policy';
import {DAOnboardingWorkspace} from '@/components/da-onboarding-workspace';
import {WorkforceLifecycleDesk} from '@/components/workforce-lifecycle-desk';
import Link from 'next/link';
import {redirect} from 'next/navigation';
export type OnboardingHubParams=Record<string,string|undefined>;
export async function WorkforceOnboardingHub({params={}}:{params?:OnboardingHubParams}){
 const auth=await requirePagePermission('workforce_onboarding','access');
 const stations=await loadOpsWorkforceLocations(requireCompanyId(auth),auth);
 const editable=!auth.readOnly&&!auth.isPreview;
 // Preserve old bookmarked review links without mixing exits into DA onboarding.
 if(params.tab==='lifecycle')return <AppShell active="Workforce onboarding" pageCode="workforce_onboarding"><Link href="/workforce/onboarding">← Workforce onboarding</Link><WorkforceLifecycleDesk/></AppShell>;
 if(!stations.some(s=>workforceStationPolicy(s).requiresStationEmail))redirect('/unauthorized?page=ops_amazon_da&reason=location');
 return <AppShell active="Workforce onboarding" pageCode="workforce_onboarding"><div className="ops-command-center"><DAOnboardingWorkspace initialTab={params.tab} stations={stations.map(s=>({id:s.id,code:s.station_code||'',provider:(Array.isArray(s.providers)?s.providers[0]:s.providers)?.name||'Provider not set',supported:workforceStationPolicy(s).requiresStationEmail}))} initialStation={params.station} initialStations={params.stations?.split(',')} initialView={params.view} canEdit={editable&&hasPermission(auth,'workforce_onboarding','edit')&&hasPermission(auth,'ops_amazon_da','edit')} canAdd={editable&&hasPermission(auth,'workforce_onboarding','add')&&hasPermission(auth,'delivery_associates','add')} canManage={editable&&hasPermission(auth,'workforce_onboarding','edit')&&hasPermission(auth,'delivery_associates','edit')} canAmazon={hasPermission(auth,'ops_amazon_da','access')}/></div></AppShell>;
}
