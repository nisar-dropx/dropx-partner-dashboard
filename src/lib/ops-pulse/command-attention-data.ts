import 'server-only';
import { hasPermission, type AuthorizationContext } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { readAllRows } from '@/lib/supabase-pagination';
import { mappingAdmin } from '@/lib/fleet/da-mapping-client';
import { mappingCanView, mappingStationScope } from '@/lib/fleet/da-mapping-server';
import { loadStationAuditMaster, loadAuditStations, canManageStationAudits } from './station-audits';
import { addAuditDays } from './station-audit-planning';
import { loadDsApprovals } from './ds-command-data';
import { loadOpsStationManpower } from './station-manpower';
import { summarizeStorePeople } from './ds-command-center';
import { canAccessDailyCodPending } from './cod-pending-access';
import { loadCodPendingReport } from './cod-pending-data';
import { loadCapacitySnapshot } from './capacity-snapshot';
import type { CodLocationRow } from './cod';
import { isManager as isStoreAuditManager } from './store-audits/model';
import { attentionOrder, auditAttention, storeAuditAttention, codAttention, documentAttention, type AttentionDocument, type AttentionItem } from './command-attention';

export function startCommandAttention(a:AuthorizationContext,locations:CodLocationRow[],today:string,mode:string,now=Date.now()) {
  const company=requireCompanyId(a),yesterday=addAuditDays(today,-1);
  const selected=locations.filter(l=>!l.is_ho&&!l.hide_from_location_list&&(a.hasAllLocationAccess||a.locationScopeIds.includes(l.id)));
  const ids=selected.map(l=>l.id),codes=selected.map(l=>l.station_code);
  const has=(p:string)=>hasPermission(a,p,'access');
  async function check(enabled:boolean,key:string,title:string,href:string,work:()=>Promise<Omit<AttentionItem,'key'|'title'|'href'>&{href?:string}>):Promise<AttentionItem[]> {
    if(!enabled)return [];
    try{return [{key,title,href,...await work()}];}
    catch{return [{key,title,href,value:'Unavailable',detail:'Could not check this source. Open the workspace to retry.',action:'Check source',tone:'unknown'}];}
  }
  return [
    check(mode!=='amazon_now'&&has('station_audits')&&ids.length>0,'audits','Audits','/ops-pulse/audits',async()=>{
      if(!supabaseAdmin)throw Error('Unavailable');
      const master=await loadStationAuditMaster(company);
      const manager=canManageStationAudits(a,master.programmeSettings);
      const stations=(await loadAuditStations(company,a,master.programmeSettings)).filter(s=>ids.includes(s.id));
      if(!stations.length)return{value:'Not applicable',detail:'No eligible audit locations in this selection.',action:'Open audits',tone:'clear'};
      let q=supabaseAdmin.from('ops_station_audits').select('id,scheduled_for,status_code,completed_at,response_due_at,station_response_status').eq('company_id',company).in('location_id',stations.map(s=>s.id)).is('deleted_at',null).neq('status_code','closed');
      // Programme managers already have audit oversight for these selected locations.
      // Do not reduce the management dashboard to just their personal assignments.
      q=manager?q:q.not('completed_at','is',null).eq('station_response_status','requested').eq('status_code','awaiting_station_response');
      const r=await readAllRows(q.order('id'));if(r.error)throw Error('Unavailable');
      const s=auditAttention(r.data??[],today,now);
      const focus=(r.data??[]).filter(x=>!x.completed_at||x.station_response_status==='requested').sort((x,y)=>String(x.response_due_at||x.scheduled_for).localeCompare(String(y.response_due_at||y.scheduled_for)))[0];
      return{value:`${s.action} to action`,count:s.action,dueAt:focus?.response_due_at||focus?.scheduled_for,href:focus?`/ops-pulse/audits?audit=${encodeURIComponent(focus.id)}`:'/ops-pulse/audits',detail:`${s.overdue} overdue · ${s.due} today · ${s.followup} follow-ups · ${s.upcoming} next 7 days`,action:manager?'Review location audits':'Respond to audits',tone:s.overdue?'urgent':s.action||s.upcoming?'action':'clear'};
    }),
    check(mode==='amazon_now'&&has('store_audits')&&ids.length>0,'audits','Store audits','/ops-pulse/store-audits',async()=>{
      if(!supabaseAdmin)throw Error('Unavailable');
      const master=await supabaseAdmin.from('ops_store_audit_master').select('settings').eq('company_id',company).maybeSingle();
      if(master.error||!master.data?.settings)throw Error('Unavailable');
      const manager=isStoreAuditManager(a,master.data.settings);
      let q=supabaseAdmin.from('ops_store_audits').select('id,status,scheduled_for,completed_at,findings,answers').eq('company_id',company).in('location_id',ids).is('deleted_at',null).in('status',manager?['scheduled','in_progress','awaiting_response','under_review']:['awaiting_response','under_review']);
      if(!manager)q=q.not('completed_at','is',null);
      const r=await readAllRows(q.order('id'));if(r.error)throw Error('Unavailable');
      const s=storeAuditAttention(r.data??[],today,now);
      return{value:`${s.count} to action`,count:s.count,dueAt:s.focus?.scheduled_for,detail:`${s.overdue} overdue · ${s.upcoming} next 7 days · store audit programme`,href:s.focus?`/ops-pulse/store-audits?audit=${encodeURIComponent(s.focus.id)}`:'/ops-pulse/store-audits',action:'Open store audits',tone:s.overdue?'urgent':s.count||s.upcoming?'action':'clear'};
    }),
    check(mode==='amazon_now'&&has('si_handover')&&ids.length>0,'si-handover','SI shift handover','/si-handover?view=accept',async()=>{
      if(!supabaseAdmin)throw Error('Unavailable');
      const master=await supabaseAdmin.from('ops_si_handover_master').select('settings').eq('company_id',company).maybeSingle();
      if(master.error)throw Error('Unavailable');
      const settings=master.data?.settings&&typeof master.data.settings==='object'?master.data.settings as {escalateStoreMinutes?:number;escalateClusterMinutes?:number}:{};
      const storeMins=Number(settings.escalateStoreMinutes)||30;
      const clusterMins=Number(settings.escalateClusterMinutes)||60;
      const r=await readAllRows(supabaseAdmin.from('ops_si_shift_checklists').select('id,status,submitted_at,store_code,shift_date,shift_slot,outgoing_name').eq('company_id',company).in('location_id',ids).is('deleted_at',null).eq('status','submitted').order('submitted_at'));
      if(r.error)throw Error('Unavailable');
      const rows=r.data??[];
      const cluster=rows.filter(x=>x.submitted_at&&(now-Date.parse(x.submitted_at))/60000>=clusterMins).length;
      const store=rows.filter(x=>x.submitted_at&&(now-Date.parse(x.submitted_at))/60000>=storeMins).length;
      const focus=rows[0];
      return{
        value:`${rows.length} awaiting acceptance`,
        count:rows.length,
        dueAt:focus?.submitted_at||undefined,
        detail:`${store} past ${storeMins}m · ${cluster} past ${clusterMins}m · outgoing SI cannot close handover until accepted`,
        href:focus?`/si-handover?view=accept&id=${encodeURIComponent(focus.id)}`:'/si-handover?view=accept',
        action:'Review handovers',
        tone:cluster?'urgent':rows.length?'action':'clear'
      };
    }),
    check(mode!=='amazon_now'&&has('ops_rostering')&&ids.length>0,'people','Shift readiness','/ops-pulse?view=manpower',async()=>{
      const data=await loadOpsStationManpower(company,selected,today),s=summarizeStorePeople(data.people,now);
      const affected=[...new Set(data.people.filter(p=>{const x=summarizeStorePeople([p],now);return x.notReported||x.missingOut||x.unplanned;}).map(p=>p.locationId))];
      return{value:`${affected.length} locations to check`,count:s.notReported+s.missingOut+s.unplanned,href:`/ops-pulse?view=manpower&date=${today}${affected[0]?`&location=${affected[0]}`:''}`,detail:`${s.notReported} not reported · ${s.missingOut} punch-outs · ${s.unplanned} shift times missing`,action:'Check today’s attendance',tone:affected.length?'action':'clear'};
    }),
    check(mode!=='amazon_now'&&mappingCanView(a)&&codes.length>0,'vehicles','Vehicle DA exceptions','/fleet/da-mapping',async()=>{
      const allowed=await mappingStationScope(a),scoped=allowed.stations.filter(s=>codes.includes(s.code));
      if(!scoped.length)return{value:'Not applicable',detail:'No permitted vehicles in this selection.',action:'Open mapping',tone:'clear'};
      const r=await mappingAdmin!.rpc('fleet_pending_da_days',{p_company:company,p_stations:scoped.map(s=>s.code),p_from:null,p_to:today,p_offset:0,p_limit:1});
      if(r.error||!r.data||!Number.isFinite(r.data.totalPending)||!Number.isFinite(r.data.overdue))throw Error('Unavailable');
      return{value:`${r.data.totalPending} vehicle-days`,count:r.data.totalPending,detail:r.data.pendingReasons?`${r.data.pendingVehicles} vehicles · ${r.data.pendingReasons.missingId} missing ID · ${r.data.pendingReasons.belowMinimum} below minimum · ${r.data.pendingReasons.conflict} conflicts`:`Previous dates · ${r.data.totalPending} pending vehicle-days`,action:'Complete mappings',tone:r.data.overdue?'urgent':r.data.totalPending?'action':'clear'};
    }),
    (async():Promise<AttentionItem[]>=>{
      const items:AttentionItem[]=[];
      const canReport=canAccessDailyCodPending(a);
      if(mode==='amazon_now'||!ids.length||(!canReport&&!has('cod_submission')))return [];
      // Check the latest completed upload deadline, not today's not-yet-due slips.
      const date=now>=Date.parse(today+'T20:30:00+05:30')?today:yesterday;
      try{if(!supabaseAdmin)throw Error('Unavailable');items.push(...codAttention(await loadCodPendingReport(supabaseAdmin,company,ids,false,date),date,canReport));}
      catch{items.push({key:'cod',title:'COD slips & CMS',value:'Unavailable',detail:'Could not check daily updates.',action:'Open COD workspace',href:canReport?`/ops-pulse/cod/pending?date=${date}`:`/ops-pulse/cod/submission?deposit_date=${date}`,tone:'unknown'});}
      return items;
    })(),
    check(mode==='amazon_edsp'&&has('capacity_overview')&&ids.length>0,'capacity','Delivery capacity',`/ops-pulse/capacity?stations=${encodeURIComponent(codes.join(','))}&date=${yesterday}`,async()=>{
      const data=await loadCapacitySnapshot({companyId:company,locations:selected,reportingDate:yesterday});
      if(data.errors.length)throw Error('Unavailable');
      const gap=data.stations.filter(s=>s.dataState==='ready'&&(s.modelledGap??0)>0).length;
      const missing=data.stations.filter(s=>s.dataState!=='ready'||s.requiredIds===null).length;
      return{value:`${gap} modelled gaps`,count:gap+missing,detail:`${missing} need fresh data / rules · 14-day workload through ${yesterday}`,action:'Review capacity plan',tone:gap||missing?'action':'clear'};
    }),
    check(has('business_documents')&&ids.length>0,'documents','Location documents',`/business-documents?location=${encodeURIComponent(ids.join(','))}`,async()=>{
      if(!supabaseAdmin)throw Error('Unavailable');
      const [docs,roles]=await Promise.all([
        readAllRows(supabaseAdmin.from('business_document_records').select('id,document_type_id,scope_type,scope_id,additional_scope_ids,expiry_date,track_expiry,document_types(doc_access_mode)').eq('company_id',company).eq('is_active',true).eq('scope_type','location').lte('expiry_date',addAuditDays(today,30)).order('id')),
        readAllRows(supabaseAdmin.from('document_type_role_access').select('document_type_id,role_id').eq('company_id',company).order('document_type_id').order('role_id'))
      ]);
      if(docs.error||roles.error)throw Error('Unavailable');
      const s=documentAttention((docs.data??[]) as AttentionDocument[],roles.data??[],ids,a.roleId,a.hasAllLocationAccess||a.isMasterOwner,today);
      return{value:`${s.expired+s.soon} renewals`,detail:`${s.expired} expired · ${s.soon} due within 30 days · location documents only`,action:'Review documents',tone:s.expired?'urgent':s.soon?'action':'clear'};
    }),
    (async():Promise<AttentionItem[]>=>{
      const items:AttentionItem[]=[];
      if(!has('payment_approvals')&&!has('ops_rostering'))return [];
      const data=await loadDsApprovals(a);
      if(has('payment_approvals'))items.push({key:'payments',title:'Your payment approvals',href:'/payments/approvals',value:data.payment===null?'Unavailable':`${data.payment.count} pending`,detail:'Assigned to you · across authorized LM + DS locations',action:'Open approval inbox',tone:data.payment===null?'unknown':data.payment.count?'action':'clear'});
      if(has('ops_rostering'))items.push({key:'rosters',title:'Your roster approvals',href:'/rostering?view=approvals',value:data.rosterCount===null?'Unavailable':`${data.rosterCount} plans pending`,detail:'Unique plans assigned to you · across authorized LM + DS locations',action:'Review plans',tone:data.rosterCount===null?'unknown':data.rosterCount?'action':'clear'});
      return items;
    })()
  ];
}

// Keep the complete loader for consumers that need one finished snapshot.
export async function loadCommandAttention(...args:Parameters<typeof startCommandAttention>) {
  return attentionOrder((await Promise.all(startCommandAttention(...args))).flat());
}
