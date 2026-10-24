import { OpsWorkspaceShortcuts } from '@/components/ops-workspace-shortcuts';
import { OpsCommandDateRange } from '@/components/ops-command-date-range';
import { Suspense } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell';
import { PageHead } from '@/components/page-head';
import { OpsCommandAttention } from '@/components/ops-command-attention';
import { OpsStationManpowerBoard } from '@/components/ops-station-manpower-board';
import { OpsCommandCenter } from '@/components/ops-command-center';
import { hasPermission, requirePagePermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { loadCodLocations, todayKolkata } from '@/lib/ops-pulse/cod';
import { operatingModeLabel, resolveOperatingContext } from '@/lib/ops-pulse/operating-context';
import { cpsPeriod, isoDate } from '@/lib/ops-pulse/cps';
import { loadCommandCenter } from '@/lib/ops-pulse/command-center-data';
import { commandMetricAttention } from '@/lib/ops-pulse/command-center';
import { loadOpsStationManpower } from '@/lib/ops-pulse/station-manpower';
import { hasEddAccess } from '@/lib/ops-pulse/edd-access';
import { DarkStoreHome, CommandLoading } from './dark-store-home';
import styles from './command-center.module.css';

type SearchParams = { station?:string; month?:string; city?:string; date?:string; from?:string; to?:string; view?:string; location?:string };
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export default async function OpsPulsePage({searchParams = {}}:{searchParams?:SearchParams}) {
  const pageCode = searchParams.view === 'manpower' ? 'ops_rostering' : 'ops_pulse';
  const active = searchParams.view === 'manpower' ? 'Shift Attendance' : 'Command Center';
  const authorization = await requirePagePermission(pageCode,'access');
  const companyId = requireCompanyId(authorization);
  const locationsResult = await loadCodLocations(companyId,authorization.locationScopeIds,authorization.hasAllLocationAccess);
  const context = resolveOperatingContext(locationsResult.locations);
  if (locationsResult.error) return <AppShell active={active} pageCode={pageCode}><div className={styles.notice} role="alert">Location access could not be loaded. Refresh to retry; no totals are shown.</div></AppShell>;
  if (context.mode==='amazon_now' && searchParams.view!=='manpower') return <DarkStoreHome authorization={authorization} locations={context.selectedLocations} searchParams={searchParams}/>;
  return <AppShell active={active} pageCode={pageCode}><Suspense fallback={<CommandLoading label="Loading your command center"/>}>
    {searchParams.view==='manpower' ? <Manpower authorization={authorization} context={context} searchParams={searchParams}/> : <LastMile authorization={authorization} context={context} searchParams={searchParams}/>}
  </Suspense></AppShell>;
}
type ContentProps = {authorization:Awaited<ReturnType<typeof requirePagePermission>>;context:ReturnType<typeof resolveOperatingContext>;searchParams:SearchParams};

function LastMile({authorization:a,context,searchParams}:ContentProps) {
  const today = todayKolkata();
  let period;
  try { period = cpsPeriod(searchParams.from || searchParams.to ? {period:'custom',from:searchParams.from,to:searchParams.to} : {period:'mtd',date:searchParams.date},today); }
  catch { return <div className={styles.notice} role="alert">Choose a valid date range of up to 93 days, ending on or before today. <Link prefetch={false} href="/ops-pulse">Reset dates</Link></div>; }
  const locations = context.selectedLocations;
  const codes = locations.map(l=>l.station_code);
  const insightStation = locations.find(l=>l.station_code===searchParams.station)?.station_code ?? '';
  const attentionLocations = insightStation ? locations.filter(l=>l.station_code===insightStation) : locations;
  const attentionCodes = attentionLocations.map(l=>l.station_code);
  const stations = locations.filter(l=>!l.is_ho&&!l.hide_from_location_list).map(l=>({code:l.station_code,name:l.station_name||l.city||l.station_code}));
  const result = loadCommandCenter(a,locations,period,context.mode==='amazon_edsp',today);
  const performanceDate = new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  const links = [
    ['ops_rostering','Shift Attendance',`/ops-pulse?view=manpower&date=${today}${attentionLocations.length===1?`&location=${encodeURIComponent(attentionLocations[0].id)}`:locations.length===1?`&location=${encodeURIComponent(locations[0].id)}`:''}`],
    ['performance_review','Review Desk',`/ops-pulse/performance?view=reviews&date=${performanceDate}&stations=${encodeURIComponent(attentionCodes.join(','))}`],
    [context.mode==='flipkart_odh_mdh'?'cod_submission':'cod_executive_reconciliation','COD workspace',context.mode==='flipkart_odh_mdh'?'/ops-pulse/cod/submission?client=flipkart':'/ops-pulse/cod/executive-reconciliation?client=amazon'],
    ['capacity_overview','Capacity',`/ops-pulse/capacity?stations=${encodeURIComponent(attentionCodes.join(','))}`],
    ['delivery_associates','Workforce','/work-force-register'],
    ['payment_approvals','Payment Approvals','/payments/approvals'],
  ].filter(([permission])=>hasPermission(a,permission,'access') && (context.mode==='amazon_edsp'||!['performance_review','capacity_overview'].includes(permission)));
  return <div className={styles.command}>
    <header className={styles.hero}><div><p className={styles.eyebrow}>LM · {operatingModeLabel(context.mode).toUpperCase()} · {locations.length} SELECTED LOCATIONS</p><h1>Last Mile command center</h1><p>Operational priorities, service performance and shipment economics.</p></div><OpsCommandDateRange from={period.from} to={period.to} today={today} station={insightStation||undefined}/></header>
    <OpsWorkspaceShortcuts items={[...links.map(([,label,href])=>({label,href})),...(context.mode==='amazon_edsp'&&hasEddAccess(a)?[{label:'Live delivery view',href:'/ops-pulse/edd/flash'}]:[])]}/>
    <Suspense key={`attention:${insightStation||'all'}:${period.from}:${period.to}`} fallback={<CommandLoading label="Checking audits, people and operational queues"/>}><OpsCommandAttention authorization={a} locations={attentionLocations} today={today} mode={context.mode} station={insightStation} stations={stations} range={{from:period.from,to:period.to}} extraItems={result.then(data=>commandMetricAttention({...data,period,codes:attentionCodes,today}))}/></Suspense>
    {!locations.length ? <div className={styles.notice}>No operational locations are assigned to this workspace.</div> : <Suspense key={`${period.from}:${period.to}:${codes.join(',')}`} fallback={<CommandLoading label="Loading shipment and cost summaries"/>}><LastMileSnapshots result={result} period={period} codes={codes}/></Suspense>}
  </div>;
}

async function LastMileSnapshots({result,period,codes}:{result:ReturnType<typeof loadCommandCenter>;period:Parameters<typeof loadCommandCenter>[2];codes:string[]}) {
  return <OpsCommandCenter {...await result} period={period} codes={codes}/>;
}

async function Manpower({authorization:a,context,searchParams}:ContentProps) {
  const companyId = requireCompanyId(a), today=todayKolkata();
  const date = isoDate(searchParams.date) && searchParams.date<=today ? searchParams.date : today;
  const available = context.modeLocations;
  const location = available.find(l=>l.id===searchParams.location) ?? context.selectedLocations[0] ?? null;
  const locations = location ? [location] : [];
  let manpower:Awaited<ReturnType<typeof loadOpsStationManpower>>={asOf:date,people:[]};
  let error='';
  if (!hasPermission(a,'ops_rostering','access')) return <div className={styles.notice}>Shift attendance requires Rostering access.</div>;
  try { manpower=await loadOpsStationManpower(companyId,locations,date); }
  catch { error='Attendance could not be loaded. Refresh to retry.'; }
  return <div className="ops-command-center"><PageHead eyebrow="Live workforce · scope controlled" title="Shift Attendance" subtitle="Scheduled shifts, reporting times and attendance exceptions."/>
    <nav className="ops-dashboard-view-switch" aria-label="OpsPulse dashboard views">{hasPermission(a,'ops_pulse','access')&&<Link prefetch={false} href="/ops-pulse">Command center</Link>}<Link prefetch={false} className="active" href="/ops-pulse?view=manpower">Shift attendance</Link></nav>
    <form className="ops-station-manpower-filter" action="/ops-pulse"><input name="view" type="hidden" value="manpower"/><label>Date<input name="date" type="date" defaultValue={date} max={today}/></label><label>Office, station or store<select name="location" defaultValue={location?.id ?? ''}>{available.map(l=><option key={l.id} value={l.id}>{l.station_code} · {l.station_name || l.city || l.station_code}</option>)}</select></label><button>Apply location</button></form>
    {error ? <div className={styles.notice} role="alert">{error}</div> : <OpsStationManpowerBoard canExport={!a.readOnly&&hasPermission(a,'ops_reports','access')} asOf={manpower.asOf} locations={locations} people={manpower.people}/>}
  </div>;
}
