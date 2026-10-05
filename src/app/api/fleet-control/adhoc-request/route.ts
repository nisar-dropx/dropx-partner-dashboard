import {withFleetSystemLog} from '@/lib/fleet/system-log';
import {createFleetBreakdownRequest} from '@/app/payments/requests/actions';
import {getAuthorization,hasPermission} from '@/lib/authorization';
import {requireCompanyId} from '@/lib/company-scope';
import {hasActiveFleetMembership} from '@/lib/fleet-control';
import {supabaseAdmin} from '@/lib/supabase-admin';
export const dynamic='force-dynamic';
export async function GET(){
 const auth=await getAuthorization();
 if(!auth)return Response.json({error:'Sign in to request a vehicle.'},{status:401});
 if(auth.readOnly||!hasPermission(auth,'expense_requests','add'))return Response.json({error:'Expense request access is required.'},{status:403});
 const company=requireCompanyId(auth),db=supabaseAdmin;
 if(!db)return Response.json({error:'Request setup is unavailable.'},{status:503});
 if(!auth.isMasterOwner&&!await hasActiveFleetMembership(company,auth.userId))return Response.json({error:'Fleet access is required.'},{status:403});
 let locations=db.from('stations').select('id,station_code').eq('company_id',company).eq('is_active',true).order('station_code');
 if(!auth.hasAllLocationAccess&&!auth.isMasterOwner)locations=locations.in('id',auth.locationScopeIds);
 const [head,stations,owned]=await Promise.all([
 db.from('payment_heads').select('id,name,payment_head_questions(id,question_text,answer_type,dropdown_options,is_required,field_stage,sort_order,date_rule,date_days)').eq('company_id',company).eq('code','VAN_ADHOC').eq('is_active',true).single(),
 locations,
 db.from('fleet_vehicles').select('station_code').eq('company_id',company).eq('ownership_type','own').eq('deployment_status','deployed')
 ]);
 if(head.error||stations.error||owned.error)return Response.json({error:'Unable to load request setup. Please retry.'},{status:503});
 const ownStations=new Set((owned.data??[]).map(v=>v.station_code));
 return Response.json({headId:head.data.id,stations:stations.data.filter(s=>ownStations.has(s.station_code)),questions:head.data.payment_head_questions.filter(q=>q.sort_order>0&&q.field_stage!=='payment').sort((a,b)=>a.sort_order-b.sort_order)},{headers:{'Cache-Control':'private, no-store'}});
}

export const POST=withFleetSystemLog(async(request:Request)=>{
 if(request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Request origin is not allowed.'},{status:403});
 if(Number(request.headers.get('content-length')||0)>4*1024*1024)return Response.json({error:'Keep uploaded files below 4 MB in total.'},{status:413});
 const auth=await getAuthorization();
 if(!auth||auth.readOnly||!hasPermission(auth,'expense_requests','add'))return Response.json({error:'Expense request access is required.'},{status:403});
 const result=await createFleetBreakdownRequest(await request.formData());
 return Response.json(result,{status:result.error?400:200,headers:{'Cache-Control':'private, no-store'}});
});
