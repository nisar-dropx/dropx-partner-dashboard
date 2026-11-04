import { NextResponse } from 'next/server';
import { scopedRefreshRequest } from '@/lib/ops-pulse/edd-scoped-refresh';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function POST(request: Request) {
  try { return await scopedRefreshRequest(request, 'edd_station_board'); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to queue refresh.' }, { status: 500 }); }
}
