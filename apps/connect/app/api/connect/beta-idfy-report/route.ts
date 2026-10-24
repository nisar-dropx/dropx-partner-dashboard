import { NextRequest, NextResponse } from 'next/server';
import { requireBetaPrivateAccount } from '@/lib/beta-private-account';
import { betaReportUrl, readBetaPdf } from '@/lib/beta-report';
import {betaLifecycleEnabled} from '@/lib/beta-lifecycle';
import {BetaReportError,fetchBetaReportFile} from '@/lib/beta-report-proxy';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const headers = { 'Cache-Control':'private, no-store', Vary:'Cookie', 'X-Content-Type-Options':'nosniff' };
export async function GET(request: NextRequest) {
  let context;
  try { context = await requireBetaPrivateAccount(request); }
  catch { return NextResponse.json({error:'Sign in to your own beta account to download its report.'},{status:403,headers}); }
  try {
    if (betaLifecycleEnabled(context.account.companyId,context.account.id)) {
      const file=await fetchBetaReportFile(context.account.id,request.nextUrl.searchParams.get('fresh')==='1');
      return new Response(file.pdf,{headers:{...file.headers,'Content-Disposition':`${request.nextUrl.searchParams.get('view')==='inline'?'inline':'attachment'}; filename="IDfy-verification-${file.profile}.pdf"`}});
    }
    const base = process.env.WORKFORCE_AMAZON_WORKER_URL?.trim().replace(/\/$/,'');
    const key = process.env.WORKFORCE_AMAZON_WORKER_KEY?.trim();
    if (!base || !key) throw new Error('Report connection unavailable');
    const upstream = await fetch(`${base}/api/admin/beta/idfy/report`, {method:'POST',cache:'no-store',
      headers:{'Content-Type':'application/json','x-admin-key':key},body:JSON.stringify({candidateId:context.account.id}),signal:AbortSignal.timeout(95000)});
    if (!upstream.ok) throw new Error('Report unavailable');
    const report = await upstream.json();
    if (report.candidateId !== context.account.id || report.email?.toLowerCase() !== context.candidate.alias_email.toLowerCase()
      || !/^\d+$/.test(String(report.profileId ?? ''))) throw new Error('Report identity mismatch');
    if (!report.reportUrl) return NextResponse.json({error:'IDfy has not made a report available yet. Your check results remain visible below. Try again later.'},{status:404,headers});
    const url = betaReportUrl(report.reportUrl); if (!url) throw new Error('Unsupported report source');
    const pdf = await readBetaPdf(await fetch(url,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)}));
    const disposition=request.nextUrl.searchParams.get('view')==='inline'?'inline':'attachment';
    return new Response(pdf,{headers:{...headers,'Content-Type':'application/pdf','Content-Disposition':`${disposition}; filename="IDfy-verification-${report.profileId}.pdf"`,'Content-Length':String(pdf.length)}});
  } catch(error) { return NextResponse.json({error:error instanceof BetaReportError?error.message:'Your IDfy report could not be prepared. Please retry.',code:error instanceof BetaReportError?error.code:'unavailable',requestId:error instanceof BetaReportError?error.requestId:null},{status:error instanceof BetaReportError?error.status:503,headers}); }
}
