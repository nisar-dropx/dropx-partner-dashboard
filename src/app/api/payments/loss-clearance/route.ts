import { assertReleaseStation, mayApprovePaymentRelease, mayEditPaymentRelease, paymentReleaseAccess } from "@/lib/payment-release-access";
import { readAllRows } from "@/lib/supabase-pagination";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function context(company: string, db: Awaited<ReturnType<typeof paymentReleaseAccess>>['db'], station: string, month: string | null, scope: string | null) {
  const [result, reviewers, handoff, history, policy] = await Promise.all([
    db.rpc('loss_payment_release_review', { p_company: company, p_station: station, p_month: month, p_scope: scope }),
    db.rpc('payment_release_reviewers', { p_company: company, p_station: station }),
    db.from('loss_payment_handoffs').select('*').eq('company_id', company).eq('station_id', station).eq('salary_month', month).eq('scope_key', scope).maybeSingle(),
    db.from('loss_payment_release_events').select('id,action,reason,actor_name,created_at').eq('company_id', company).eq('station_id', station).eq('salary_month', month).eq('scope_key', scope).order('created_at', { ascending: false }).limit(20),
    db.from('nl_loss_sources').select('recovery_policy').eq('company_id', company)
  ]);
  if (result.error || reviewers.error || handoff.error || history.error || policy.error) throw Error(result.error?.code === 'P0001' ? result.error.message : 'Loss clearance could not be loaded.');
  let handoffEvents: unknown[] = [];
  if (handoff.data) {
    const events = await db.from('loss_payment_handoff_events').select('action,reason,actor_id,created_at').eq('company_id', company).eq('handoff_id', handoff.data.id).order('created_at', { ascending: false }).limit(20);
    if (events.error) throw Error('Handoff history could not be loaded.'); handoffEvents = events.data ?? [];
  }
  return { ...result.data, reviewers: reviewers.data, handoff: handoff.data, handoffEvents, history: history.data,
    clearanceRequired: !policy.data?.some(p => p.recovery_policy?.require_loss_payment_clearance === false) };
}
export async function GET(request: Request) {
  try {
    const { auth, company, db } = await paymentReleaseAccess();
    const params = new URL(request.url).searchParams;
    if (params.get('options') === '1') {
      let query = db.from('stations').select('id,station_code,station_name').eq('company_id', company).order('station_code');
      if (!auth.hasAllLocationAccess) {
        const ids = auth.locationScopeIds.length ? auth.locationScopeIds : ['00000000-0000-0000-0000-000000000000']; query = query.in('id', ids);
      }
      const [stations, runs, queue] = await Promise.all([
        readAllRows(query), db.from('hr_payroll_runs').select('id,label,period_start').eq('company_id', company).order('period_start', { ascending: false }).limit(36), db.rpc('loss_payment_handoff_queue', { p_company: company, p_stations: auth.hasAllLocationAccess ? null : auth.locationScopeIds })
      ]);
      if (stations.error || runs.error || queue.error) throw Error('Review options could not be loaded.');
      const tasks = (queue.data ?? []) as Array<{ id: string; station_id: string; assigned_to: string; requested_by: string; [key: string]: unknown }>;
      const actorIds = [...new Set(tasks.flatMap(t => [t.assigned_to, t.requested_by]))];
      const actors = actorIds.length ? await db.from('profiles').select('id,full_name').eq('company_id', company).in('id', actorIds) : { data: [], error: null };
      if (actors.error) throw Error('Handoff owners could not be loaded.');
      return Response.json({ stations: stations.data, runs: runs.data, canApprove: mayApprovePaymentRelease(auth) && mayEditPaymentRelease(auth), canEdit: mayEditPaymentRelease(auth), actorId: auth.userId,
        queue: tasks.map(t => ({ ...t, station: stations.data?.find(s => s.id === t.station_id)?.station_code, owner: actors.data?.find(p => p.id === t.assigned_to)?.full_name ?? 'Assigned reviewer' })) }, { headers });
    }
    const station = params.get('station') || ''; await assertReleaseStation(auth, company, station);
    return Response.json(await context(company, db, station, params.get('month'), params.get('scope')), { headers });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Review unavailable.' }, { status: 400, headers }); }
}
export async function POST(request: Request) {
  try {
    if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) throw Error('Invalid origin.');
    const { auth, company, db } = await paymentReleaseAccess(true);
    const body = await request.json(); await assertReleaseStation(auth, company, body.station);
    if (['request', 'return'].includes(body.action)) {
      if (body.action === 'return' && !mayApprovePaymentRelease(auth)) throw Error('An authorised loss reviewer must return the handoff.');
      if (body.action === 'request' && !uuid.test(String(body.assignee))) throw Error('Choose an active reviewer for this location.');
      const result = await db.rpc('loss_payment_handoff', { p_company: company, p_station: body.station, p_month: body.month, p_scope: body.scope,
        p_actor: auth.userId, p_action: body.action, p_assignee: body.assignee || null, p_due: body.followUp || null, p_reason: body.reason,
        p_fingerprint: body.fingerprint, p_version: body.version ?? 0 });
      if (result.error) throw Error(result.error.code === 'P0001' ? result.error.message : 'Handoff could not be saved.');
    } else {
      if (!mayApprovePaymentRelease(auth)) throw Error('Release approval requires an authorised loss or Finance manager.');
      const result = body.action === 'exception' ? await db.rpc('loss_payment_release_with_handoff', { p_company: company, p_station: body.station, p_month: body.month, p_scope: body.scope,
        p_actor: auth.userId, p_fingerprint: body.fingerprint, p_reason: body.reason, p_assignee: body.assignee || null, p_due: body.followUp || null, p_version: body.version ?? 0 }) : await db.rpc('loss_payment_release_decide', { p_company: company, p_station: body.station, p_month: body.month, p_scope: body.scope,
        p_actor: auth.userId, p_action: body.action, p_fingerprint: body.fingerprint, p_reason: body.reason, p_owner: body.owner || null, p_follow_up: body.followUp || null });
      if (result.error) throw Error(result.error.code === 'P0001' ? result.error.message : 'Payment release could not be saved.');
    }
    return Response.json(await context(company, db, body.station, body.month, body.scope), { headers });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Approval failed.' }, { status: 409, headers }); }
}
