import {NextRequest,NextResponse} from 'next/server';
import {requireBetaPrivateAccount} from '@/lib/beta-private-account';

export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store',Vary:'Cookie'};
export async function POST(request:NextRequest){
  let context;
  try{context=await requireBetaPrivateAccount(request);}
  catch{return NextResponse.json({error:'Sign in to your own beta account.'},{status:403,headers});}
  const {account,db}=context;
  try{
    const body=await request.json();
    if(body.action!=='submitted')return NextResponse.json({error:'Unsupported action.'},{status:400,headers});
    // A declaration only. Never update a provider snapshot or mark UAN verified.
    const result=await db.from('workforce_beta_verification_events').insert({company_id:account.companyId,candidate_id:account.id,event:'uan_submission_reported',detail:{source:'candidate'}});
    if(result.error)throw new Error('Save failed');
    return NextResponse.json({ok:true},{headers});
  }catch{return NextResponse.json({error:'Could not save your update. Please retry.'},{status:503,headers});}
}
