import { NextResponse } from 'next/server';
import { getAuthorization, hasPermission } from '@/lib/authorization';
import { fetchCodStatus } from '@/lib/ops-pulse/cash-recon-worker';
import { codStatusPortalStation, loadCodStatusLocation } from '@/lib/ops-pulse/cod-status-server';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
export async function GET(request: Request) {
  try {
    const auth = await getAuthorization();
    if (!auth) return NextResponse.json({ error: 'Session could not be verified. Retry this station; reload if the issue continues.' }, { status: 401 });
    if (!hasPermission(auth, 'cod_reports', 'access')) return NextResponse.json({ error: 'COD reports access required.' }, { status: 403 });
    const url = new URL(request.url);
    const location = await loadCodStatusLocation(auth,url.searchParams.get('location') || '');
    if (!location) return NextResponse.json({ error: 'Location unavailable or outside your access.' }, { status: 403 });
    const stationCode = await codStatusPortalStation(auth, location);
    const snapshot = await fetchCodStatus(stationCode, url.searchParams.get('refresh') === '1');
    if (snapshot.version !== 1 || snapshot.stationCode !== stationCode) throw new Error('The portal returned an unexpected station response. Please retry.');
    return NextResponse.json(snapshot, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('[cod-status]', error instanceof Error ? error.message : 'Source unavailable');
    return NextResponse.json({ error: error instanceof Error && /COD Master|authorized locations|settings/.test(error.message) ? error.message : 'Portal check unavailable. Please retry; existing balances have not been marked cleared.' }, { status: 503 });
  }
}
