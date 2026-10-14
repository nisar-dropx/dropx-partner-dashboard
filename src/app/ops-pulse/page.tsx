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
  const authorization = await requirePagePermission('ops_pulse','access');
  const companyId = requireCompanyId(authorization);
  const locationsResult = await loadCodLocations(companyId,authorization.locationScopeIds,authorization.hasAllLocationAccess);
  const context = resolveOperatingContext(locationsResult.locations);
  if (locationsResult.error) return <AppShell active="Command Center" pageCode="ops_pulse"><div className={styles.notice} role="alert">Location access could not be loaded. Refresh to retry; no totals are shown.</div></AppShell>;
  if (context.mode==='amazon_now' && searchParams.view!=='manpower') return <DarkStoreHome authorization={authorization} locations={context.selectedLocations} searchParams={searchParams}/>;
  return <AppShell active="Command Center" pageCode="ops_pulse"><Suspense fallback={<CommandLoading label="Loading your command center"/>}>
    {searchParams.view==='manpower' ? <Manpower authorization={authorization} context={context} searchParams={searchParams}/> : <LastMile authorization={authorization} context={context} searchParams={searchParams}/>}
  </Suspense></AppShell>;
}
type ContentProps = {authorization:Awaited<ReturnType<typeof requirePagePermission>>;context:ReturnType<typeof resolveOperatingContext>;searchParams:SearchParams};

async function LastMile({authorization:a,context,searchParams}:ContentProps) {
  const today = todayKolkata();
  let period;
  try { period = cpsPeriod(searchParams.from || searchParams.to ? {period:'custom',from:searchParams.from,to:searchParams.to} : {period:'mtd',date:searchParams.date},today); }
  catch { return <div className={styles.notice} role="alert">Choose a valid date range of up to 93 days, ending on or before today. <Link href="/ops-pulse">Reset dates</Link></div>; }
  const locations = context.selectedLocations;
  const codes = locations.map(l=>l.station_code);
  const result = await loadCommandCenter(a,locations,period,context.mode==='amazon_edsp',today);
  const links = [
    ['performance_review','Review Desk',`/ops-pulse/performance?view=reviews&date=${result.performanceDate}&stations=${encodeURIComponent(codes.join(','))}`],
    ['ops_rostering','Shift attendance','/ops-pulse?view=manpower'],
    ['capacity_overview','Capacity',`/ops-pulse/capacity?stations=${encodeURIComponent(codes.join(','))}`],
    ['delivery_associates','Workforce','/work-force-register'],
    [context.mode==='flipkart_odh_mdh'?'cod_submission':'cod_executive_reconciliation','COD workspace',context.mode==='flipkart_odh_mdh'?'/ops-pulse/cod/submission?client=flipkart':'/ops-pulse/cod/executive-reconciliation?client=amazon'],
  ].filter(([permission])=>hasPermission(a,permission,'access') && (context.mode==='amazon_edsp'||!['performance_review','capacity_overview'].includes(permission)));
  return <div className={styles.command}>
    <header className={styles.hero}><div><p className={styles.eyebrow}>LM · {operatingModeLabel(context.mode).toUpperCase()} · {locations.length} SELECTED LOCATIONS</p><h1>Last Mile command center</h1><p>Operational priorities, service performance and shipment economics.</p></div><form action="/ops-pulse" className={styles.dateForm}><label>From<input type="date" name="from" defaultValue={period.from} max={today} required/></label><label>Through<input type="date" name="to" defaultValue={period.to} max={today} required/></label><button>Refresh</button></form></header>
    <nav className={styles.tools} aria-label="Operational workspaces">{links.map(([,label,href])=><Link key={label} href={href}>{label} ↗</Link>)}{context.mode==='amazon_edsp'&&hasEddAccess(a)&&<Link href="/ops-pulse/edd/flash">Live delivery view ↗</Link>}</nav>
    <Suspense fallback={<CommandLoading label="Checking audits, people and operational queues"/>}><OpsCommandAttention authorization={a} locations={locations} today={today} mode={context.mode} extraItems={commandMetricAttention({...result,period,codes,today})}/></Suspense>
    {!locations.length ? <div className={styles.notice}>No operational locations are assigned to this workspace.</div> : <OpsCommandCenter key={`${period.from}:${period.to}:${codes.join(',')}`} {...result} period={period} codes={codes}/>}
  </div>;
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
    <nav className="ops-dashboard-view-switch" aria-label="OpsPulse dashboard views"><Link href="/ops-pulse">Command center</Link><Link className="active" href="/ops-pulse?view=manpower">Shift attendance</Link></nav>
    <form className="ops-station-manpower-filter" action="/ops-pulse"><input name="view" type="hidden" value="manpower"/><label>Date<input name="date" type="date" defaultValue={date} max={today}/></label><label>Office, station or store<select name="location" defaultValue={location?.id ?? ''}>{available.map(l=><option key={l.id} value={l.id}>{l.station_code} · {l.station_name || l.city || l.station_code}</option>)}</select></label><button>Apply location</button></form>
    {error ? <div className={styles.notice} role="alert">{error}</div> : <OpsStationManpowerBoard canExport={!a.readOnly&&hasPermission(a,'ops_reports','access')} asOf={manpower.asOf} locations={locations} people={manpower.people}/>}
  </div>;
}
