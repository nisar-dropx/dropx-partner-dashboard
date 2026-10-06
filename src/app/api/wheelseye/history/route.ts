export const dynamic = "force-dynamic";

import { getWheelseyeAccessToken } from "@/lib/wheelseye";
import { loadWheelseyeMovement } from "@/lib/wheelseye-history";
import { getAuthorization } from "@/lib/authorization";
import { FleetReportError, trackingScope } from "@/lib/fleet/report-data";
import { validateReportRange } from "@/lib/fleet/daily-report";
import { saveDailyWheelseyeKm } from "@/lib/fleet/gps-storage";

export async function GET(request: Request) {
  const authorization = await getAuthorization();
  if (!authorization) return Response.json({ error: "Login required." }, { status: 401 });
  let companyId: string;
  const url = new URL(request.url);
  const vehicle = (url.searchParams.get("vehicle") ?? "").trim().toUpperCase();
  const date = (url.searchParams.get("date") ?? "").trim();
  if (!vehicle) return Response.json({ error: "Vehicle number is required." }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "Movement date is required." }, { status: 400 });

  try {
    const scope = await trackingScope(authorization); companyId = scope.companyId;
    if (!scope.vehicles.some(v=>v.vehicle_no===vehicle)) return Response.json({error:"Vehicle is outside your permitted locations."},{status:403});
    const error=validateReportRange(date,date); if(error)return Response.json({error},{status:400});
  } catch(error) {return Response.json({error:error instanceof FleetReportError?error.message:"Unable to check Fleet access."},{status:error instanceof FleetReportError?error.status:500});}
  const token = await getWheelseyeAccessToken(companyId);
  if (!token) return Response.json({ error: "Wheelseye is disabled or access token is not configured in Settings." }, { status: 400 });

  try {
    const movement = await loadWheelseyeMovement(token, vehicle, date);
    if (!authorization.readOnly) await saveDailyWheelseyeKm(companyId, vehicle, date, movement.summary);
    const {progress,...base}=movement;
    return Response.json(url.searchParams.get("detail")==="day"?movement:base, {headers:{"Cache-Control":"private, no-store"}});
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to load Wheelseye movement." }, { status: 400 });
  }
}
