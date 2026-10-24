import { getAuthorization, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { dateKey } from '@/lib/payment-volume';
import { lookupBreakdownVehicle } from '@/lib/adhoc-vehicle-server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth) return Response.json({ error: 'Login required.' }, { status: 401 });
  if (!hasPermission(auth, 'expense_requests', 'add') && !hasPermission(auth, 'payment_requests', 'add')) {
    return Response.json({ error: 'Request access denied.' }, { status: 403 });
  }

  const q = new URL(request.url).searchParams;
  const location = q.get('location') || '';
  const date = q.get('date') || '';
  const vehicleNo = q.get('vehicle_no') || '';
  if (!/^[a-f0-9-]{36}$/i.test(location) || !dateKey(date)) {
    return Response.json({ error: 'Select station and date.' }, { status: 400 });
  }
  if (!auth.hasAllLocationAccess && !auth.locationScopeIds.includes(location)) {
    return Response.json({ error: 'Station outside your access.' }, { status: 403 });
  }

  const company = requireCompanyId(auth);
  const station = await supabaseAdmin!
    .from('stations')
    .select('station_code')
    .eq('company_id', company)
    .eq('id', location)
    .eq('is_active', true)
    .maybeSingle();
  if (!station.data) return Response.json({ error: 'Station unavailable.' }, { status: 404 });

  try {
    const result = await lookupBreakdownVehicle(company, station.data.station_code, date, vehicleNo);
    if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 400 });
    return Response.json(
      {
        ok: true,
        vehicle: {
          id: result.vehicle.id,
          number: result.vehicle.number,
          model: result.vehicle.model,
          status: result.vehicle.status,
          locationType: result.vehicle.locationType ?? null,
          gpsKm: result.vehicle.gpsKm ?? null,
        },
        evidence: result.evidence,
        evidenceLabel: result.evidenceLabel,
      },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch {
    return Response.json({ error: 'Vehicle checks unavailable. Please retry.' }, { status: 503 });
  }
}
