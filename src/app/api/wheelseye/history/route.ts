export const dynamic = "force-dynamic";

import { getWheelseyeAccessToken } from "@/lib/wheelseye";
import { loadWheelseyeMovement } from "@/lib/wheelseye-history";
import { getAuthorization } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { saveDailyWheelseyeKm } from "@/lib/fleet/gps-storage";

export async function GET(request: Request) {
  const authorization = await getAuthorization();
  if (!authorization) return Response.json({ error: "Login required." }, { status: 401 });
  const companyId = requireCompanyId(authorization);
  const url = new URL(request.url);
  const vehicle = (url.searchParams.get("vehicle") ?? "").trim().toUpperCase();
  const date = (url.searchParams.get("date") ?? "").trim();
  if (!vehicle) return Response.json({ error: "Vehicle number is required." }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "Movement date is required." }, { status: 400 });

  const token = await getWheelseyeAccessToken(companyId);
  if (!token) return Response.json({ error: "Wheelseye is disabled or access token is not configured in Settings." }, { status: 400 });

  try {
    const movement = await loadWheelseyeMovement(token, vehicle, date);
    await saveDailyWheelseyeKm(companyId, vehicle, date, movement.summary);
    return Response.json(movement);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to load Wheelseye movement." }, { status: 400 });
  }
}
