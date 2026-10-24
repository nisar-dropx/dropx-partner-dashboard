import { getAuthorization, hasPermission } from '@/lib/authorization';
import { configuration, latestHeartbeat, saveSource, snapshot } from '@/lib/mail-health/server';
export const dynamic='force-dynamic';
export const maxDuration=300;
async function authorize(edit=false){const auth=await getAuthorization();return auth?.companyId&&hasPermission(auth,'mail_health',edit?'edit':'view')?auth:null;}
export async function GET(request:Request){
 const auth=await authorize();if(!auth)return Response.json({error:'Mail Health access is required.'},{status:403});
 try{const mode=new URL(request.url).searchParams.get('mode');return Response.json(mode==='heartbeat'?await latestHeartbeat(auth.companyId!):mode==='settings'?await configuration(auth.companyId!):await snapshot(auth.companyId!));}
 catch(error){return Response.json({error:error instanceof Error?error.message:'Mail Health is unavailable.'},{status:503});}
}
export async function POST(request:Request){
 const auth=await authorize(true);if(!auth||auth.isPreview)return Response.json({error:'Mail Health edit access is required.'},{status:403});
 if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Invalid request origin.'},{status:403});
 try{const body=await request.json();await saveSource(auth.companyId!,auth.userId,body.source,body.revision??null);return Response.json({saved:true});}
 catch(error){return Response.json({error:error instanceof Error?error.message:'Settings could not be saved.'},{status:400});}
}
