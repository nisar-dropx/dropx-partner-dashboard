import { cookies } from 'next/headers';
import { getAuthorization, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { loadCodLocations } from '@/lib/ops-pulse/cod';
import { locationsForMode, operatingModes, type OperatingMode } from '@/lib/ops-pulse/operating-context';

export const dynamic = 'force-dynamic';
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

// Save only the preference here. Rendering the next dashboard in a separate
// navigation avoids re-rendering the outgoing dashboard in a Server Action.
export async function POST(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'Invalid request origin.' }, 403);
  try {
    const authorization = await getAuthorization();
    if (!authorization || !hasPermission(authorization, 'ops_pulse', 'access')) return reply({ error: 'Sign in to open this workspace.' }, 403);
    const form = await request.formData();
    const mode = String(form.get('mode') || '') as OperatingMode;
    if (!operatingModes.some(entry => entry.code === mode)) return reply({ error: 'Select a valid workspace.' }, 400);
    const { locations } = await loadCodLocations(requireCompanyId(authorization), authorization.locationScopeIds, authorization.hasAllLocationAccess);
    const permitted = locationsForMode(locations.filter(location => !location.is_ho && !location.hide_from_location_list && (authorization.hasAllLocationAccess || authorization.locationScopeIds.includes(location.id))), mode);
    if (!permitted.length) return reply({ error: 'This workspace has no locations in your access.' }, 403);
    const options = { httpOnly: true, maxAge: 60 * 60 * 24 * 90, path: '/', sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production' };
    cookies().set('dropx-ops-mode', mode, options);
    cookies().set('dropx-ops-location', permitted[0].id, options);
    cookies().set('dropx-ops-locations', permitted.map(location => location.id).join(','), options);
    return reply({ ok: true });
  } catch {
    return reply({ error: 'The workspace could not be opened. Please try again.' }, 503);
  }
}
