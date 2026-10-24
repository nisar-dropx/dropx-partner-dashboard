import { readBetaPdf } from './beta-report';
export class BetaReportError extends Error {
  constructor(public status: number, public code: string, public requestId: string | null, message: string) { super(message); }
}
const errors: Record<string,string> = {
  not_ready: 'IDfy has not published a PDF yet. Your check results are still available.',
  provider_slow: 'IDfy took too long to prepare the report. Please try again.',
  identity_unavailable: 'The report identity could not be confirmed. Refresh your status and retry.',
  pdf_unavailable: 'IDfy prepared the report, but the PDF could not be received. Please retry.',
  provider_unavailable: 'IDfy could not prepare the report just now. Please retry.',
};
export async function fetchBetaReportFile(candidateId: string, fresh = false) {
  const base = process.env.WORKFORCE_AMAZON_WORKER_URL?.trim().replace(/\/$/, '');
  const key = process.env.WORKFORCE_AMAZON_WORKER_KEY?.trim() || process.env.WORKFORCE_AMAZON_WORKER_ADMIN_KEY?.trim();
  if (!base || !key) throw new BetaReportError(503,'connection',null,'The report connection is unavailable. Please contact your team.');
  let response: Response;
  try {
    response = await fetch(`${base}/api/admin/beta/idfy/report/file`, {
      method:'POST', cache:'no-store', headers:{'Content-Type':'application/json','x-admin-key':key},
      body:JSON.stringify({candidateId,fresh}), signal:AbortSignal.timeout(110000),
    });
  } catch { throw new BetaReportError(503,'provider_slow',null,errors.provider_slow); }
  if (!response.ok) {
    const data = await response.json().catch(()=>({}));
    const code = Object.hasOwn(errors,data.code)?data.code:'provider_unavailable';
    const reference = /^[a-f\d-]{36}$/i.test(data.requestId??'')?data.requestId:null;
    throw new BetaReportError(response.status===404?404:503,code,reference,errors[code]);
  }
  const profile = response.headers.get('X-Report-Profile');
  if (response.headers.get('X-Report-Candidate')!==candidateId || !/^\d+$/.test(profile??'')) throw new BetaReportError(503,'identity_unavailable',null,errors.identity_unavailable);
  let pdf;
  try { pdf = await readBetaPdf(response); }
  catch { throw new BetaReportError(503,'pdf_unavailable',response.headers.get('X-Report-Request-Id'),errors.pdf_unavailable); }
  const prepared = response.headers.get('X-Report-Prepared-At');
  return {pdf,profile,headers:{
    'Cache-Control':'private, no-store',Vary:'Cookie','X-Content-Type-Options':'nosniff',
    'Content-Type':'application/pdf','Content-Length':String(pdf.length),
    'X-Report-Prepared-At':prepared&&Number.isFinite(Date.parse(prepared))?prepared:new Date().toISOString(),
    'X-Report-Cache':response.headers.get('X-Report-Cache')==='hit'?'hit':'miss',
    'Content-Disposition':`attachment; filename="IDfy-verification-${profile}.pdf"`,
  }};
}
