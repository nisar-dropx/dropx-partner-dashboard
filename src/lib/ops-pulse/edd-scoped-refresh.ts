import { NextResponse } from 'next/server';
import { getAuthorization } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { requireEddApi, type EddPermissionCode } from './edd-access';
import { loadEddStations } from './edd-stations';
import { queueLoadFlashStations } from './edd-worker';

export async function scopedRefreshRequest(request: Request, permission: EddPermissionCode) {
  const denied = await requireEddApi(permission);
  if (denied) return denied;
  const authorization = await getAuthorization();
  if (!authorization?.companyId) return NextResponse.json({ error: 'Company access required.' }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.stations) || !body.stations.length || body.stations.some((code: unknown) => typeof code !== 'string')) {
    return NextResponse.json({ error: 'Select at least one station.' }, { status: 400 });
  }
  const requested = [...new Set<string>(body.stations.map((code: string) => code.trim().toUpperCase()))];
  const allowed = new Set((await loadEddStations(requireCompanyId(authorization), authorization.locationScopeIds, authorization.hasAllLocationAccess)).map(s => s.code));
  if (requested.some(code => !allowed.has(code))) return NextResponse.json({ error: 'A selected station is outside your access.' }, { status: 403 });
  return NextResponse.json(await queueLoadFlashStations(requested), { status: 202 });
}
