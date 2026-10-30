import {AppShell} from '@/components/app-shell';
import {PageHead} from '@/components/page-head';
import {financeContext,canWritePricing} from '@/lib/finance/data';
import {loadNowVolumes,locationModel} from '@/lib/finance/business-master';
import {monthEnd,todayIndia,validMonth} from '@/lib/finance/pricing';
import {VolumeEditor} from './editor';
import '../cfo.css';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:{month?:string}}){const c=await financeContext('finance_revenue'),today=todayIndia(),month=validMonth(searchParams.month||'')&&searchParams.month!<=today.slice(0,7)?searchParams.month!:today.slice(0,7),end=monthEnd(month),rows=await loadNowVolumes(c,month+'-01',end);return <AppShell active="Amazon Now Units" pageCode="finance_revenue"><PageHead title="Amazon Now units" subtitle="Enter cumulative units processed through the selected date. UPD is calculated as units divided by elapsed calendar days. Daily P&L is an allocation of this monthly input."/><VolumeEditor key={month} month={month} through={end<today?end:today} rows={rows} stores={c.locations.filter(l=>locationModel(l)==='NOW').map(l=>({code:l.station_code,name:l.station_name||l.station_code}))} canAdd={canWritePricing(c.authorization,0)} canEdit={canWritePricing(c.authorization,1)}/></AppShell>}
