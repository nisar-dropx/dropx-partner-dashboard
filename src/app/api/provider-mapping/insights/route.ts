import { NextResponse } from 'next/server';
import { getAuthorization, hasPermission } from '@/lib/authorization';
import { providerMappingPageCodeForCurrentHost } from '@/lib/provider-mapping-access';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { readAllRows } from '@/lib/supabase-pagination';
import { todayKolkata } from '@/lib/ops-pulse/cod';
import { loadWorkforcePayoutRows } from '@/lib/workforce-payout-loader';
import { buildProviderMappingInsights, insightPeriod } from '@/lib/provider-mapping-insights';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reply = (body: unknown, status = 200) => NextResponse.json(body, {status, headers: {'Cache-Control': 'private, no-store'}});

export async function GET(request: Request) {
  try {
    const auth = await getAuthorization();
    if (!auth) return reply({error: 'Sign in to view deliveries and cost.'}, 401);
    const page = providerMappingPageCodeForCurrentHost();
    if (!page || !auth.companyId || !hasPermission(auth, page, 'access')) return reply({error: 'ID mapping access is required.'}, 403);
    if (!supabaseAdmin) return reply({error: 'Insights are temporarily unavailable.'}, 503);
    const params = new URL(request.url).searchParams;
    const stationId = params.get('stationId') ?? '';
    const providerId = params.get('providerId') ?? '';
    const memberId = (params.get('memberId') ?? '').trim();
    const period = insightPeriod(params.get('month') ?? '', todayKolkata());
    if (!uuid.test(stationId) || !uuid.test(providerId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(memberId) || !period) return reply({error: 'Choose a valid ID, location and month.'}, 400);
    const all = auth.hasAllLocationAccess || auth.isMasterOwner || auth.roleCode === 'OWNER';
    if (!all && !auth.locationScopeIds.includes(stationId)) return reply({error: 'This location is outside your scope.'}, 403);
    const [station, provider] = await Promise.all([
      supabaseAdmin.from('stations').select('id,station_code').eq('company_id', auth.companyId).eq('id', stationId).maybeSingle(),
      supabaseAdmin.from('providers').select('id,code,name').eq('company_id', auth.companyId).eq('id', providerId).maybeSingle()
    ]);
    if (station.error || provider.error) throw new Error('Directory unavailable');
    if (!station.data || !provider.data) return reply({error: 'ID location or provider is unavailable.'}, 404);
    const normalize = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const providerIdentity = normalize(`${provider.data.code} ${provider.data.name}`);
    const [shipmentResult, mappingResult] = await Promise.all([
      readAllRows(supabaseAdmin.from('cps_shipment_daily').select('work_date,total_delivery,amazon_delivery,swa_delivery,provider_employee_name,client').eq('company_id', auth.companyId).eq('station_code', station.data.station_code).eq('provider_employee_id', memberId).gte('work_date', period.from).lte('work_date', period.to).order('work_date').order('client')),
      readAllRows(supabaseAdmin.from('field_executive_provider_mappings').select('id,workforce_id,employee_id,contractor_id,field_executive_id,effective_from,effective_to').eq('company_id', auth.companyId).eq('station_id', stationId).eq('provider_id', providerId).eq('provider_member_id', memberId).in('status', ['active', 'closed']).lte('effective_from', period.to).or(`effective_to.is.null,effective_to.gte.${period.from}`).order('id'))
    ]);
    if (shipmentResult.error || mappingResult.error) throw new Error('Sources unavailable');
    const shipments = (shipmentResult.data ?? []).filter(row => row.client && providerIdentity.includes(normalize(row.client)));
    const latest = shipments.map(row => row.work_date).sort().at(-1);
    const mappings = mappingResult.data ?? [];
    const sourceIds = [...new Set(mappings.flatMap(row => [row.workforce_id, row.employee_id, row.contractor_id, row.field_executive_id]).filter(Boolean))];
    let payRows: Awaited<ReturnType<typeof loadWorkforcePayoutRows>>['rows'] = [];
    let costError: string | null = null;
    if (sourceIds.length && latest) {
      const [byId, bySource] = await Promise.all([
        supabaseAdmin.from('workforce').select('id').eq('company_id', auth.companyId).in('id', sourceIds),
        supabaseAdmin.from('workforce').select('id').eq('company_id', auth.companyId).in('source_profile_id', sourceIds)
      ]);
      if (byId.error || bySource.error) throw new Error('People unavailable');
      const workforceIds = [...new Set([...(byId.data ?? []), ...(bySource.data ?? [])].map(row => row.id))];
      const calculated = await loadWorkforcePayoutRows(auth.companyId, {...auth, hasAllLocationAccess: false, locationScopeIds: [stationId]}, period.from, latest, {workforceIds, includeLossRecoveries: false, providerCostSegmentsOnly: true, providerDailyCostBasis: 'delivery_days'});
      const mappingIds = new Set(mappings.map(row => row.id));
      payRows = calculated.rows.filter(row => mappingIds.has(row.id) && row.locationId === stationId && row.providerMemberId === memberId);
      if (calculated.error) costError = 'Pay calculation needs review. Open the payout worksheet for details.';
    }
    return reply({ ...buildProviderMappingInsights({...period, shipments, payRows, costError}),
      name: shipments.at(-1)?.provider_employee_name ?? '', station: station.data.station_code, provider: provider.data.name });
  } catch { return reply({error: 'Could not load delivery insights. Please retry.'}, 503); }
}
