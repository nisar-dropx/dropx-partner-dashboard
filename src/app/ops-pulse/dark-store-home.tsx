import Link from 'next/link';
import { Suspense } from 'react';
import { ArrowUpRight, ClipboardCheck, Users, Package, Sparkles, Store, Clock3 } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { hasPermission, type AuthorizationContext } from '@/lib/authorization';
import { todayKolkata, type CodLocationRow } from '@/lib/ops-pulse/cod';
import { validMonth } from '@/lib/finance/pricing';
import { loadDsApprovals, loadDsCommandData } from '@/lib/ops-pulse/ds-command-data';
import { formatDashboardDate } from '@/lib/date-format';
import styles from './dark-store-home.module.css';
import { DarkStoreActions, DarkStoreFilters, DarkStoreRefresh, type StoreAction } from './dark-store-controls';

type Props = { authorization: AuthorizationContext; locations: CodLocationRow[]; searchParams?: { station?: string; month?: string; city?: string } };
const count = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
const date = (v: string) => formatDashboardDate(v);

export function CommandLoading({ label = 'Loading your store status' }: { label?: string }) {
  return <div className={styles.loading} role="status"><span className="page-spinner" aria-hidden="true" />{label}…</div>;
}

async function ApprovalStrip({ authorization: a }: Pick<Props, 'authorization'>) {
  if (!hasPermission(a, 'payment_approvals', 'access') && !hasPermission(a, 'ops_rostering', 'access')) return null;
  const data = await loadDsApprovals(a);
  return <section className={styles.approvals} aria-label="Your shared approvals">
    {hasPermission(a, 'payment_approvals', 'access') && <Link href="/payments/approvals" className={styles.approvalCard}><span className={styles.icon}><ClipboardCheck size={22} /></span><div><span>Payment approvals</span><strong>{data.payment === null ? 'Unavailable' : `${count(data.payment.count)} pending`}</strong><small>{data.paymentError ? 'Open approvals to retry' : data.payment?.oldest ? `Oldest request · ${date(data.payment.oldest)}` : 'Nothing waiting for your review'}</small></div><ArrowUpRight size={19} /></Link>}
    {hasPermission(a, 'ops_rostering', 'access') && <Link href="/rostering?view=approvals" className={styles.approvalCard}><span className={styles.icon}><Users size={22} /></span><div><span>Roster approvals</span><strong>{data.rosterCount === null ? 'Unavailable' : `${count(data.rosterCount)} pending`}</strong><small>{data.rosterError ? 'Open rostering to retry' : 'Review the plans assigned to you'}</small></div><ArrowUpRight size={19} /></Link>}
    <p className={styles.shared}>Your approvals include both Last Mile and Dark Store requests, regardless of store filters.</p>
  </section>;
}

async function StoreCommand({ authorization: a, locations, month, today }: Props & { month: string; today: string }) {
  const data = await loadDsCommandData(a, locations, month, today);
  const stores = data.stores;
  const reported = stores.reduce((n, s) => n + (s.people?.reported ?? 0), 0);
  const active = stores.reduce((n, s) => n + (s.people?.active ?? 0), 0);
  const due = stores.reduce((n, s) => n + (s.people?.due ?? 0), 0);
  const dueReported = stores.reduce((n, s) => n + (s.people?.dueReported ?? 0), 0);
  const upcoming = stores.reduce((n, s) => n + (s.people?.upcoming ?? 0), 0);
  const working = stores.reduce((n, s) => n + (s.people?.working ?? 0), 0);
  const units = stores.reduce((n, s) => n + (s.units?.units ?? 0), 0);
  const entered = stores.filter(s => s.units?.units !== null && s.units !== null).length;
  const current = stores.filter(s => s.units?.status === 'current').length;
  const coverage = due ? Math.round(dueReported / due * 100) : null;
  const canUpdateUnits = hasPermission(a, 'cps_inputs', 'access');
  const unitHref = canUpdateUnits ? `/cpu/master?month=${month}` : `/cpu?period=monthly&month=${month}`;
  const actions: StoreAction[] = [];
  const missingUnits = stores.filter(s => s.units?.status === 'missing');
  const behindUnits = stores.filter(s => s.units?.status === 'behind');
  if (missingUnits.length) actions.push({ key: 'units', category: 'units', title: `${missingUnits.length} store${missingUnits.length === 1 ? ' needs' : 's need'} unit counts`, detail: `${missingUnits.map(s => s.code).join(', ')} · CPU needs processed units for this month.`, label: canUpdateUnits ? 'Update units' : 'Review CPU', href: unitHref });
  if (behindUnits.length) actions.push({ key: 'behind', category: 'units', title: `Refresh ${behindUnits.length} unit report${behindUnits.length === 1 ? '' : 's'}`, detail: `${behindUnits.map(s => s.code).join(', ')} · Last entry is before ${date(data.expectedThrough)}.`, label: canUpdateUnits ? 'Update reports' : 'Review CPU', href: unitHref });
  for (const s of stores) {
    const p = s.people;
    if (p?.notReported) actions.push({ key: s.code + '-in', category: 'attendance', title: `${s.code} · ${p.notReported} not yet reported`, detail: 'Scheduled shift has started and no in-punch is recorded. Confirm with the store.', label: 'View attendance', href: `/ops-pulse?view=manpower&location=${s.id}` });
    if (p?.missingOut) actions.push({ key: s.code + '-out', category: 'attendance', title: `${s.code} · ${p.missingOut} punch-out${p.missingOut === 1 ? '' : 's'} to check`, detail: 'Scheduled shift has ended with an open attendance record.', label: 'Check punches', href: `/ops-pulse?view=manpower&location=${s.id}` });
    if (p?.unplanned) actions.push({ key: s.code + '-roster', category: 'roster', title: `${s.code} · ${p.unplanned} shift assignment${p.unplanned === 1 ? '' : 's'} to review`, detail: 'No shift time is available for today. These people are not counted as absent.', label: 'Open roster', href: `/rostering?station=${s.code}` });
  }
  const showPeople = data.canPeople;
  const showUnits = data.canUnits;
  return <>
    {(data.peopleError || data.unitError) && <div className={styles.notice} role="alert">{data.peopleError ? 'Attendance could not be loaded. ' : ''}{data.unitError ? 'Unit reports could not be loaded. ' : ''}Unavailable data is not counted as zero. <DarkStoreRefresh /></div>}
    <section className={styles.metrics} aria-label="Store summary">
      <article><Store size={19} /><span>Stores in view</span><strong>{stores.length}</strong><small>{new Set(stores.map(s => s.city)).size} {new Set(stores.map(s => s.city)).size === 1 ? 'city' : 'cities'} · authorized locations</small></article>
      {showPeople && <article><Users size={19} /><span>People reported today</span><strong>{data.peopleError ? '—' : count(reported)}<em>{data.peopleError ? '' : ` / ${count(active)}`}</em></strong><small>{data.peopleError ? 'Attendance unavailable' : `${working} open shifts · ${upcoming} scheduled later`}</small></article>}
      {showUnits && <article><Package size={19} /><span>Processed units · {new Date(month + '-02').toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}</span><strong>{data.unitError || !entered ? '—' : count(units)}</strong><small>{data.unitError ? 'Unit reports unavailable' : `${entered} of ${stores.length} stores have entered units`}</small></article>}
    </section>
    <div className={styles.mainGrid}>
      <DarkStoreActions actions={actions} unavailable={data.peopleError || data.unitError} />
      <aside className={styles.insights}><header><Sparkles size={18} /><h2>At a glance</h2></header>
        {showPeople && <section><h3>Today’s reporting coverage</h3><strong>{data.peopleError || coverage === null ? '—' : `${coverage}%`}</strong><div className={styles.progress} role="img" aria-label={coverage === null ? 'No shifts due yet' : `${coverage}% of people due have reported`}><i style={{ width: `${coverage ?? 0}%` }} /></div><p>{data.peopleError ? 'Attendance is unavailable.' : due ? `${dueReported} of ${due} people whose shift has started have reported.` : 'No scheduled shifts are due yet.'} Excludes future shifts and approved leave.</p></section>}
        {showUnits && <section><h3>Unit reporting readiness</h3><strong>{data.unitError ? '—' : `${current} / ${stores.length}`}</strong><div className={styles.progress} role="img" aria-label={`${current} stores current`}><i style={{ width: `${stores.length ? current / stores.length * 100 : 0}%` }} /></div><p>Stores updated through {date(data.expectedThrough)}. Add missing unit reports to unlock CPU.</p><Link href={hasPermission(a, 'cpu_overview', 'access') ? `/cpu?period=monthly&month=${month}` : unitHref}>Explore cost per unit <ArrowUpRight size={14} /></Link></section>}
        {!showPeople && !showUnits && <p>Store insights appear when your role has access to Rostering or CPU.</p>}
      </aside>
    </div>
    <section className={styles.panel}><header><div><p className={styles.eyebrow}>STORE PULSE</p><h2>Store overview</h2></div><span className={styles.muted}>Expand for details</span></header>
      <div className={styles.storeGrid}>{stores.map(s => <details key={s.id} className={styles.storeCard}><summary><div><b>{s.code}</b><small>{s.name} · {s.city}</small></div><span className={styles.storeState} data-tone={s.units?.status === 'missing' || s.units?.status === 'behind' || s.people?.notReported ? 'attention' : 'neutral'}>{s.units?.status === 'missing' ? 'Units needed' : s.units?.status === 'behind' ? 'Update units' : s.people?.notReported ? 'Check reporting' : 'View details'}<ArrowUpRight size={14} /></span></summary>
        <div className={styles.storeDetail}>
          {showPeople && <><div><span>Reported / active today</span><b>{s.people ? `${s.people.reported} / ${s.people.active}` : 'Unavailable'}</b></div>{s.people && <><div><span>On leave / roster off</span><b>{s.people.leave} / {s.people.off}</b></div><div><span>Shifts starting later</span><b>{s.people.upcoming}</b></div><div><span>Shift time not configured</span><b>{s.people.unplanned}</b></div></>}<Link href={`/ops-pulse?view=manpower&location=${s.id}`}>Attendance details <ArrowUpRight size={14} /></Link><Link href={`/rostering?station=${s.code}`}>Plan shifts <ArrowUpRight size={14} /></Link></>}
          {showUnits && <><div><span>Units entered this month</span><b>{s.units?.units == null ? 'Not entered' : count(s.units.units)}</b></div>{s.units?.through && <><div><span>Data through</span><b>{date(s.units.through)}</b></div><div><span>Average units / day</span><b>{count(s.units.upd ?? 0)}</b></div></>}{hasPermission(a, 'cpu_overview', 'access') && <Link href={`/cpu?station=${s.code}&period=monthly&month=${month}`}>CPU & cost breakdown <ArrowUpRight size={14} /></Link>}</>}
        </div>
      </details>)}</div>
    </section>
    <p className={styles.footnote}>Attendance reflects {date(today)}. Unit totals use each store’s latest entry in the selected month; expand a store to see its cutoff. This view does not change payroll.</p>
  </>;
}

export function DarkStoreHome({ authorization: a, locations, searchParams = {} }: Props) {
  const today = todayKolkata();
  const month = searchParams.month && validMonth(searchParams.month) && searchParams.month <= today.slice(0,7) ? searchParams.month : today.slice(0,7);
  const selected = locations.filter(l => (!searchParams.station || l.station_code === searchParams.station) && (!searchParams.city || l.city === searchParams.city));
  const scopeLabel = searchParams.station ? selected[0]?.station_code || 'Store not found' : searchParams.city || 'All your dark stores';
  const links = [
    ['cpu_overview', 'CPU', '/cpu'], ['ops_rostering', 'Rostering', '/rostering'], ['payment_requests', 'Payments', '/payments/requests'], ['business_documents', 'Business Docs', '/business-documents'], ['ops_reports', 'Reports', '/reports']
  ];
  return <AppShell active="Command Center" pageCode="ops_pulse"><div className={styles.command}>
    <header className={styles.hero}><div><p className={styles.eyebrow}><span className={styles.workspaceMark}><Store size={13} /> DS</span> DARK STORE OPERATIONS</p><h1>Command center</h1><p>Stay on top of your stores, people and daily priorities.</p></div><div className={styles.today}><span><Clock3 size={15} />{date(today)} · IST</span><DarkStoreRefresh /></div></header>
    <DarkStoreFilters key={`${searchParams.station || ''}:${searchParams.city || ''}:${month}`} stores={locations.map(l => ({ code: l.station_code, name: l.station_name || l.station_code, city: l.city || '' }))} station={searchParams.station || ''} city={searchParams.city || ''} month={month} maxMonth={today.slice(0,7)} />
    <div className={styles.contextBar}><p><strong>{scopeLabel}</strong><span>{selected.length} {selected.length === 1 ? 'store' : 'stores'} in view</span></p><nav aria-label="Quick actions">{links.filter(([code]) => hasPermission(a, code, 'access')).map(([code, label, href]) => <Link key={code} href={code === 'cpu_overview' ? `${href}?period=monthly&month=${month}${searchParams.station ? `&station=${encodeURIComponent(searchParams.station)}` : ''}` : href}>{label}<ArrowUpRight size={13} /></Link>)}</nav></div>
    <Suspense fallback={<CommandLoading label="Loading your approvals" />}><ApprovalStrip authorization={a} /></Suspense>
    {!selected.length ? <div className={styles.notice}>No store in your authorized scope matches this selection. <Link href="/ops-pulse">View my stores</Link></div> : <Suspense key={`${month}:${searchParams.station || ''}:${searchParams.city || ''}`} fallback={<CommandLoading />}><StoreCommand authorization={a} locations={selected} month={month} today={today} /></Suspense>}
  </div></AppShell>;
}
