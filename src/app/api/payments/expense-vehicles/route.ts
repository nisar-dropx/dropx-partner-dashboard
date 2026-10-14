import { getAuthorization, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { expenseVehicles } from '@/lib/payment-expense-vehicles';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth) return Response.json({ error: 'Please sign in again.' }, { status: 401 });
  if (!hasPermission(auth, 'expense_requests', 'add') && !hasPermission(auth, 'payment_requests', 'add'))
    return Response.json({ error: 'Request access denied.' }, { status: 403 });
  const location = new URL(request.url).searchParams.get('location') ?? '';
  if (!/^[a-f0-9-]{36}$/i.test(location)) return Response.json({ error: 'Choose a station.' }, { status: 400 });
  const company = requireCompanyId(auth);
  const station = await supabaseAdmin!.from('stations').select('station_code,station_email,station_manager_email')
    .eq('company_id', company).eq('id', location).eq('is_active', true).maybeSingle();
  if (station.error) return Response.json({ error: 'Stations unavailable. Please retry.' }, { status: 503 });
  if (!station.data) return Response.json({ error: 'Station unavailable.' }, { status: 404 });
  const email = auth.email?.trim().toLowerCase();
  const emailAccess = email && [station.data.station_email, station.data.station_manager_email].some(v => v?.trim().toLowerCase() === email);
  if (!auth.hasAllLocationAccess && !auth.locationScopeIds.includes(location) && !emailAccess)
    return Response.json({ error: 'Station outside your access.' }, { status: 403 });
  try {
    return Response.json({ vehicles: await expenseVehicles(company, station.data.station_code) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json({ error: 'Vehicles could not be loaded. Please retry.' }, { status: 503 });
  }
}
