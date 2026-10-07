import {AppShell} from '@/components/app-shell';
import {requirePagePermission,hasPermission} from '@/lib/authorization';
import {darkStoreScope} from '@/lib/ops-pulse/dark-store';
import {todayKolkata} from '@/lib/ops-pulse/cod';
import {validMonth,monthEnd} from '@/lib/finance/pricing';
import {VolumeEditor} from './editor';
import './master.css';
export const dynamic='force-dynamic';
export default async function Page({searchParams={}}:{searchParams?:{month?:string}}){
 const a=await requirePagePermission('cps_inputs','access'),c=await darkStoreScope(a),today=todayKolkata(),month=searchParams.month&&validMonth(searchParams.month)?searchParams.month:today.slice(0,7),through=monthEnd(month)<today?monthEnd(month):today;
 const result=c.locations.length?await c.db.from('finance_now_volumes').select('station_code,month,through_date,units,incentive_percent,note,revision').eq('company_id',c.companyId).eq('month',month+'-01').in('station_code',c.locations.map(l=>l.station_code)): {data:[],error:null};
 if(result.error)throw Error('Store units could not be loaded.');
 return <AppShell active="CPU Master & units" pageCode="cps_inputs"><div className="cfo"><h1>Dark Store · CPU Master</h1><p>Enter cumulative processed units for each month. These are shared with Finance P&L. Rates, outsourced contracts and HO allocation are maintained in Finance Business Master.</p><VolumeEditor key={month} month={month} through={through} stores={c.locations.map(l=>({code:l.station_code,name:l.station_name||l.station_code}))} rows={(result.data||[]).map(v=>({...v,month:v.month.slice(0,7)}))} canAdd={hasPermission(a,'cps_inputs','add')} canEdit={hasPermission(a,'cps_inputs','edit')}/></div></AppShell>;
}
