import { getAuthorization, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth) return Response.json({ error: 'Login required.' }, { status: 401 });
  if (!['expense_requests', 'payment_requests'].some(p => hasPermission(auth, p, 'add') || hasPermission(auth, p, 'edit'))) return Response.json({ error: 'Request access denied.' }, { status: 403 });
  if (!supabaseAdmin) return Response.json({ error: 'Directory unavailable.' }, { status: 503 });
  const params = new URL(request.url).searchParams, location = params.get('location') ?? '', day = params.get('date') ?? '';
  if (!/^[a-f0-9-]{36}$/i.test(location) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return Response.json({ error: 'Select station and date.' }, { status: 400 });
  const company = requireCompanyId(auth);
  const { data: station, error } = await supabaseAdmin.from('stations').select('id,station_code,station_email,station_manager_email').eq('company_id', company).eq('id', location).eq('is_active', true).maybeSingle();
  if (error || !station) return Response.json({ error: 'Station unavailable.' }, { status: 404 });
  const email = auth.email?.trim().toLowerCase();
  if (!auth.hasAllLocationAccess && !auth.locationScopeIds.includes(location) && !(email && [station.station_email, station.station_manager_email].some(e => e?.trim().toLowerCase() === email))) return Response.json({ error: 'Station outside your access.' }, { status: 403 });
  const result = await supabaseAdmin.rpc('adhoc_driver_request_context', { p_company: company, p_station: location, p_day: day });
  if (result.error) return Response.json({ error: 'Unable to load driver options. Please retry.' }, { status: 503 });
  return Response.json(result.data, { headers: { 'Cache-Control': 'private, no-store' } });
}
