import { getAuthorization, hasPermission } from '@/lib/authorization';
import { mayActivateRedispute } from '@/lib/ops-pulse/loss-recovery-controls';
import { recoveryContext } from '@/lib/ops-pulse/nl-recovery-context';
import { LOSS_EXCEPTION_LABELS } from '@/lib/ops-pulse/loss-exceptions';
import { supabaseAdmin } from '@/lib/supabase-admin';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: {'Cache-Control':'private, no-store'} });
export async function POST(request: Request) {
 try {
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return reply({error:'Invalid origin.'},403);
  const auth = await getAuthorization();
  if (!auth || !mayActivateRedispute(auth) || !hasPermission(auth,'ops_losses','access') || !hasPermission(auth,'ops_losses','edit'))
   return reply({error:'Only SLP Manager, Finance Manager, Managing Partner or National Head can manage exceptions.'},403);
  const body = await request.json();
  if (!Array.isArray(body?.rows) || !body.rows.length || body.rows.length>100) return reply({error:'Provide 1–100 exception updates.'},400);
  const seen = new Set<string>();
  for (const r of body.rows) {
   if (!r || !/^\d{4}-(0[1-9]|1[0-2])$/.test(r.month) || typeof r.case_key!=='string' || !r.case_key || r.case_key.length>300 ||
     !Object.prototype.hasOwnProperty.call(LOSS_EXCEPTION_LABELS,r.kind) || typeof r.enabled!=='boolean' || !Number.isInteger(r.version) || r.version<0 ||
     (r.reason != null && (typeof r.reason!=='string' || r.reason.length>2000))) return reply({error:'Each row needs a Shipment ID, loss month, exception and current version. Notes are optional, up to 2,000 characters.'},400);
   const k=`${r.month}|${r.case_key}|${r.kind}`;
   if(seen.has(k)) return reply({error:'Remove duplicate TID/exception rows.'},400); seen.add(k);
  }
  const results=[];
  for (const r of body.rows) {
   try {
    const ctx=await recoveryContext(r.month,r.case_key,true,!r.enabled,!r.enabled && r.kind==='redispute');
    if (!mayActivateRedispute(ctx.auth)) throw Error('Exception access denied.');
    if (r.enabled && ctx.report==='slp' && !ctx.finalSeenAt) throw Error('Wait for the SLP Final file before enabling exceptions.');
    const common={p_company:ctx.scope.company,p_month:r.month,p_case:ctx.caseKey,p_version:r.version,p_actor:ctx.auth.userId,p_name:ctx.auth.fullName||ctx.auth.email||'OpsPulse user'};
    const note = String(r.reason || '').trim();
    const auditReason = note.length >= 10 ? note : `${r.enabled ? 'Enable' : 'Disable'} ${LOSS_EXCEPTION_LABELS[r.kind as keyof typeof LOSS_EXCEPTION_LABELS]}${note ? ': ' + note : ' · manager request'}`;
    const result=r.kind==='redispute'
     ? await supabaseAdmin!.rpc('nl_redispute_transition',{...common,p_action:r.enabled?'activate':'revoke',p_details:{note:auditReason}})
     : await supabaseAdmin!.rpc('nl_loss_exception_set',{...common,p_kind:r.kind,p_enabled:r.enabled,p_reason:auditReason});
    if(result.error) {
     // Return fresh scoped state after a version conflict; never retry a write silently.
     const table = r.kind === 'redispute' ? 'nl_case_response_windows' : 'nl_loss_exception_options';
     let lookup = supabaseAdmin!.from(table).select('*').eq('company_id',ctx.scope.company).eq('month',r.month).eq('case_key',ctx.caseKey);
     if(r.kind !== 'redispute') lookup = lookup.eq('kind',r.kind);
     const latest = await lookup.maybeSingle();
     results.push({month:r.month,case_key:r.case_key,kind:r.kind,ok:false,error:result.error.code==='P0001'?result.error.message.replace(/Reload before (continuing|saving)\./,'Review the refreshed status and try again.'):'Exception could not be saved. Please retry.',current:latest.error ? undefined : latest.data});
     continue;
    }
    results.push({month:r.month,case_key:r.case_key,kind:r.kind,ok:true,value:result.data});
   } catch(e) { results.push({month:r.month,case_key:r.case_key,kind:r.kind,ok:false,error:e instanceof Error?e.message:'Unable to save exception.'}); }
  }
  return reply({results});
 } catch(e) { return reply({error:e instanceof Error?e.message:'Unable to save exceptions.'},403); }
}
