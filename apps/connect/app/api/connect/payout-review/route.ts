import {NextRequest,NextResponse} from 'next/server';
import {payoutIdentity,loadAssociatePayouts,loadAssociateDisputeHistory} from '@/lib/associate-payouts';
import {supabaseAdmin} from '@/lib/supabase-admin';
import {encodePayoutDisputeReason,legacyPayoutDisputeCategory,normalizePayoutDisputeAreas} from '@/lib/payout-dispute';
import {loadPayoutMappingRevisionState,payoutMappingPublicationState} from '@/lib/payout-mapping-relocks';
import {normalizeGuidedClaim,claimDescription,DISPUTE_ISSUES} from '@/lib/payout-dispute-guide';
import {randomUUID} from 'node:crypto';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie'};
const legacyCategories=new Set(['counts','training','loss','tds','other']);

function text(value:unknown){return typeof value==='string'?value.trim():'';}
function validReason(value:unknown,min:number){const reason=text(value);if(reason.length<min||reason.length>2000)throw new Error(`Enter between ${min} and 2000 characters.`);return reason;}
async function ownReviewPublication(company:string,worker:string,publicationId:string){
 const db=supabaseAdmin!;
 const publication=await db.from('workforce_payout_publications').select('id,payroll_run_id,source_calculated_at,review_until,publication_kind,period_start,period_end,station_id,revision,mapping_relock_id').eq('company_id',company).eq('workforce_id',worker).eq('id',publicationId).maybeSingle();
 if(publication.error)throw new Error('Payout review details could not be verified. Refresh and try again.');
 if(!publication.data)throw new Error('This published payout is unavailable for your account.');
 const mappingRevisions=await loadPayoutMappingRevisionState(db,company,worker);
 const mappingRevision=payoutMappingPublicationState(mappingRevisions,publication.data.period_start,publication.data.period_end,publication.data.station_id,publication.data.mapping_relock_id);
 if(mappingRevision.revisionPending)throw new Error('Workforce is preparing a revised payout after a mapping change. Refresh after it is republished.');
 if(!mappingRevision.visible)throw new Error('This payout moved to another Workforce mapping. Refresh to view the latest payout.');
 if(publication.data.publication_kind==='worksheet'){
  const latest=await db.from('workforce_payout_publications').select('id').eq('company_id',company).eq('workforce_id',worker).eq('publication_kind','worksheet').eq('period_start',publication.data.period_start).eq('period_end',publication.data.period_end).eq('station_id',publication.data.station_id).order('revision',{ascending:false,nullsFirst:false}).order('published_at',{ascending:false,nullsFirst:false}).order('id',{ascending:false}).limit(1).maybeSingle();
  if(latest.error)throw new Error('Payout review details could not be verified. Refresh and try again.');
  if(latest.data?.id!==publication.data.id)throw new Error('A newer payout revision is available. Refresh before raising a dispute.');
  const deadline=Date.parse(String(publication.data.review_until??''));
  if(!Number.isFinite(deadline)||deadline<=Date.now())throw new Error('The review window for this payout has ended.');
  return publication.data;
 }
 const [run,latest]=await Promise.all([
  db.from('workforce_payroll_runs').select('id,status,calculated_at').eq('company_id',company).eq('id',publication.data.payroll_run_id).maybeSingle(),
  db.from('workforce_payout_publications').select('id').eq('company_id',company).eq('workforce_id',worker).eq('payroll_run_id',publication.data.payroll_run_id).order('revision',{ascending:false,nullsFirst:false}).order('published_at',{ascending:false,nullsFirst:false}).order('id',{ascending:false}).limit(1).maybeSingle(),
 ]);
 if(run.error||latest.error)throw new Error('Payout review details could not be verified. Refresh and try again.');
 if(!run.data||latest.data?.id!==publication.data.id)throw new Error('A newer payout revision is available. Refresh before raising a dispute.');
 if(run.data.status!=='review')throw new Error('This payout is not open for disputes.');
 if(!run.data.calculated_at||!publication.data.source_calculated_at||run.data.calculated_at!==publication.data.source_calculated_at)throw new Error('Workforce is preparing a revised amount. Refresh after it is published.');
 const deadline=Date.parse(String(publication.data.review_until??''));
 if(!Number.isFinite(deadline)||deadline<=Date.now())throw new Error('The review window for this payout has ended.');
 return publication.data;
}
export async function GET(request:NextRequest){
 try{const {company,worker,subjectType}=await payoutIdentity(request);if(request.nextUrl.searchParams.get('view')==='disputes')return NextResponse.json({disputes:subjectType==='helper'?[]:await loadAssociateDisputeHistory(company,worker)},{headers});const payouts=await loadAssociatePayouts(company,worker,subjectType);return NextResponse.json({payouts:payouts.map(p=>({...p,bankAccount:p.bankAccount?'•••• '+p.bankAccount.slice(-4):'Not recorded'}))},{headers});}
 catch(e){return NextResponse.json({error:e instanceof Error?e.message:'Unable to load payouts.'},{status:400,headers});}
}
export async function POST(request:NextRequest){
 let uploadedPath:string|null=null;
 try{
  if(request.headers.get('origin')!==request.nextUrl.origin)return NextResponse.json({error:'Invalid request origin'},{status:403,headers});
  const {company,worker,subjectType}=await payoutIdentity(request);
  const multipart=request.headers.get('content-type')?.includes('multipart/form-data');
  const form=multipart?await request.formData():null;
  const body=form?JSON.parse(String(form.get('payload')||'{}')):await request.json();
  if(subjectType==='helper')throw new Error('Helper payout disputes are not available from DropX One. Contact Workforce for assistance.');
  if(body.operation==='reply'){
   const result=await supabaseAdmin!.rpc('workforce_reply_guided_dispute',{p_company:company,p_workforce:worker,p_dispute:text(body.disputeId),p_version:Number(body.version),p_message:validReason(body.message,3)});
   if(result.error)throw new Error(result.error.code==='P0001'?result.error.message:'Reply could not be saved.');
   return NextResponse.json({ok:true},{headers});
  }
  if(body.operation!=='create')throw new Error('Unsupported dispute action.');
   const publicationId=text(body.publicationId);
   await ownReviewPublication(company,worker,publicationId);
   if(body.details){
    const pub=await supabaseAdmin!.from('workforce_payout_publications').select('snapshot').eq('company_id',company).eq('workforce_id',worker).eq('id',publicationId).single();
    if(pub.error)throw new Error('Refresh to load the payout.');
    const details=normalizeGuidedClaim(pub.data.snapshot,body.details);
    const file=form?.get('attachment');
    if(file instanceof File&&file.size){
     if(file.size>4*1024*1024||!['image/jpeg','image/png','image/webp','application/pdf'].includes(file.type))throw new Error('Optional attachment: JPG, PNG, WebP or PDF, up to 4 MB.');
     const bytes=Buffer.from(await file.arrayBuffer());
     const magic=file.type==='application/pdf'?bytes.subarray(0,5).toString()==='%PDF-':file.type==='image/png'?bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a':file.type==='image/jpeg'?bytes[0]===255&&bytes[1]===216:bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
     if(!magic)throw new Error('This attachment does not match its file type.');
     uploadedPath=`${company}/payout-disputes/${worker}/${randomUUID()}`;
     const upload=await supabaseAdmin!.storage.from('employee-profile-documents').upload(uploadedPath,bytes,{contentType:file.type,upsert:false});
     if(upload.error)throw new Error('Attachment could not be uploaded. Retry, or submit without it.');
     details.attachment={path:uploadedPath,name:file.name.replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,120)};
    }
    const area=DISPUTE_ISSUES.find(i=>i.id===details.issue)!.area;
    const category=legacyPayoutDisputeCategory([area]);
    const reason=encodePayoutDisputeReason([area],claimDescription(pub.data.snapshot,details)).slice(0,2000);
    const result=await supabaseAdmin!.rpc('workforce_raise_guided_payout_dispute',{p_company:company,p_workforce:worker,p_publication:publicationId,p_category:category,p_reason:reason,p_details:details});
    if(result.error)throw new Error(result.error.code==='P0001'?result.error.message:'Request could not be saved. Please retry.');
    uploadedPath=null;
    return NextResponse.json({ok:true},{headers});
   }
   const reason=validReason(body.reason,10),areas=normalizePayoutDisputeAreas(body.categories);
   // Keep cached clients from the previous single-select form working during deployment.
   const legacy=text(body.category);
   if(!areas.length&&!legacyCategories.has(legacy))throw new Error('Select at least one area to dispute.');
   const category=areas.length?legacyPayoutDisputeCategory(areas):legacy;
   const encodedReason=areas.length?encodePayoutDisputeReason(areas,reason):reason;
   if(encodedReason.length>2000)throw new Error('Shorten the dispute details so the selected areas and message fit within 2000 characters.');
   const result=await supabaseAdmin!.rpc('workforce_raise_payout_dispute',{p_company:company,p_workforce:worker,p_publication:publicationId,p_category:category,p_reason:encodedReason});
   if(result.error)throw new Error('The dispute could not be sent. Refresh and try again.');
  return NextResponse.json({ok:true},{headers});
 }catch(e){if(uploadedPath)await supabaseAdmin!.storage.from('employee-profile-documents').remove([uploadedPath]);return NextResponse.json({error:e instanceof Error?e.message:'Unable to send dispute.'},{status:400,headers});}
}
