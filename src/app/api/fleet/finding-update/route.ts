import {withFleetSystemLog} from '@/lib/fleet/system-log';
import {saveFindingUpdate} from '@/lib/fleet/finding-actions';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const POST=withFleetSystemLog(async(request:Request)=>{
 try{return Response.json(await saveFindingUpdate(await request.json()));}
 catch(e){return Response.json({error:e instanceof Error?e.message:'Update failed. Your remarks are preserved; retry.'},{status:400});}
});
