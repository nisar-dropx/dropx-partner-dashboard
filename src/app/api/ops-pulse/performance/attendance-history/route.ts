import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { attendanceHistoryDates } from "@/lib/ops-pulse/review-attendance-history";
import { loadReviewAttendanceHistory } from "@/lib/ops-pulse/review-attendance-history-data";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = {"Cache-Control":"private, no-store"};
export async function GET(request: Request) {
  const auth=await getAuthorization();
  if (!auth || !hasPermission(auth,"performance_review","access")) return Response.json({error:"Review access required."},{status:403,headers});
  const params=new URL(request.url).searchParams, stationCode=params.get("station")??"", date=params.get("date")??"";
  try {
    if (params.getAll("station").length!==1 || params.getAll("date").length!==1 || !/^[A-Z0-9_ -]{2,24}$/.test(stationCode)) throw Error();
    attendanceHistoryDates(date);
    if (date > new Date(Date.now()+330*60000).toISOString().slice(0,10)) throw Error();
  } catch { return Response.json({error:"Choose one valid station and a review date up to today."},{status:400,headers}); }
  const companyId=requireCompanyId(auth), scope=await loadCodLocations(companyId,auth.locationScopeIds,auth.hasAllLocationAccess);
  if (scope.error) return Response.json({error:"Station access could not be checked."},{status:503,headers});
  const station=scope.locations.find(s=>s.station_code===stationCode);
  if (!station) return Response.json({error:"This station is outside your access."},{status:403,headers});
  try { return Response.json(await loadReviewAttendanceHistory(companyId,station,date),{headers}); }
  catch { return Response.json({error:"Attendance history could not be loaded. Please retry."},{status:503,headers}); }
}
