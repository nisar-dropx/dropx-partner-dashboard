import { getAuthorization, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { dateKey, shiftDay } from '@/lib/payment-volume';
import { loadPaymentVolume, paymentVolumeToday } from '@/lib/payment-volume-data';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth) return Response.json({ error: 'Login required.' }, { status: 401 });
  if (!hasPermission(auth, 'expense_requests', 'add') && !hasPermission(auth, 'payment_requests', 'add')) {
    return Response.json({ error: 'Payment request access denied.' }, { status: 403 });
  }
  const params = new URL(request.url).searchParams;
  const location = params.get('location') ?? '', date = params.get('date') ?? '';
  const today = paymentVolumeToday();
  if (!/^[a-f0-9-]{36}$/i.test(location) || !dateKey(date) || date < shiftDay(today, -366) || date > shiftDay(today, 31)) {
    return Response.json({ error: 'Select a valid station and deployment date within the past year or next month.' }, { status: 400 });
  }
  if (!auth.hasAllLocationAccess && !auth.locationScopeIds.includes(location)) {
    return Response.json({ error: 'Station outside your access.' }, { status: 403 });
  }
  if (!supabaseAdmin) return Response.json({ error: 'Volume data unavailable.' }, { status: 503 });
  const company = requireCompanyId(auth);
  const station = await supabaseAdmin.from('stations').select('station_code').eq('company_id', company).eq('id', location).eq('is_active', true).maybeSingle();
  if (station.error || !station.data) return Response.json({ error: 'Station unavailable.' }, { status: 404 });
  try {
    const data = await loadPaymentVolume(company, station.data.station_code, date, today);
    return Response.json(data, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json({ error: 'Unable to load volume evidence. You can retry without losing the request.' }, { status: 503 });
  }
}
