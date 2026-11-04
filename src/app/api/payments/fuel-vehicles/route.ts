import { getAuthorization, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { vehiclePaymentPolicy } from '@/lib/vehicle-payment';
import { readAllRows } from '@/lib/supabase-pagination';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth) return Response.json({ error: 'Login required.' }, { status: 401 });
  if (!['expense_requests', 'payment_requests'].some(page => hasPermission(auth, page, 'add') || hasPermission(auth, page, 'edit'))) return Response.json({ error: 'Request access denied.' }, { status: 403 });
  if (!supabaseAdmin) return Response.json({ error: 'Vehicle directory unavailable.' }, { status: 503 });
  const location = new URL(request.url).searchParams.get('location') ?? '';
  if (!/^[a-f0-9-]{36}$/i.test(location)) return Response.json({ error: 'Select a station.' }, { status: 400 });
  const head = new URL(request.url).searchParams.get('head') ?? 'VAN_FUEL';
  const policy = vehiclePaymentPolicy(head);
  if (!policy) return Response.json({ error: 'This payment head does not use Fleet vehicles.' }, { status: 400 });
  const company = requireCompanyId(auth);
  const { data: station, error } = await supabaseAdmin.from('stations').select('id,station_code,station_email,station_manager_email').eq('company_id', company).eq('id', location).eq('is_active', true).maybeSingle();
  if (error || !station) return Response.json({ error: 'Station unavailable.' }, { status: 404 });
  const email = auth.email?.trim().toLowerCase();
  if (!auth.hasAllLocationAccess && !auth.locationScopeIds.includes(location) && !(email && [station.station_email, station.station_manager_email].some(value => value?.trim().toLowerCase() === email))) return Response.json({ error: 'Station outside your access.' }, { status: 403 });
  try {
    let query = supabaseAdmin.from('fleet_vehicles').select('id,vehicle_no,model').eq('company_id', company).eq('station_code', station.station_code);
    if (policy === 'own') query = query.eq('ownership_type', 'own');
    const result = await readAllRows(query.order('vehicle_no').order('id'));
    if (result.error) throw result.error;
    return Response.json({ vehicles: result.data ?? [] }, { headers: { 'Cache-Control': 'private, no-store' } });
  }
  catch { return Response.json({ error: 'Unable to load vehicles. Please retry.' }, { status: 503 }); }
}
