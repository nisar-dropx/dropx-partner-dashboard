import { getAuthorization } from '@/lib/authorization';
import { validateReportRange } from '@/lib/fleet/daily-report';
import { FleetReportError, loadDailyReport } from '@/lib/fleet/report-data';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth) return Response.json({ error: 'Login required.' }, { status: 401 });
  const params = new URL(request.url).searchParams;
  const from = params.get('from') ?? '', to = params.get('to') ?? '';
  const error = validateReportRange(from, to);
  if (error) return Response.json({ error }, { status: 400 });
  try { return Response.json(await loadDailyReport(auth, from, to), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (error) { return Response.json({ error: error instanceof FleetReportError ? error.message : 'Unable to load fleet report.' }, { status: error instanceof FleetReportError ? error.status : 500 }); }
}
