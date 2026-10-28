import { revalidateTag } from "next/cache";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations, todayKolkata } from "@/lib/ops-pulse/cod";
import { isAmazonEdspXptLocation } from "@/lib/ops-pulse/operating-context";
export const dynamic = "force-dynamic";
// One station-day reads Amazon routes and GPS for each associate; allow time.
export const maxDuration = 120;
const workerUrl = () =>
  (process.env.AMAZON_SYNC_WORKER_URL || "https://dropx-amazon-sync.withered-voice-1c40.workers.dev").replace(/\/$/, "");
const adminKey = () =>
  (process.env.AMAZON_SYNC_ADMIN_KEY || process.env.CASH_RECON_ADMIN_KEY || "").trim().replace(/^["']|["']$/g, "");
const day = (s: string, n: number) =>
  new Date(Date.parse(s + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
export async function POST(request: Request) {
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
  const fail = (error: string, status: number) => Response.json({ error }, { status, headers });
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, "capacity_associates", "access")) return fail("Distance access denied.", 403);
  const body: any = await request.json().catch(() => null);
  const stationId = String(body?.stationId || ""), date = String(body?.date || "");
  const today = todayKolkata();
  // Only closed days can settle; the register window is 35 days.
  if (!/^[a-f0-9-]{36}$/i.test(stationId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date > day(today, -1) || date < day(today, -35))
    return fail("Choose a station and a day between yesterday and the last 35 days.", 400);
  const scope = await loadCodLocations(requireCompanyId(auth), auth.locationScopeIds, auth.hasAllLocationAccess);
  if (scope.error) return fail("Station access could not be verified. Please retry.", 500);
  if (!scope.locations.some((s) => s.id === stationId && isAmazonEdspXptLocation(s))) return fail("Station not found.", 404);
  if (!adminKey()) return fail("Amazon sync is not configured. Set AMAZON_SYNC_ADMIN_KEY.", 503);
  try {
    // Road kilometres are calculated by dropx-amazon-sync with MAPBOX_ACCESS_TOKEN
    // and MAPBOX_ACCESS_TOKEN_FALLBACK (quota/rate-limit failover). Ops Pulse does
    // not call Mapbox directly.
    const res = await fetch(`${workerUrl()}/payable-distance/station`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminKey()}`, "content-type": "application/json" },
      body: JSON.stringify({ stationId, dates: [date] }),
      signal: AbortSignal.timeout(110000),
      cache: "no-store",
    });
    if (!res.ok) {
      return fail(
        res.status === 401
          ? "Amazon sync rejected the request. Check the admin key."
          : res.status === 503
            ? "Road routing is unavailable right now. Existing distances were kept; please retry shortly."
            : "Amazon sync failed. Existing distances were kept; please retry.",
        502
      );
    }
    const [result] = (await res.json()) as any[];
    revalidateTag("ops-capacity-distance");
    if (!result || result.outcome !== "done") return fail("Amazon sync failed. Existing distances were kept; please retry.", 502);
    return Response.json({ date, ready: result.ready ?? 0, pending: result.pending ?? 0, frozen: result.frozen ?? 0, busy: result.busy ?? 0, targets: result.targets ?? 0 }, { headers });
  } catch {
    return fail("Amazon sync timed out. Existing distances were kept; please retry.", 504);
  }
}
