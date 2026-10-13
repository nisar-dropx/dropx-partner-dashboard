import { NextResponse } from 'next/server';
import { getAuthorization, hasPermission } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { loadCodStatusLocations } from '@/lib/ops-pulse/cod-status-server';
import { loadCodStationTeam } from '@/lib/ops-pulse/cod-station-team';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function GET(request:Request) {
  const auth=await getAuthorization();
  if(!auth || !hasPermission(auth,'cod_reports','access')) return NextResponse.json({error:'COD reports access required.'},{status:403});
  try {
    const id=new URL(request.url).searchParams.get('location');
    const locations=await loadCodStatusLocations(auth);
    if(!id || !locations.some(location=>location.id===id)) return NextResponse.json({error:'Location unavailable or outside your access.'},{status:403});
    return NextResponse.json(await loadCodStationTeam(requireCompanyId(auth),id),{headers:{'Cache-Control':'private, no-store'}});
  } catch(error) {
    console.error('[cod-station-team]',error instanceof Error?error.message:'People unavailable');
    return NextResponse.json({error:'Team details could not be loaded. Please retry.'},{status:503});
  }
}
