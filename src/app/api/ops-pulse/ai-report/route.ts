import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { loadCodLocations } from "@/lib/ops-pulse/cod";
import { resolveOperatingContext } from "@/lib/ops-pulse/operating-context";
import { assistantCatalog } from "@/lib/ops-pulse/assistant-policy";
import { verifyAssistantReport } from "@/lib/ops-pulse/assistant-report-token";
import { assistantReportFormats, exportAssistantReport } from "@/lib/ops-pulse/assistant-report-export";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const headers={"Cache-Control":"private, no-store","Vary":"Cookie"};
export async function POST(request:Request){
 const auth=await getAuthorization();
 if(!auth)return Response.json({error:"Please sign in again."},{status:401,headers});
 if(!hasPermission(auth,"ops_pulse","access"))return Response.json({error:"OpsPulse access is required."},{status:403,headers});
 try{
  if(Number(request.headers.get("content-length")||0)>1_600_000)return Response.json({error:"Report is too large."},{status:413,headers});
  const raw=await request.text();if(raw.length>1_600_000)return Response.json({error:"Report is too large."},{status:413,headers});
  const body=JSON.parse(raw);
  if(!assistantReportFormats.includes(body.format))return Response.json({error:"Choose PDF, Word, Excel or PNG."},{status:400,headers});
  const companyId=requireCompanyId(auth),locations=await loadCodLocations(companyId,auth.locationScopeIds,auth.hasAllLocationAccess);
  if(locations.error)throw Error("Location scope could not be verified.");
  const context=resolveOperatingContext(locations.locations),darkStore=context.mode==="amazon_now";
  const report=verifyAssistantReport(body.token,process.env.ASSISTANT_REPORT_SECRET||process.env.SUPABASE_SERVICE_ROLE_KEY||"",{userId:auth.userId,companyId,stationIds:context.selectedLocations.map(l=>l.id),darkStore},assistantCatalog(code=>hasPermission(auth,code,"access"),darkStore).map(tool=>tool.name));
  const result=await exportAssistantReport(report,body.format);
  return new Response(new Uint8Array(result.bytes),{headers:{...headers,"Content-Type":result.mime,"Content-Disposition":`attachment; filename="opspulse-insights-${report.checkedAt.slice(0,10)}.${body.format}"`}});
 }catch(error){return Response.json({error:error instanceof Error?error.message:"Report could not be generated."},{status:400,headers});}
}
