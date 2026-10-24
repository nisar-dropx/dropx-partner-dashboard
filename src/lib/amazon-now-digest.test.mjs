import test from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';import {readFileSync} from 'node:fs';
import {shiftDay,renderNowDigest} from './amazon-now-digest-view.ts';
function compile(path,mocks={}){const code=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const m={exports:{}};new Function('require','module','exports',code)(n=>{if(!(n in mocks))throw Error(n);return mocks[n]},m,m.exports);return m.exports;}
const scope=compile('./adhoc-digest-scope.ts');
test('Amazon Now recipients exclude LM, non-operations people, other domains and unassigned stores',()=>{
 const stations=[{id:'now',station_code:'TCC3',providers:{code:'AMAZON'},location_models:{code:'NOW'},station_email:'store@example.com'},{id:'other',station_code:'TTA5',providers:{code:'AMAZON'},location_models:{code:'NOW'}},{id:'lm',station_code:'KTUR',providers:{code:'AMAZON'},location_models:{code:'EDSP'}}];
 const roles=[{id:'manager',code:'OPERATIONS_CLM',location_access_mode:'scoped'},{id:'store',code:'OPERATIONS_LOCATION',location_access_mode:'scoped'}];
 const memberships=[{user_id:'ops',role_id:'manager',location_scope_ids:['now','lm']},{user_id:'hr',role_id:'manager',has_all_location_access:true},{user_id:'mail',role_id:'store',has_all_location_access:true}];
 const profiles=[{id:'ops',email:'ops@example.com'},{id:'hr',email:'hr@example.com'},{id:'mail',email:'store@example.com'}];
 const actual=scope.resolveAdHocRecipients(stations,memberships,roles,profiles,'example.com',new Set(['ops']),{stationFilter:scope.isAmazonNowMailStation,roleCodes:['OPERATIONS_CLM','OPERATIONS_LOCATION']});
 assert.deepEqual(actual.map(r=>[r.email,r.stationIds]),[['ops@example.com',['now']],['store@example.com',['now']]]);
});
test('monthly email subjects use sending month while review dates cross month/year boundaries',()=>{
 assert.equal(shiftDay('2027-01-01',-2),'2026-12-30');
 const base={review:true,rows:[{id:'a',code:'TCC3',name:'<Store>',cells:['—','D−2 data missing','Owner','0 open'],attention:true,href:'/performance'}],date:'2027-01-01',dataDate:'2026-12-30',checkedAt:'2027-01-01T13:30:00Z',name:'Manager',subjectTemplate:'Review {{month}} {{year}}',reminder:''};
 const r=renderNowDigest(base);assert.equal(r.subject,'Review January 2027');assert.match(r.html,/2026-12-30/);assert.match(r.html,/&lt;Store&gt;/);assert.doesNotMatch(r.html,/<Store>/);assert.match(r.text,/D−2 data missing/);
});
test('activity message distinguishes handover acceptance from checklist submission',()=>{
 const r=renderNowDigest({review:false,rows:[{id:'a',code:'TCC3',name:'Store',cells:['Submitted','2/3 accepted','1 awaiting acceptance · 0 open / returned','Incoming SI'],attention:true,href:'/si-handover/report'}],date:'2026-10-25',dataDate:'2026-10-24',checkedAt:'2026-10-25T01:45:00Z',name:'Store',subjectTemplate:'Activities {{month}} {{year}}',reminder:''});assert.match(r.html,/1 awaiting acceptance/);assert.match(r.html,/Future shifts are excluded/);assert.match(r.html,/monthly store-operations thread/);
});
function builderFixture(review) {
 const station={id:'s1',station_code:'TCC3',station_name:'Adyar',city:'Chennai'};
 const tables={ops_performance_reviews:[],report_metric_facts:[],ops_performance_review_steps:[],ops_performance_followups:[],ops_si_handover_master:[{company_id:'c',settings:{}}],ops_store_ops_master:[{company_id:'c',settings:{}}],ops_si_shift_checklists:[],ops_store_ops_checklists:[]};
 const calls=[];let fail='';
 const db={from(table){let rows=tables[table]||[];const q={select:()=>q,eq:(k,v)=>{calls.push([table,k,v]);rows=rows.filter(r=>r[k]===v);return q},in:(k,vs)=>{rows=rows.filter(r=>vs.includes(r[k]));return q},is:(k,v)=>{rows=rows.filter(r=>(r[k]??null)===v);return q},lte:()=>q,or:()=>q,neq:()=>q,order:()=>q,maybeSingle:()=>Promise.resolve({data:rows[0],error:fail===table?{message:'offline'}:null}),then:r=>Promise.resolve({data:rows,error:fail===table?{message:'offline'}:null}).then(r)};return q}};
 const mod=compile('./amazon-now-digest.ts',{
 './portal-digest-delivery':{},'./adhoc-digest-scope':{adHocOpsRoles:new Set(),isAmazonNowMailStation:()=>true,loadAdHocMailScope:async()=>({stations:[station],recipients:[{email:'ops@example.com',name:'Ops',stationIds:['s1']}]})},
 './ops-pulse/people-review-routing':{syncPeopleReviewRoutes:async()=>{},allRoutingRows:async q=>{const r=await q;if(r.error)throw Error(r.error.message);return r.data}},
 './ops-pulse/si-handover/model':{normalizeSettings:()=>({shiftSlots:['due','future']}),nextShift:(_d,slot)=>({startMs:slot==='due'?0:Date.now()+86400000}),progress:()=>({answered:2,total:5})},
 './ops-pulse/store-ops/model':{normalizeSettings:()=>({}),progress:()=>({answered:3,total:5})},'./ops-pulse/store-ops/server':{periodCompletions:async()=>({weeklyDone:[],monthlyDone:[]})},
 './amazon-now-digest-view':{renderNowDigest,shiftDay}
 });
 const control={company_id:'c',event_key:review?'now_review_digest':'now_activity_digest',subject_template:'Now {{month}} {{year}}',config:{email_domain:'example.com',recipient_role_codes:['OPS'],send_zero_cases:true}};
 return {tables,calls,run:()=>mod.buildAmazonNowDigest(db,control,'2026-10-25'),fail:t=>{fail=t}};
}
test('review mail reads D−2 and never treats unavailable or missing source data as a completed review',async()=>{
 const f=builderFixture(true);const result=await f.run();assert.match(result.messages[0].html,/D−2 data missing/);assert.equal(result.messages[0].scope.pending,1);assert(f.calls.some(c=>c[0]==='report_metric_facts'&&c[1]==='report_date'&&c[2]==='2026-10-23'));
 f.fail('report_metric_facts');await assert.rejects(f.run(),/offline/);
});
test('completed follow-up actions do not keep a completed store review pending',async()=>{
 const f=builderFixture(true);
 f.tables.ops_performance_reviews.push({id:'r',company_id:'c',station_id:'s1',source_date:'2026-10-23',review_type:'daily_operations',source_type:'qc_store_health_daily',status:'closed'});
 f.tables.report_metric_facts.push({company_id:'c',station_code:'TCC3',report_date:'2026-10-23',source_type:'qc_store_health_daily',values_json:{score_pct:90}});
 f.tables.ops_performance_followups.push({company_id:'c',review_id:'r',status:'done',due_date:'2026-10-22'});
 const result=await f.run();assert.equal(result.messages[0].scope.pending,0);assert.match(result.messages[0].html,/0 open/);assert.doesNotMatch(result.messages[0].html,/overdue actions/);
});
test('activity mail keeps older pending work, excludes future handover slots and counts submitted separately',async()=>{
 const f=builderFixture(false);f.tables.ops_si_shift_checklists.push({company_id:'c',location_id:'s1',shift_date:'2026-10-24',shift_slot:'due',status:'submitted',incoming_name:'Incoming SI'},{company_id:'c',location_id:'s1',shift_date:'2026-10-23',shift_slot:'due',status:'open',outgoing_name:'Older SI'});f.tables.ops_store_ops_checklists.push({id:'d',company_id:'c',location_id:'s1',work_date:'2026-10-24',status:'submitted'});
 const result=await f.run();assert.match(result.messages[0].html,/0\/1 accepted/);assert.match(result.messages[0].html,/1 awaiting acceptance · 1 open \/ returned/);assert.doesNotMatch(result.messages[0].html,/not started/);assert.match(result.messages[0].html,/Older SI/);assert.equal(result.messages[0].scope.dataDate,'2026-10-24');
});
test('audit email stays compact while retaining action owners and deadlines',()=>{
 const {auditCompletionSummary}=compile('./ops-pulse/store-audits/mail-summary.ts',{'./model':{questions:t=>t.sections.flatMap(s=>s.questions),score:()=>80,scoreBand:()=> 'Watch'}});
 const questions=Array.from({length:10},(_,i)=>({id:String(i),label:'Gap <'+i+'>'}));
 const audit={store_name:'Store',number:'AUDIT-1',score:80,score_band:'Watch',template:{sections:[{questions}]},answers:Object.fromEntries(questions.map(q=>[q.id,{outcome:'gap',action:'Clean & verify',owner:'Store SI',dueAt:'2026-10-26T12:00:00Z'}]))};
 const result=auditCompletionSummary(audit,'https://ops.dropxlogistics.com/store-audits');assert.match(result.html,/10 findings/);assert.match(result.html,/\+2 more findings/);assert.match(result.html,/Clean &amp; verify/);assert.match(result.html,/Store SI/);assert.match(result.html,/IST/);assert.doesNotMatch(result.html,/<Gap/);assert.match(result.text,/2026/);
});
