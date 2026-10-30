import { NextRequest, NextResponse } from 'next/server';
import { requireBetaPrivateAccount } from '@/lib/beta-private-account';
import { loadBetaWorkforceIdentity } from '@/lib/beta-workforce-identity';
import { loadBetaAttendanceMonth } from '@/lib/beta-attendance';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store',Vary:'Cookie'};
export async function GET(request:NextRequest) {
  let context;
  try {context=await requireBetaPrivateAccount(request);}catch{return NextResponse.json({error:'Sign in to your own beta workspace.'},{status:403,headers});}
  const {account,db}=context;
  if(!account.betaWorkspaceActive)return NextResponse.json({error:'Your beta workspace is not active. Open work status for the latest update.'},{status:403,headers});
  const month=request.nextUrl.searchParams.get('month')??'';
  if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))return NextResponse.json({error:'Choose a valid month.'},{status:400,headers});
  try {
    const candidate=await db.from('workforce_amazon_email_pilot_candidates').select('biometric_id,created_at').eq('company_id',account.companyId).eq('id',account.id).is('closed_at',null).maybeSingle();
    if(candidate.error||!candidate.data)throw new Error('Profile unavailable');
    const [identity,attendance]=await Promise.all([
      loadBetaWorkforceIdentity(db,account.companyId,account.id),
      request.nextUrl.searchParams.get('attendance')==='0'?Promise.resolve({days:[],truncated:false}):loadBetaAttendanceMonth(db,account.companyId,candidate.data.biometric_id,candidate.data.created_at,month)
    ]);
    return NextResponse.json({...attendance,identity,month,refreshedAt:new Date().toISOString()},{headers});
  }catch{return NextResponse.json({error:'Workspace could not be refreshed. Try again.'},{status:503,headers});}
}
