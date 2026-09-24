import { getAuthorization } from '@/lib/authorization';
import { saveDailyWheelseyeKm } from '@/lib/fleet/gps-storage';
import { getWheelseyeAccessToken } from '@/lib/wheelseye';
import { loadWheelseyeMovement } from '@/lib/wheelseye-history';
import { validDate, istDate, shiftDay } from '@/lib/fleet/daily-report';
import { FleetReportError, reportScope } from '@/lib/fleet/report-data';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export async function POST(request: Request) {
  const auth = await getAuthorization();
  if (!auth) return Response.json({ error: 'Login required.' }, { status: 401 });
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  try {
    const scope = await reportScope(auth);
    if (auth.isPreview) throw new FleetReportError('Exit user preview before refreshing GPS.', 403);
    const body = await request.json().catch(() => null);
    const pairs = body?.pairs as Array<{ vehicle: string; date: string }> | undefined;
    const today = istDate();
    if (!Array.isArray(pairs) || !pairs.length || pairs.length > 12 || pairs.some(p => !p || typeof p.vehicle !== 'string' || typeof p.date !== 'string' || !validDate(p.date) || p.date > today || p.date < shiftDay(today, -31))) throw new FleetReportError('Refresh up to 12 vehicle-days per batch, within the last 31 days.', 400);
    const allowed = new Set(scope.vehicles.map(v => v.vehicle_no));
    if (pairs.some(p => !allowed.has(p.vehicle))) throw new FleetReportError('One or more vehicles are outside your permitted locations.', 403);
    const token = await getWheelseyeAccessToken(scope.companyId);
    if (!token) throw new FleetReportError('GPS connection is unavailable. Check WheelsEye settings.', 503);
    const results: Array<{ vehicle: string; date: string; status: string }> = [];
    const unique = [...new Map(pairs.map(p => [`${p.vehicle}|${p.date}`, p])).values()];
    for (let offset = 0; offset < unique.length; offset += 3) {
      const batch = await Promise.all(unique.slice(offset, offset + 3).map(async pair => {
        try {
          const movement = await loadWheelseyeMovement(token, pair.vehicle, pair.date);
          return { ...pair, status: await saveDailyWheelseyeKm(scope.companyId, pair.vehicle, pair.date, movement.summary) };
        } catch { return { ...pair, status: 'gps_failed' }; }
      }));
      results.push(...batch);
    }
    return Response.json({ results }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return Response.json({ error: error instanceof FleetReportError ? error.message : 'Unable to refresh GPS. Please try again.' }, { status: error instanceof FleetReportError ? error.status : 500 }); }
}
