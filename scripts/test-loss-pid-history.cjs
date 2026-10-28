const ts=require('typescript'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
let auth={companyId:'C'},failSource=false;
const cases=[{company_id:'C',month:'2026-09',case_key:'A',station_code:'S',details:{tid:'0001'},source_present:false},
 {company_id:'C',month:'2025-01',case_key:'B',station_code:'S',details:{tid:'0001'}},
 {company_id:'C',month:'2026-09',case_key:'SECRET',station_code:'X',details:{tid:'0001'}},
 {company_id:'OTHER',month:'2026-09',case_key:'A',station_code:'S',details:{tid:'0001'}}];
const data={nl_loss_month_cases:cases,nl_loss_source_events:Array.from({length:601},(_,i)=>({id:String(i).padStart(4,'0'),company_id:'C',month:'2025-01',case_key:'B',actor_name:'Source sync',created_at:'2025-01-01',action:'Source updated',after_value:{amount:i}})),
 nl_loss_recovery_events:[{id:'r',company_id:'C',month:'2026-09',case_key:'A',created_at:'2026-10-28',actor_name:'Editor',after_value:{outcome_label:'Recover'}},{id:'secret',company_id:'C',month:'2026-09',case_key:'SECRET',created_at:'2026-10-28',actor_name:'Secret'}],
 nl_loss_exception_events:[{id:'ex',company_id:'C',month:'2026-09',case_key:'A',created_at:'2026-10-28',actor_name:'Approver',after_value:{kind:'installments',enabled:true}}],
 nl_loss_clarifications:[{id:'q',company_id:'C',month:'2026-09',case_key:'A'}],nl_loss_clarification_events:[{id:'qe',company_id:'C',clarification_id:'q',action:'resolved',created_at:'2026-10-28',actor_name:'Resolver',note:'Explained'}]};
const db={from(table){let rows=[...(data[table]||[])];const q={select(){return q},eq(key,value){rows=rows.filter(r=>(key==='details->>tid'?r.details?.tid:r[key])===value);return q},in(key,values){rows=rows.filter(r=>values.includes(r[key]));return q},order(){return q},maybeSingle:async()=>({data:rows[0]||null,error:null}),range:async(a,b)=>({data:rows.slice(a,b+1),error:failSource&&table==='nl_loss_source_events'?{message:'unavailable'}:null})};return q;}};
function load(file){file=path.resolve(file);if(!path.extname(file))file+='.ts';const m={exports:{}};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('require','module','exports',code)(id=>{if(id==='server-only')return{};if(id.endsWith('/authorization'))return{getAuthorization:async()=>auth,hasPermission:a=>!a.denied};if(id.endsWith('/supabase-admin'))return{supabaseAdmin:db};if(id.endsWith('/nl-loss'))return{nlStationScope:async()=>({company:'C',stations:[{source_code:'S'}]}),loadRecoveryView:async()=>({cases:[{...cases[0],source_updated_at:'2026-10-28T03:00:00Z',amount:100,source_status:'Recoverable',recovery:null}],totals:[],outcomes:[],settings:null})};if(id.endsWith('/nl-loss-lifecycle'))return{};if(id.endsWith('/nl-recovery-payables'))return{};if(id.startsWith('@/'))return load('src/'+id.slice(2));if(id.startsWith('.'))return load(path.join(path.dirname(file),id));return require(id);},m,m.exports);return m.exports;}
(async()=>{const api=load('src/app/api/ops-pulse/losses/history/route.ts');const get=(key='A')=>api.GET(new Request(`https://ops.test/api/ops-pulse/losses/history?month=2026-09&case=${key}`));
 let result=await get();assert.equal(result.status,200);let body=await result.json();assert.equal(body.events.length,604);assert.equal(body.events.some(e=>e.actor==='Secret'),false);assert.equal(body.events.some(e=>e.source==='Clarification'),true);
 assert.equal((await get('SECRET')).status,403);auth=null;assert.equal((await get()).status,403);auth={denied:true};assert.equal((await get()).status,403);auth={readOnly:true};assert.equal((await get()).status,200);
 failSource=true;assert.equal((await get()).status,500,'A source failure cannot silently present an incomplete history');
 failSource=false;auth={companyId:'C'};
 const workbook=load('src/app/api/ops-pulse/losses/workbook/route.ts');
 const exported=await workbook.GET(new Request('https://ops.test/api/ops-pulse/losses/workbook?kind=nl'));
 assert.equal(exported.status,200);
 const XLSX=require('xlsx'),book=XLSX.read(Buffer.from(await exported.arrayBuffer()),{type:'buffer'});
 const caseRows=XLSX.utils.sheet_to_json(book.Sheets.Cases);
 assert.equal(caseRows[0].TID,'0001','Excel preserves leading-zero shipment IDs');
 assert.equal(caseRows[0]['History updates'],3);assert.ok(caseRows[0]['Last updated by']);
 const audit=XLSX.utils.sheet_to_json(book.Sheets['PID history']);assert.equal(audit.length,4);assert.ok(audit.every(r=>r['PID / TID']==='0001'));
 failSource=true;assert.notEqual((await workbook.GET(new Request('https://ops.test/api/ops-pulse/losses/workbook?kind=nl'))).status,200);
 console.log('PASS actual workbook endpoint: last-update columns, full scoped history, leading-zero IDs and visible history-source failure');
 console.log('PASS PID history: multiple sources/months, 500-row pagination, removed source, company/station/read-only access and fail-closed completeness');
})().catch(e=>{console.error(e);process.exitCode=1;});
