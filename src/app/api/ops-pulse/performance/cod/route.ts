import { getAuthorization,hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { loadReviewCod } from "@/lib/ops-pulse/review-cod-data";
import { filterReviewCod, groupReviewCodAssociates, readCodFilters, summarizeReviewCod } from "@/lib/ops-pulse/review-cod";
import { workbookResponse } from "@/lib/report-workbook";

export const dynamic="force-dynamic";
export const maxDuration=60;
export async function GET(request:Request) {
  const auth=await getAuthorization();
  if(!auth||!hasPermission(auth,"performance_review","access"))return Response.json({error:"Review access denied."},{status:403});
  const url=new URL(request.url);
  const station=url.searchParams.get("station")||"",batch=url.searchParams.get("batch")||"";
  if(!/^[A-Z0-9]{2,16}$/.test(station)||!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(batch))return Response.json({error:"Select one station and a valid report."},{status:400});
  const companyId=requireCompanyId(auth);
  const scope=await loadCodLocations(companyId,auth.locationScopeIds,auth.hasAllLocationAccess);
  if(scope.error)return Response.json({error:"Station access could not be verified."},{status:503});
  if(!scope.locations.some(location=>location.station_code===station))return Response.json({error:"You do not have access to this station."},{status:403});
  const {snapshot,lines:allLines}=await loadReviewCod(companyId,station,batch);
  if(snapshot.error||!snapshot.summary)return Response.json({error:snapshot.error||"Report unavailable."},{status:503});
  let filters;
  try { filters=readCodFilters(url.searchParams,allLines); }
  catch(e) {return Response.json({error:e instanceof Error?e.message:"Invalid COD filter."},{status:400});}
  const lines=filterReviewCod(allLines,filters);
  const summary=summarizeReviewCod(lines);
  if(url.searchParams.get("format")!=="xlsx")return Response.json({snapshot:{...snapshot,summary},lines},{headers:{"Cache-Control":"no-store"}});
  const associates=groupReviewCodAssociates(lines);
  return workbookResponse([
    {name:"Summary",rows:[{Station:station,"Snapshot imported":snapshot.importedAt,"Source file":snapshot.fileName,"Ageing filter":filters.bucket||"All ageing","Date filter":filters.day||"All dates","DA filter":filters.associate?associates[0]?.name:"All DAs","Station total pending":snapshot.summary.total,"Total pending":summary.total,"Aged 2+ days":summary.overdueAmount,"Tracking IDs":summary.tidCount,"Source lines":summary.lineCount,"Report batch":snapshot.batchId,"Basis":"Latest imported outstanding position, not historical review-day balance. Age bands as supplied by Amazon. Repeated TIDs retain all source order lines."}]},
    {name:"Ageing",rows:summary.buckets.map(group=>({Station:station,Age:group.label,"Pending amount":group.amount,"Source lines":group.lines,"Aged 2+ days":group.overdue?"Yes":"No"}))},
    {name:"Day-wise",rows:summary.days.map(group=>({Station:station,"Cash date":group.label,"Pending amount":group.amount,"Source lines":group.lines}))},
    {name:"DA-wise",rows:associates.map(row=>({Station:station,Associate:row.name,"Associate ID":row.id,"Pending amount":row.amount,"Aged 2+ days":row.overdueAmount,"Tracking IDs":row.tidCount}))},
    {name:"TID detail",rows:lines.map(line=>({Station:station,"Source row":line.rowNumber,"Tracking ID":line.trackingId,"Order ID":line.orderId,Associate:line.associate,"Associate ID":line.associateId,"Cash date":line.pendingDate,"Source age":line.bucket,Status:line.status,"Pending amount":line.amount,"Aged 2+ days":line.overdue?"Yes":"No"}))}
  ],`cod-pending-${station}-${snapshot.importedAt?.slice(0,10)}.xlsx`);
}
