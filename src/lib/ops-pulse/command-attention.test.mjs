import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile=(path,mocks={})=>{const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>{if(n in mocks)return mocks[n];throw Error(n);},m.exports,m);return m.exports;};
const planning=compile('./station-audit-planning.ts');
const domain=compile('./command-attention.ts',{'./station-audit-planning':planning});
const today='2026-10-15',now=Date.parse(today+'T12:00:00+05:30');
test('audit priorities include overdue responses, today, upcoming and exclude closed; no double counting',()=>{
 const row={scheduled_for:'2026-10-14T12:00:00+05:30',status_code:'scheduled'};
 const result=domain.auditAttention([row,{...row,scheduled_for:'2026-10-15T12:00:00+05:30'},{...row,scheduled_for:'2026-10-17T12:00:00+05:30'},{...row,completed_at:row.scheduled_for,station_response_status:'requested',response_due_at:row.scheduled_for},{...row,status_code:'closed'}],today,now);
 assert.deepEqual(result,{overdue:2,due:1,followup:1,upcoming:1,action:3});
});
test('document renewals keep selected location and role access; no company-wide leakage',()=>{
 const row={document_type_id:'d',scope_type:'location',scope_id:'A',expiry_date:'2026-10-14',document_types:{doc_access_mode:'role_based'}};
 const rows=[row,{...row,scope_id:'B'},{...row,expiry_date:'2026-10-15'},{...row,expiry_date:'2026-11-15'},{...row,scope_type:'company'},{...row,track_expiry:false}];
 assert.deepEqual(domain.documentAttention(rows,[{document_type_id:'d',role_id:'r'}],['A'],'r',false,today),{expired:1,soon:1});
 assert.deepEqual(domain.documentAttention(rows,[{document_type_id:'d',role_id:'r'}],['A'],'other',false,today),{expired:0,soon:0});
 assert.deepEqual(domain.documentAttention(rows,[],[],null,true,today),{expired:0,soon:0});
});
test('unavailable checks never sort as clear; overdue appears before other action',()=>{
 assert.deepEqual(domain.attentionOrder([{key:'clear',tone:'clear'},{key:'unknown',tone:'unknown'},{key:'action',tone:'action'},{key:'urgent',tone:'urgent'}]).map(x=>x.key),['urgent','action','unknown','clear']);
});
function fixture(permissions=[],fail=false){
 const calls=[];const query=table=>new Proxy({table},{get:(o,k)=>k==='then'?resolve=>Promise.resolve(resolve({data:[],error:fail?{message:'offline'}:null})):k in o?o[k]:(...args)=>{calls.push([table,k,...args]);return query(table);}});
 const db={from:query};
 const mod=compile('./command-attention-data.ts',{'server-only':{},'@/lib/authorization':{hasPermission:(_a,p)=>permissions.includes(p)},'@/lib/company-scope':{requireCompanyId:()=> 'C'},'@/lib/supabase-admin':{supabaseAdmin:db},'@/lib/supabase-pagination':{readAllRows:async q=>await q},'@/lib/fleet/da-mapping-client':{mappingAdmin:{rpc:async(_n,args)=>{calls.push(['fleet',args]);return {data:{totalPending:5,overdue:4}};}}},'@/lib/fleet/da-mapping-server':{mappingCanView:()=>permissions.includes('fleet_da_mapping'),mappingStationScope:async()=>({stations:[{code:'A'},{code:'B'}]})},'./station-audits':{loadStationAuditMaster:async()=>({programmeSettings:{}}),loadAuditStations:async()=>[{id:'a'},{id:'b'}],canManageStationAudits:()=>true},'./station-audit-planning':planning,'./ds-command-data':{loadDsApprovals:async()=>({payment:null,rosterCount:null})},'./station-manpower':{loadOpsStationManpower:async(...a)=>{calls.push(['people',...a]);return {people:[]};}},'./ds-command-center':{summarizeStorePeople:()=>({notReported:0,missingOut:0,unplanned:0})},'./cod-pending-access':{canAccessDailyCodPending:()=>permissions.includes('cod_reports')},'./cod-pending-data':{loadCodPendingReport:async(...a)=>{calls.push(['cod',...a.slice(1)]);return []; }},'./capacity-snapshot':{loadCapacitySnapshot:async args=>{calls.push(['capacity',args]);return {errors:[],stations:[]};}},'./command-attention':domain});
 return {calls,run:(mode='amazon_edsp')=>mod.loadCommandAttention({userId:'u',roleId:'r',hasAllLocationAccess:false,locationScopeIds:['a']},[{id:'a',station_code:'A'},{id:'b',station_code:'B'}],today,mode)};
}
test('no source reads without module permission',async()=>{const f=fixture();assert.deepEqual(await f.run(),[]);assert.deepEqual(f.calls,[]);});
test('audit personal assignment verified; all operational reads intersect selected authorization',async()=>{
 const f=fixture(['station_audits','fleet_da_mapping','cod_reports','capacity_overview','ops_rostering']);await f.run();
 assert(f.calls.some(c=>c[0]==='ops_station_audits'&&c[1]==='eq'&&c[2]==='assigned_to'&&c[3]==='u'));
 assert(f.calls.some(c=>c[0]==='ops_station_audits'&&c[1]==='eq'&&c[2]==='assignment_verified'&&c[3]===true));
 assert.deepEqual(f.calls.find(c=>c[0]==='fleet')[1].p_stations,['A']);
 assert.deepEqual(f.calls.find(c=>c[0]==='cod').slice(1),['C',['a'],false,'2026-10-14']);
 assert.deepEqual(f.calls.find(c=>c[0]==='people')[2].map(x=>x.id),['a']);
 assert.deepEqual(f.calls.find(c=>c[0]==='capacity')[1].locations.map(x=>x.id),['a']);
});
test('Dark Store excludes Last Mile cash, capacity and fleet; keeps audits and shared approvals',async()=>{
 const f=fixture(['station_audits','fleet_da_mapping','cod_reports','capacity_overview','ops_rostering','payment_approvals']);const items=await f.run('amazon_now');
 assert.deepEqual(items.map(x=>x.key).sort(),['audits','payments','rosters']);assert(!f.calls.some(c=>['fleet','cod','capacity','people'].includes(c[0])));
});
test('source failures and missing approval results remain unavailable, not zero',async()=>{const f=fixture(['station_audits','business_documents','payment_approvals'],true);const items=await f.run();assert(items.every(i=>i.tone==='unknown'&&i.value==='Unavailable'));});
test('both dashboards show operational attention before cost and do not hide audit queue in disclosure',()=>{
 for(const page of ['../../app/ops-pulse/page.tsx','../../app/ops-pulse/dark-store-home.tsx'])assert.match(readFileSync(new URL(page,import.meta.url),'utf8'),/<OpsCommandAttention/);
 assert.doesNotMatch(readFileSync(new URL('../../app/ops-pulse/page.tsx',import.meta.url),'utf8'),/My audits & vehicle mapping queue/);
});
