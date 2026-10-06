import {AppShell} from '@/components/app-shell';
import {PageHead} from '@/components/page-head';
import {financeContext,canWritePricing} from '@/lib/finance/data';
import {loadBusinessMaster} from '@/lib/finance/business-master';
import {BusinessMasterEditor} from './editor';
import '../../finance/cfo.css';
export const dynamic='force-dynamic';
export default async function Page(){const c=await financeContext('finance_pricing');const all=await loadBusinessMaster(c);return <AppShell active="Business Cost Master" pageCode="finance_pricing"><PageHead title="Business masters" subtitle="Amazon Now pricing, outsourced costs and overhead allocation. Changes are recorded in the Finance audit trail."/><BusinessMasterEditor records={all.filter(r=>c.authorization.hasAllLocationAccess||!r.data.station_code||c.locations.some(l=>l.station_code===r.data.station_code))} locations={c.locations.map(l=>({code:l.station_code,name:l.station_name||l.station_code,ho:!!l.is_ho}))} canAdd={c.authorization.hasAllLocationAccess&&canWritePricing(c.authorization,0)} canEdit={c.authorization.hasAllLocationAccess&&canWritePricing(c.authorization,1)}/></AppShell>}
