import 'server-only';
import { hasPermission, type AuthorizationContext } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { readAllRows } from '@/lib/supabase-pagination';
import { getPaymentApprovalEligibility, type PaymentApprovalScopeRequest } from '@/lib/payment-approval-scope';
import { isPendingPaymentApproval } from '@/lib/payment-pending-approval';
import { loadAssignedOpsRosterApprovals } from './rostering';
import { loadOpsStationManpower } from './station-manpower';
import { locationModelName, type CodLocationRow } from './cod';
import { summarizeStorePeople, summarizeStoreUnits, type DsUnitRecord } from './ds-command-center';

export function commandStoreScope(a: AuthorizationContext, locations: CodLocationRow[]) {
  return locations.filter(l => !l.is_ho && !l.hide_from_location_list && locationModelName(l).toUpperCase() === 'NOW' && (a.hasAllLocationAccess || a.locationScopeIds.includes(l.id)));
}

export async function loadDsApprovals(a: AuthorizationContext) {
  const companyId = requireCompanyId(a);
  async function payments() {
    if (!hasPermission(a, 'payment_approvals', 'access')) return null;
    if (!supabaseAdmin) throw Error('Payments are unavailable.');
    let query = supabaseAdmin.from('payment_requests').select('id,location_id,requested_by,status,approval_status,current_approver_user_id,current_approver_role_id,current_approver_role_ids,created_at,stations(location_model_id)').eq('company_id', companyId).order('id');
    if (!a.hasAllLocationAccess) query = query.in('location_id', a.locationScopeIds.length ? a.locationScopeIds : ['00000000-0000-0000-0000-000000000000']);
    const result = await readAllRows(query);
    if (result.error) throw Error('Payments are unavailable.');
    const pending = (result.data || []).filter(isPendingPaymentApproval).map(r => ({ ...r, location_model_id: (Array.isArray(r.stations) ? r.stations[0] : r.stations)?.location_model_id ?? null })) as (PaymentApprovalScopeRequest & { created_at: string })[];
    const eligible = await getPaymentApprovalEligibility(companyId, a, pending);
    const rows = pending.filter(r => eligible.has(r.id));
    return { count: rows.length, oldest: rows.map(r => r.created_at).sort()[0] ?? null };
  }
  const [payment, roster] = await Promise.allSettled([
    payments(),
    hasPermission(a, 'ops_rostering', 'access') ? loadAssignedOpsRosterApprovals(a) : Promise.resolve(null)
  ]);
  return {
    payment: payment.status === 'fulfilled' ? payment.value : null,
    paymentError: payment.status === 'rejected',
    rosterCount: roster.status === 'fulfilled' && roster.value !== null ? new Set(roster.value.map(r => r.planId)).size : null,
    rosterError: roster.status === 'rejected'
  };
}

export async function loadDsCommandData(a: AuthorizationContext, locations: CodLocationRow[], month: string, today: string) {
  const scoped = commandStoreScope(a, locations), companyId = requireCompanyId(a);
  const canUnits = hasPermission(a, 'cpu_overview', 'access') || hasPermission(a, 'cps_inputs', 'access');
  const canPeople = hasPermission(a, 'ops_rostering', 'access');
  const monthEnd = new Date(Date.UTC(Number(month.slice(0,4)), Number(month.slice(5,7)), 0)).toISOString().slice(0,10);
  // Today is still in progress. Cumulative unit reporting is checked through yesterday.
  const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 86400000).toISOString().slice(0,10);
  const expectedThrough = monthEnd < yesterday ? monthEnd : yesterday < month + '-01' ? month + '-01' : yesterday;
  const [volume, manpower] = await Promise.allSettled([
    (async () => {
      if (!canUnits) return null;
      if (!supabaseAdmin) throw Error('Unit reports are unavailable.');
      if (!scoped.length) return [] as DsUnitRecord[];
      const result = await readAllRows(supabaseAdmin.from('finance_now_volumes').select('station_code,month,through_date,units').eq('company_id', companyId).eq('month', month + '-01').in('station_code', scoped.map(l => l.station_code)).order('station_code'));
      if (result.error) throw Error('Unit reports are unavailable.');
      return result.data as DsUnitRecord[];
    })(),
    canPeople ? loadOpsStationManpower(companyId, scoped, today) : Promise.resolve(null)
  ]);
  const unitRows = volume.status === 'fulfilled' ? volume.value : null;
  const people = manpower.status === 'fulfilled' ? manpower.value?.people ?? null : null;
  const now = Date.now();
  return {
    expectedThrough, canUnits, canPeople,
    unitError: volume.status === 'rejected', peopleError: manpower.status === 'rejected',
    stores: scoped.map(l => ({
      id: l.id, code: l.station_code, name: l.station_name || l.station_code, city: l.city || 'City not set',
      units: unitRows === null ? null : summarizeStoreUnits(unitRows.find(v => v.station_code === l.station_code), expectedThrough),
      people: people === null ? null : summarizeStorePeople(people.filter(p => p.locationId === l.id), now)
    }))
  };
}
