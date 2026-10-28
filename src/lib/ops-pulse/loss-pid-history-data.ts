import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { readAllRows } from '@/lib/supabase-pagination';
import { meaningfulPidEvents, pidEvent, type PidEvent } from './loss-pid-history';

/** Callers supply cases already checked against their company and station scope. No retention cutoff. */
export async function loadPidHistory(company: string, cases: {month:string;case_key:string}[]) {
  const allowed = new Set(cases.map(c=>`${c.month}|${c.case_key}`));
  const keys = [...new Set(cases.map(c=>c.case_key))];
  const events: PidEvent[] = [];
  const tables = [
    ['Source','nl_loss_source_events'], ['Recovery','nl_loss_recovery_events'],
    ['Workflow','nl_loss_lifecycle_events'], ['Dispute','nl_dispute_request_events'],
    ['Redispute','nl_case_response_events'], ['Exception','nl_loss_exception_events'],
  ];
  for (let i=0;i<keys.length;i+=100) {
    const results = await Promise.all(tables.map(async ([source,table]) => {
      const result = await readAllRows(supabaseAdmin!.from(table).select('*').eq('company_id',company)
        .in('case_key',keys.slice(i,i+100)).order('created_at',{ascending:false}).order('id'));
      if (result.error) throw Error(`${source} history could not be loaded. Retry after the tracking-history migration is installed.`);
      return (result.data || []).filter(e=>allowed.has(`${e.month}|${e.case_key}`)).map(e=>pidEvent(source,e));
    }));
    events.push(...results.flat());
    // Clarification and station-claim events reference a parent record, not a case directly.
    for (const [source,parent,child,link,monthField] of [
      ['Clarification','nl_loss_clarifications','nl_loss_clarification_events','clarification_id','month'],
      ['Station claim','ops_station_loss_claims','ops_station_loss_claim_events','claim_id','case_month'],
    ]) {
      const parents=await readAllRows(supabaseAdmin!.from(parent).select(`id,case_key,${monthField}`).eq('company_id',company).in('case_key',keys.slice(i,i+100)).order('id'));
      if(parents.error) throw Error(`${source} history could not be loaded.`);
      const byId=new Map((parents.data||[]).filter(p=>allowed.has(`${p[monthField]}|${p.case_key}`)).map(p=>[p.id,p]));
      const ids=[...byId.keys()];
      for(let j=0;j<ids.length;j+=100){
        const history=await readAllRows(supabaseAdmin!.from(child).select('*').eq('company_id',company).in(link,ids.slice(j,j+100)).order('created_at',{ascending:false}).order('id'));
        if(history.error) throw Error(`${source} history could not be loaded.`);
        for(const event of history.data||[]){const p=byId.get(event[link]);if(p)events.push(pidEvent(source,{...event,month:p[monthField],case_key:p.case_key}));}
      }
    }
  }
  return meaningfulPidEvents(events);
}
