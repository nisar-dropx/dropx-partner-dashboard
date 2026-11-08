import {AppShell} from '@/components/app-shell';
import {getAuthorization,requirePagePermission,hasPermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {loadOpsWorkforceLocations} from '@/lib/ops-workforce-locations';
import {workforceStationPolicy} from '@/lib/workforce-register-policy';
import {DAOnboardingDesk} from '@/components/da-onboarding-desk';
import {WorkforceLifecycleDesk} from '@/components/workforce-lifecycle-desk';
import Link from 'next/link';
import {redirect} from 'next/navigation';
export type OnboardingHubParams=Record<string,string|undefined>;
export async function WorkforceOnboardingHub({params={}}:{params?:OnboardingHubParams}){
 let auth=await getAuthorization();
 if(!auth||(!hasPermission(auth,'delivery_associates','access')&&!hasPermission(auth,'ops_amazon_da','access')))auth=await requirePagePermission('delivery_associates','access');
 const stations=await loadOpsWorkforceLocations(requireCompanyId(auth),auth);
 const editable=!auth.readOnly&&!auth.isPreview;
 // Preserve old bookmarked review links without mixing exits into DA onboarding.
 if(params.tab==='lifecycle')return <AppShell active="DA onboarding" pageCode="delivery_associates"><Link href="/workforce/onboarding">← DA onboarding</Link><WorkforceLifecycleDesk/></AppShell>;
 if(!stations.some(s=>workforceStationPolicy(s).requiresStationEmail))redirect('/unauthorized?page=ops_amazon_da&reason=location');
 return <AppShell active="DA onboarding" pageCode={hasPermission(auth,'delivery_associates','access')?'delivery_associates':'ops_amazon_da'}><div className="ops-command-center"><DAOnboardingDesk stations={stations.map(s=>({id:s.id,code:s.station_code||'',provider:(Array.isArray(s.providers)?s.providers[0]:s.providers)?.name||'Provider not set',supported:workforceStationPolicy(s).requiresStationEmail}))} initialStation={params.station} initialStations={params.stations?.split(',')} initialView={params.view} canEdit={editable&&hasPermission(auth,'ops_amazon_da','edit')} canAdd={editable&&hasPermission(auth,'delivery_associates','add')} canAmazon={hasPermission(auth,'ops_amazon_da','access')}/></div></AppShell>;
}
