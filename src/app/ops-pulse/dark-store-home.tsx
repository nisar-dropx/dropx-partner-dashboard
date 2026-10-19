import Link from 'next/link';
import { OpsWorkspaceShortcuts } from '@/components/ops-workspace-shortcuts';
import { Suspense } from 'react';
import { ArrowUpRight, Store, Clock3 } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { hasPermission, type AuthorizationContext } from '@/lib/authorization';
import { todayKolkata, type CodLocationRow } from '@/lib/ops-pulse/cod';
import { validMonth } from '@/lib/finance/pricing';
import { loadDsCommandData } from '@/lib/ops-pulse/ds-command-data';
import { formatDashboardDate } from '@/lib/date-format';
import styles from './dark-store-home.module.css';
import { DarkStoreFilters, DarkStoreRefresh } from './dark-store-controls';
import { loadCpu } from '@/lib/ops-pulse/dark-store';
import { summarizeStoreCpu } from '@/lib/ops-pulse/ds-command-center';
import { OpsCommandAttention } from '@/components/ops-command-attention';
import type { AttentionItem } from '@/lib/ops-pulse/command-attention';

type Props={authorization:AuthorizationContext;locations:CodLocationRow[];searchParams?:{station?:string;month?:string;city?:string}};
const count=(n:number)=>n.toLocaleString('en-IN',{maximumFractionDigits:0});
const date=(v:string)=>formatDashboardDate(v);
const money=(n:number|null)=>n===null?'—':`₹${n.toLocaleString('en-IN',{maximumFractionDigits:2})}`;

async function StoreEconomics({authorization:a,locations,month}:Props&{month:string}){
  if(!hasPermission(a,'cpu_overview','access'))return null;
  const href=`/cpu?period=monthly&month=${month}&scope=${encodeURIComponent(locations.map(l=>l.station_code).join(','))}`;
  try{
    const result=await loadCpu(a,{period:'monthly',month,scope:locations.map(l=>l.station_code).join(',')});
    const total=summarizeStoreCpu(result.rows);
    return <Link prefetch={false} className={styles.sectionCard} href={href}><span>Estimated CPU <ArrowUpRight size={15}/></span><strong>{money(total.cpu)}</strong><small>{total.through?`Through ${date(total.through)}`:`${total.ready}/${result.rows.length} stores have units`} · open costs & sources</small></Link>;
  }catch{return <Link prefetch={false} className={styles.sectionCard} href={href}><span>Estimated CPU <ArrowUpRight size={15}/></span><strong>Unavailable</strong><small>Open CPU to check the source</small></Link>;}
}

export function CommandLoading({label='Loading your store status'}:{label?:string}){
  return <div className={styles.loading} role="status"><span className="page-spinner" aria-hidden="true"/>{label}…</div>;
}

function StoreCommand({authorization:a,locations,month,today}:Props&{month:string;today:string}){
  const data=loadDsCommandData(a,locations,month,today);
  const extraItems=data.then(value=>storeSummary(a,locations,month,today,value).extraItems);
  return <>
    <OpsCommandAttention authorization={a} locations={locations} today={today} mode="amazon_now" extraItems={extraItems}/>
    <p className={styles.eyebrow}>SECTION SNAPSHOTS</p>
    <div className={styles.sectionCards}>
      <Suspense fallback={<CommandLoading label="Loading attendance and units"/>}><StoreSnapshots authorization={a} locations={locations} month={month} today={today} result={data}/></Suspense>
      <Suspense fallback={<CommandLoading label="Loading CPU"/>}><StoreEconomics authorization={a} locations={locations} month={month}/></Suspense>
    </div>
  </>;
}

function storeSummary(a:AuthorizationContext,locations:CodLocationRow[],month:string,today:string,data:Awaited<ReturnType<typeof loadDsCommandData>>) {
  const stores=data.stores;
  const scope=encodeURIComponent(locations.map(l=>l.station_code).join(','));
  const unitHref=hasPermission(a,'cps_inputs','access')?`/cpu/master?month=${month}`:`/cpu?period=monthly&month=${month}&scope=${scope}`;
  const needsUnits=stores.filter(s=>s.units?.status==='missing'||s.units?.status==='behind');
  const needsAttendance=stores.filter(s=>s.people&&(s.people.notReported||s.people.missingOut));
  const needsRoster=stores.filter(s=>s.people?.unplanned);
  const due=stores.reduce((n,s)=>n+(s.people?.due??0),0),reported=stores.reduce((n,s)=>n+(s.people?.dueReported??0),0);
  const entered=stores.filter(s=>s.units?.units!=null).length,units=stores.reduce((n,s)=>n+(s.units?.units??0),0);
  const attendanceHref=`/ops-pulse?view=manpower&date=${today}${needsAttendance[0]?`&location=${needsAttendance[0].id}`:''}`;
  const extraItems:AttentionItem[]=[];
  if(data.canPeople){
    extraItems.push({key:'people',title:'Store attendance',value:data.peopleError?'Unavailable':`${needsAttendance.length} stores to check`,count:needsAttendance.length,detail:'Started shifts without in-punch or ended shifts without out-punch',href:attendanceHref,action:'Open attendance',tone:data.peopleError?'unknown':needsAttendance.length?'action':'clear'});
    if(needsRoster.length)extraItems.push({key:'shift-times',title:'Shift assignments',value:`${needsRoster.length} stores need review`,count:needsRoster.length,detail:'Shift times missing · not counted as absent',href:`/rostering?station=${encodeURIComponent(needsRoster[0].code)}`,action:'Open rostering',tone:'action'});
  }
  if(data.canUnits)extraItems.push({key:'units',title:'Store unit reporting',value:data.unitError?'Unavailable':`${needsUnits.length} stores to update`,count:needsUnits.length,detail:`${month} · cumulative units expected through ${date(data.expectedThrough)}`,href:unitHref,action:'Open unit reports',tone:data.unitError?'unknown':needsUnits.length?'action':'clear'});
  return {extraItems,attendanceHref,unitHref,due,reported,entered,units};
}

async function StoreSnapshots({authorization:a,locations,month,today,result}:Props&{month:string;today:string;result:ReturnType<typeof loadDsCommandData>}) {
  const data=await result;
  const {attendanceHref,unitHref,due,reported,entered,units}=storeSummary(a,locations,month,today,data);
  return <>
    {data.canPeople&&<Link prefetch={false} className={styles.sectionCard} href={attendanceHref}><span>Due shifts reported today <ArrowUpRight size={15}/></span><strong>{data.peopleError?'—':`${count(reported)} / ${count(due)}`}</strong><small>Excludes future shifts and approved leave · open attendance</small></Link>}
    {data.canUnits&&<Link prefetch={false} className={styles.sectionCard} href={unitHref}><span>Processed units · {month} <ArrowUpRight size={15}/></span><strong>{data.unitError||!entered?'—':count(units)}</strong><small>{entered}/{data.stores.length} stores entered · open unit actuals</small></Link>}
  </>;
}

export function DarkStoreHome({authorization:a,locations,searchParams={}}:Props){
  const today=todayKolkata(),month=searchParams.month&&validMonth(searchParams.month)&&searchParams.month<=today.slice(0,7)?searchParams.month:today.slice(0,7);
  const selected=locations.filter(l=>(!searchParams.station||l.station_code===searchParams.station)&&(!searchParams.city||l.city===searchParams.city));
  const scopeLabel=searchParams.station?selected[0]?.station_code||'Store not found':searchParams.city||'All your dark stores';
  const links=[
    ['ops_rostering','Shift Attendance',`/ops-pulse?view=manpower&date=${today}${selected.length===1?`&location=${encodeURIComponent(selected[0].id)}`:''}`],
    ['ops_rostering','Rostering',`/rostering${selected.length===1?`?station=${encodeURIComponent(selected[0].station_code)}`:''}`],
    ['store_audits','Store Audits','/store-audits'],
    ['payment_approvals','Payment Approvals','/payments/approvals'],
    ['cpu_overview','CPU',`/cpu?period=monthly&month=${month}&scope=${encodeURIComponent(selected.map(l=>l.station_code).join(','))}`],
    ['ops_report_bot','Report Bot','/report-bot']
  ].filter(([code])=>hasPermission(a,code,'access'));
  return <AppShell active="Command Center" pageCode="ops_pulse"><div className={styles.command}>
    <header className={styles.hero}><div><p className={styles.eyebrow}><span className={styles.workspaceMark}><Store size={13}/> DS</span> DARK STORE OPERATIONS</p><h1>Command center</h1><p>Your priorities first. Open a section to act or inspect actuals.</p></div><div className={styles.today}><span><Clock3 size={15}/>{date(today)} · IST</span><DarkStoreRefresh/></div></header>
    <OpsWorkspaceShortcuts items={links.map(([,label,href])=>({label,href}))}/>
    <DarkStoreFilters key={`${searchParams.station||''}:${searchParams.city||''}:${month}`} stores={locations.map(l=>({code:l.station_code,name:l.station_name||l.station_code,city:l.city||''}))} station={searchParams.station||''} city={searchParams.city||''} month={month} maxMonth={today.slice(0,7)}/>
    <div className={styles.contextBar}><p><strong>{scopeLabel}</strong><span>{selected.length} stores in view</span></p></div>
    {!selected.length?<div className={styles.notice}>No store in your authorized scope matches this selection. <Link prefetch={false} href="/ops-pulse">View my stores</Link></div>:<Suspense key={`${month}:${searchParams.station||''}:${searchParams.city||''}`} fallback={<CommandLoading/>}><StoreCommand authorization={a} locations={selected} month={month} today={today}/></Suspense>}
  </div></AppShell>;
}
