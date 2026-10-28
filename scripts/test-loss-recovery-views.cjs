const ts=require('typescript'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=process.cwd(),cache=new Map();let data={},payoutCalls=[];
const db={rpc(name,args){if(name==='nl_recovery_deduction_month')return Promise.resolve({data:'2026-10',error:null});if(name==='loss_recovery_people')return Promise.resolve({data:[{ref:'workforce:w1',employee_code:'DF1',full_name:'Station worker',designation:'DA',is_active:true}],error:null});return Promise.resolve({data:null,error:null});},from(table){let rows=[...(data[table]||[])],single=false;const q=new Proxy({}, {get(_,k){if(k==='then')return resolve=>resolve({data:single?rows[0]||null:rows,error:null});return (...a)=>{if(k==='eq')rows=rows.filter(r=>r[a[0]]===a[1]);if(k==='in')rows=rows.filter(r=>a[1].includes(r[a[0]]));if(k==='range')rows=rows.slice(a[0],a[1]+1);if(k==='limit')rows=rows.slice(0,a[0]);if(k==='maybeSingle'||k==='single')single=true;return q;}}});return q;}};
function load(file){file=path.resolve(file);if(!path.extname(file))file+='.ts';if(cache.has(file))return cache.get(file).exports;const m={exports:{}};cache.set(file,m);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;new Function('require','module','exports',code)(id=>{
 if(id==='server-only')return {};
 if(id.endsWith('/supabase-admin'))return {supabaseAdmin:db};
 if(id.endsWith('/authorization'))return {hasPermission:()=>true};
 if(id.endsWith('/company-scope'))return {requireCompanyId:a=>a.companyId};
 if(id.endsWith('/people-operational-hierarchy'))return {loadPeopleOperationalHierarchy:async()=>({byLocation:new Map([['a',{clusterManagers:[{personId:'cm1',name:'Cluster A'}]}],['b',{areaOperationsManagers:[{personId:'aom1',name:'Area B'}]}]]),error:null})};
 if(id.endsWith('/workforce-payout-loader'))return {loadWorkforcePayoutRows:async(...a)=>{payoutCalls.push(a);return {rows:[{dropxId:'DF1',paymentDetailsAvailable:true,status:'Ready',netAmount:10000,grossPayment:12000}],error:null};}};
 if(id.startsWith('@/'))return load(path.join(root,'src',id.slice(2)));if(id.startsWith('.'))return load(path.join(path.dirname(file),id));return require(id);
},m,m.exports);return m.exports;}
const auth={companyId:'co',hasAllLocationAccess:false,locationScopeIds:['a','b'],readOnly:false};
const policy={salary_month_offset:1,salary_cap_enabled:true,salary_cap_percent:50,eligible_designations:[],reserve_other_recoveries:true,people_run_statuses:[],people_calculation_statuses:[],workforce_payout_statuses:['Ready']};
function row(key,station,amount,report='nl',status='Recoverable') {return {company_id:'co',month:'2026-09',period:'Aug-Sep',case_key:key,station_code:station,amount,report,source_status:status,source_present:true,data_source:'live',reason:'Ageing',status:'resolved',in_final:'true',details:{period:'Aug-Sep',category:'Ageing',in_final:true,case_status:'resolved'},last_seen_at:'2026-10-25'};}
data={stations:[{id:'a',company_id:'co',station_code:'ERSE',station_name:'Station A'},{id:'b',company_id:'co',station_code:'SPBE',station_name:'Station B'},{id:'x',company_id:'co',station_code:'OUTSIDE'}],cod_station_settings:[],nl_loss_sources:[{company_id:'co',recoverable_statuses:['Recoverable'],recovery_policy:policy,updated_at:'2026-10-25'}],nl_loss_month_cases:[row('nl:1','ERSE',27000),row('nl:2','SPBE',8000),row('nl:3','ERSE',4000,'nl','Non-Recoverable'),row('nl:4','OUTSIDE',99999),row('slp:1','SPBE',8200,'slp','SLP Final')],nl_loss_recoveries:[{company_id:'co',month:'2026-09',case_key:'nl:1',allocations:[],is_deleted:false}],nl_recovery_outcomes:[]};
(async()=>{
 const {loadNlLive}=load('src/lib/ops-pulse/nl-live.ts'),{loadRecoveryView}=load('src/lib/ops-pulse/nl-loss.ts');
 let v=await loadNlLive(auth,{station:'["ERSE","SPBE"]',cluster:'["cm:cm1","aom:aom1"]',sort:'value_asc'});
 assert.equal(v.cases.length,3);assert.equal(v.totals[0].station_code,'SPBE');assert.ok(v.cases.find(c=>c.case_key==='nl:1').recovery);assert.equal(v.cases.find(c=>c.case_key==='nl:3').recoverable,false);assert.equal(v.cases.find(c=>c.case_key==='nl:1').recoverable,true);assert.ok(v.cases.every(c=>c.station_code!=='OUTSIDE'));
 let final=await loadNlLive(auth,{station:'ERSE'},'final');assert.equal(final.cases.length,2);
 let pending=await loadNlLive(auth,{station:'ERSE'},'initial');assert.equal(pending.cases.length,0);
 data.nl_loss_month_cases.push({...row('pending','ERSE',200),status:'pending',stage:'eDSP2',details:{case_status:'pending',extra:{current_sla_stage:'eDSP2'}}});
 pending=await loadNlLive(auth,{station:'ERSE'},'initial');assert.equal(pending.cases.length,1);assert.equal(pending.cases[0].case_key,'pending');
 final=await loadNlLive(auth,{station:'ERSE'},'final');assert.equal(final.cases.length,2);
 data.nl_loss_month_cases.pop();
 v=await loadRecoveryView(auth,'nl',{station:'["ERSE","SPBE"]',reason:'Ageing'});assert.equal(v.cases.length,2);assert.equal(v.totals.reduce((s,t)=>s+t.amount,0),35000);
 v=await loadRecoveryView(auth,'slp_final',{station:'SPBE',period:'Aug-Sep'});assert.equal(v.cases.length,1);assert.equal(v.cases[0].amount,8200);
 assert.ok(v.overviewRows.every(c=>c.station_code==='SPBE'));
 const initialSlp={...row('slp:open','SPBE',500,'slp','SLP Initial'),in_initial:'true',in_final:'false',details:{period:'Aug-Sep',in_initial:true,in_final:false}};
 data.nl_loss_month_cases.push(initialSlp);
 v=await loadRecoveryView(auth,'slp_initial',{station:'SPBE',period:'Aug-Sep'});assert.deepEqual(v.cases.map(c=>c.case_key),['slp:open']);assert.deepEqual(v.overviewRows.map(c=>c.case_key),['slp:open']);
 data.nl_loss_month_cases.pop();
 v=await loadRecoveryView(auth,'nl',{cluster:'aom:aom1',station:'SPBE'});assert.equal(v.cases.length,1);assert.equal(v.cases[0].station_code,'SPBE');
 const {loadRecoveryPayables}=load('src/lib/ops-pulse/nl-recovery-payables.ts');data.workforce=[{id:'w1',company_id:'co',is_active:true,date_of_join:'2020-01-01'}];data.nl_loss_recoveries=[];
 const people=await loadRecoveryPayables(auth,'co','b','2026-09','slp:1',policy,'2026-10-25');assert.deepEqual(payoutCalls[0][4],{workforceIds:['w1'],includeLossRecoveries:false});assert.equal(payoutCalls[0][1].hasAllLocationAccess,true,'All-location pay for selected people remains included');assert.equal(people[0].recovery_limit,5000);assert.equal(people[0].salary_gross,12000);assert.equal(people[0].salary_month,'2026-10');assert.equal(payoutCalls[0][2],'2026-10-01');
 payoutCalls.length=0;await loadRecoveryPayables(auth,'co','b','2026-09','slp:1',policy,'2026-10-25',[]);assert.equal(payoutCalls.length,0,'No salary calculation for unselected employees');
 console.log('PASS actual loss loaders: scoped multi-station/cluster/reason filters, recoverable NL plans, non-recoverable exclusion, SLP Final, scoped salary calculation retaining cap.');
})().catch(e=>{console.error(e);process.exitCode=1});
