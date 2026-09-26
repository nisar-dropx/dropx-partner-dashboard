import {getAuthorization,hasPermission} from '@/lib/authorization';
import {supabaseAdmin} from '@/lib/supabase-admin';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 const auth=await getAuthorization();if(!auth?.companyId)return Response.json({error:'Unauthorized'},{status:401});
 if(!hasPermission(auth,'cod_submission','access')&&!hasPermission(auth,'cod_reports','access'))return Response.json({error:'Access denied'},{status:403});
 if(!supabaseAdmin)return Response.json({error:'Database unavailable'},{status:503});
 const id=new URL(request.url).searchParams.get('id');
 const result=await supabaseAdmin.from('cod_daily_exceptions').select('location_id,proof').eq('company_id',auth.companyId).eq('id',id||'').maybeSingle();
 if(result.error||!result.data)return Response.json({error:'Proof not found'},{status:404});
 if(!auth.hasAllLocationAccess&&!auth.locationScopeIds.includes(result.data.location_id))return Response.json({error:'Station access denied'},{status:403});
 const proof=result.data.proof;
 if(proof?.storage_bucket!=='ops-pulse-documents'||!String(proof?.storage_path).startsWith(auth.companyId+'/'))return Response.json({error:'Proof not found'},{status:404});
 const file=await supabaseAdmin.storage.from(proof.storage_bucket).download(proof.storage_path);
 if(file.error||!file.data)return Response.json({error:'Unable to load proof'},{status:503});
 return new Response(await file.data.arrayBuffer(),{headers:{'Content-Type':file.data.type||'image/png','Cache-Control':'private, no-store','Content-Disposition':'inline','X-Content-Type-Options':'nosniff'}});
}
