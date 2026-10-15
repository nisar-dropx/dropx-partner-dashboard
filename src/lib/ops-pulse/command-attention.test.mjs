import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile=(path,mocks={})=>{const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>{if(n in mocks)return mocks[n];if(n==='./store-audits/model')return {isManager:()=>true};throw Error(n);},m.exports,m);return m.exports;};
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
 return {calls,run:(mode='amazon_edsp',time=now)=>mod.loadCommandAttention({userId:'u',roleId:'r',hasAllLocationAccess:false,locationScopeIds:['a']},[{id:'a',station_code:'A'},{id:'b',station_code:'B'}],today,mode,time)};
}
test('no source reads without module permission',async()=>{const f=fixture();assert.deepEqual(await f.run(),[]);assert.deepEqual(f.calls,[]);});
test('audit managers see selected-location oversight, not just personal assignments; every read stays authorized',async()=>{
 const f=fixture(['station_audits','fleet_da_mapping','cod_reports','capacity_overview','ops_rostering']);await f.run();
 assert(!f.calls.some(c=>c[0]==='ops_station_audits'&&c[2]==='assigned_to'));
 assert.deepEqual(f.calls.find(c=>c[0]==='ops_station_audits'&&c[1]==='in'&&c[2]==='location_id')[3],['a']);
 assert.deepEqual(f.calls.find(c=>c[0]==='fleet')[1].p_stations,['A']);
 assert.deepEqual(f.calls.find(c=>c[0]==='cod').slice(1),['C',['a'],false,'2026-10-14']);
 assert.deepEqual(f.calls.find(c=>c[0]==='people')[2].map(x=>x.id),['a']);
 assert.deepEqual(f.calls.find(c=>c[0]==='capacity')[1].locations.map(x=>x.id),['a']);
});
test('COD switches to today only after upload deadline; location submitters receive allowed actions',async()=>{
 const f=fixture(['cod_submission']);const items=await f.run('amazon_edsp',Date.parse(today+'T21:00:00+05:30'));
 assert.deepEqual(f.calls.find(c=>c[0]==='cod').slice(1),['C',['a'],false,today]);
 assert(items.every(i=>i.href.startsWith('/ops-pulse/cod/submission?')));
});
test('missing slip cards exclude No Cash / banker exceptions, separate proof, correction and verification',()=>{
 const row={station:{id:'a',station_code:'A'},entries:[],client:'amazon',deadline:'2026-10-14T15:00:00Z',pending:false,overdue:false};
 const items=domain.codAttention([
   {...row,status:'Missing slip',pending:true,overdue:true},
   {...row,status:'Slip missing proof',pending:true},
   {...row,status:'No Cash',exception:{kind:'No Cash'}},
   {...row,status:'Banker Not Reported',exception:{kind:'Banker Not Reported'}},
   {...row,status:'Review pending',entries:[{}]},
   {...row,status:'Returned',entries:[{}],pending:true}
 ],'2026-10-14',true);
 assert.equal(items.find(i=>i.key==='cod').count,2);assert.equal(items.find(i=>i.key==='cod').tone,'urgent');
 assert.equal(items.find(i=>i.key==='cms').count,1);assert.equal(items.find(i=>i.key==='cod-review').count,2);
 assert.match(items[0].href,/date=2026-10-14.*location=a/);
});
test('priority changes by overdue, earliest due date, and affected count instead of fixed module position',()=>{
 const ordered=domain.attentionOrder([{key:'audits',tone:'action',count:1},{key:'cod',tone:'urgent',count:1,dueAt:'2026-10-14'},{key:'vehicles',tone:'urgent',count:5,dueAt:'2026-10-13'},{key:'people',tone:'action',count:7}]);
 assert.deepEqual(ordered.map(i=>i.key),['vehicles','cod','people','audits']);
});
test('dashboard offers linked snapshots rather than duplicating section tables and charts',()=>{
 const lm=readFileSync(new URL('../../components/ops-command-center.tsx',import.meta.url),'utf8');
 const ds=readFileSync(new URL('../../app/ops-pulse/dark-store-home.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(lm,/<table|Daily deliveries|Cost drivers|Station priorities/);
 assert.doesNotMatch(ds,/<table|Store overview|At a glance/);
 assert.match(lm,/href=\{costHref\}/);assert.match(ds,/extraItems=\{extraItems\}/);
});
test('Dark Store excludes Last Mile cash, capacity and fleet; keeps audits and shared approvals',async()=>{
 const f=fixture(['station_audits','store_audits','fleet_da_mapping','cod_reports','capacity_overview','ops_rostering','payment_approvals']);const items=await f.run('amazon_now');
 assert.deepEqual(items.map(x=>x.key).sort(),['audits','payments','rosters']);assert(!f.calls.some(c=>['fleet','cod','capacity','people'].includes(c[0])));
});
test('store audit counts respect current work, response deadlines, cancellations and closed findings',()=>{
 const row={id:'a',status:'scheduled',scheduled_for:'2026-10-14T12:00:00+05:30',completed_at:null,findings:[],answers:{}};
 const result=domain.storeAuditAttention([row,{...row,id:'future',scheduled_for:'2026-10-17T12:00:00+05:30'},{...row,id:'closed',status:'closed'},{...row,id:'cancelled',status:'cancelled'},{...row,id:'response',completed_at:row.scheduled_for,status:'awaiting_response',findings:[{questionId:'q',state:'open'}],answers:{q:{dueAt:row.scheduled_for}}}],today,now);
 assert.equal(result.count,2);assert.equal(result.overdue,2);assert.equal(result.upcoming,1);assert.equal(result.focus.id,'a');
});
test('source failures and missing approval results remain unavailable, not zero',async()=>{const f=fixture(['station_audits','business_documents','payment_approvals'],true);const items=await f.run();assert(items.every(i=>i.tone==='unknown'&&i.value==='Unavailable'));});
test('both dashboards show operational attention before cost and do not hide audit queue in disclosure',()=>{
 for(const page of ['../../app/ops-pulse/page.tsx','../../app/ops-pulse/dark-store-home.tsx'])assert.match(readFileSync(new URL(page,import.meta.url),'utf8'),/<OpsCommandAttention/);
 assert.doesNotMatch(readFileSync(new URL('../../app/ops-pulse/page.tsx',import.meta.url),'utf8'),/My audits & vehicle mapping queue/);
});
