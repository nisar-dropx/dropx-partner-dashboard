import { scopedRefreshRequest } from '@/lib/ops-pulse/edd-scoped-refresh';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request) {
  return scopedRefreshRequest(request, 'edd_station_board');
}
