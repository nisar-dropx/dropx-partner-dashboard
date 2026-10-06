import { auditAccess } from '@/lib/fleet/audit-access';
import { loadAuditReport } from '@/lib/fleet/audit-report-data';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=120;
export async function GET(request:Request) {
 const params=new URL(request.url).searchParams,id=params.get('id')||'';
 if(!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({error:'Choose a valid audit.'},{status:400});
 let companyId:string;
 try { ({companyId}=await auditAccess(id)); } catch { return Response.json({error:'Sign in with access to this vehicle audit.'},{status:403}); }
 try {
  const report=await loadAuditReport(companyId,id);
  if(params.get('format')==='pdf') {
   const {renderAuditPdf}=await import('@/lib/fleet/audit-report-pdf');
   const {loadAuditAttachment}=await import('@/lib/fleet/audit-report-media');
   const bytes=await renderAuditPdf(report,e=>loadAuditAttachment(companyId,e.auditId||id,e));
   return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="Audit-${report.vehicleNo.replace(/[^A-Za-z0-9-]/g,'')}-${report.date}.pdf"`,'Cache-Control':'private, no-store'}});
  }
  try { await auditAccess(id,'followup');report.canManageActions=true; } catch {report.canManageActions=false;}
  return Response.json(report,{headers:{'Cache-Control':'private, no-store'}});
 } catch { return Response.json({error:'The audit report could not be prepared. Your audit is saved. Please retry.'},{status:500}); }
}
