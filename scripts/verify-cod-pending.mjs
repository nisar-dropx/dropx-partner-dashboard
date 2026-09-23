import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function compile(file,deps={}){const exports={};new Function('require','exports',ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(n=>deps[n]??require(n),exports);return exports;}
const policy=compile('src/lib/ops-pulse/cod-pending.ts'),ageing=compile('src/lib/ops-pulse/cod-ageing.ts');
const station={id:'s1',station_code:'NLRC',station_name:'Station one',providers:{code:'AMAZON'},location_models:{code:'EDSP'}};
const other={...station,id:'s2',station_code:'GNTI'};
const date='2026-09-02',now=new Date('2026-09-02T15:00:00Z');
const slip={id:'a',location_id:'s1',deposit_date:date,cod_period_from:'2026-08-30',cod_period_to:'2026-09-01',cod_date:null,remittance_code:'AC1',reference_no:null,deposited_amount:100,validated_amount:100,validation_status:'Matched',remarks:null,validation_remarks:null,submitter_name:'Team',created_at:'2026-09-02T14:00:00Z',deposit_slip_attachments:[{storage_path:'proof.png',storage_bucket:'slips'}],attachments:[]};
let rows=policy.buildCodPendingRows([station,other],[slip],date,now);
assert.equal(rows.find(r=>r.station.id==='s2').status,'Missing slip');
assert.equal(rows.find(r=>r.station.id==='s2').overdue,true);
assert.equal(rows.find(r=>r.station.id==='s1').status,'Complete');
assert.equal(policy.buildCodPendingRows([station],[slip],date,new Date('2026-09-02T14:59:59Z'))[0].overdue,false);
assert.equal(policy.buildCodPendingRows([station],[{...slip,deposit_date:'2026-09-01'}],date,now)[0].status,'Missing slip','Do not match by covered COD period');
assert.equal(policy.buildCodPendingRows([station],[{...slip,deposited_amount:80}],date,now)[0].short,20);
assert.equal(policy.buildCodPendingRows([station],[{...slip,deposited_amount:80},{...slip,id:'b',remittance_code:'AC2',deposited_amount:120}],date,now)[0].short,20,'Excess cannot cancel another shortage');
assert.equal(policy.buildCodPendingRows([station],[{...slip,deposit_slip_attachments:[]}],date,now)[0].status,'Slip missing proof');
const duplicate=policy.buildCodPendingRows([station],[slip,{...slip,id:'b',created_at:'2026-09-02T14:01:00Z'}],date,now)[0];
assert.equal(duplicate.amount,100);assert.equal(duplicate.duplicates,1);assert.equal(duplicate.status,'Duplicate review');
assert.equal(policy.buildCodPendingRows([station],[{...slip,validated_amount:null,validation_status:'Pending'}],date,now)[0].expected,null);
assert.equal(policy.buildCodPendingRows([station],[{...slip,created_at:'2026-09-03T03:00:00Z'}],date,new Date('2026-09-03T03:30:00Z'))[0].late,true);
assert.equal(policy.buildCodPendingRows([{...station,station_code:'TEST 2'},{...station,hide_from_location_list:true}],[],date,now).length,0);
assert.equal(policy.validReportDate('2026-02-30'),false);assert.equal(policy.validReportDate('2026-02-28'),true);
assert.match(policy.codPendingCsv([{...rows[0],station:{...station,station_name:'=HYPERLINK("bad")'}}]),/'=HYPERLINK/);
const line=(bucket,amount,pendingDate='2026-08-01')=>({bucket,amount,pendingDate,rowNumber:1,trackingId:'T',associate:'User',associateId:'x',orderId:'O',status:'Pending',overdue:true});
const age=ageing.buildAgeingStation('NLRC',[line('2 DAYS',100),line('3-4 DAYS',200),line('5-7 DAYS',300),line('2021',50,'2021-01-01'),line('0-1 DAYS',500)],'2026-09-01');
assert.equal(age.total,650);assert.equal(age.overTwo,550);assert.equal(age.recent,500);assert.equal(age.bands['Other / older'],50);
assert.equal(ageing.previousCodDate('2026-09-01'),'2026-08-31');
const scope=compile('src/lib/cod-pending-mail-scope.ts',{'server-only':{},'./ops-pulse/cod-pending-data':{}});
const profiles=[{id:'u',email:'user@example.com',full_name:'User'}],roles=[{id:'r',code:'OPERATIONS_STM',location_access_mode:'role_based'}];
const memberships=[{user_id:'u',role_id:'r',has_all_location_access:false,location_scope_ids:['s1']}];
assert.deepEqual(scope.resolveCodRecipients([station,other],memberships,roles,profiles,new Set(['r']),'example.com')[0].stationIds,['s1']);
assert.equal(scope.resolveCodRecipients([station],memberships,roles,profiles,new Set(),'example.com').length,0);
assert.equal(scope.resolveCodRecipients([station],memberships,roles,profiles,new Set(['r']),'other.com').length,0);
const digest=compile('src/lib/cod-pending-digest.ts',{'./ops-pulse/cod-pending-data':{},'./ops-pulse/cod-ageing-data':{},'./ops-pulse/cod-ageing':ageing,'./cod-pending-mail-scope':scope});
const source={uploadDate:date,dataDate:'2026-09-01',batchId:'batch1',importedAt:'2026-09-02T08:30:00Z',fileName:'file.csv',error:null,stations:[age,{...age,stationCode:'GNTI',total:999999}]};
const recipients=[{email:'user@example.com',name:'User',stationIds:['s1']}];
const evening=digest.buildCodDigestMessages(rows,source,recipients,date,'evening','OpsPulse | COD report | {{month}} {{year}}')[0];
const morning=digest.buildCodDigestMessages(rows,source,recipients,date,'morning','OpsPulse | COD report | {{month}} {{year}}')[0];
assert.equal(evening.subject,morning.subject);assert.match(evening.html,/2026-09-01/);assert.match(morning.html,/9:00 AM follow-up/);assert.equal(evening.scope.sourceBatchId,morning.scope.sourceBatchId);assert.ok(!evening.html.includes('GNTI'));assert.ok(!evening.html.includes('999999'));
assert.equal(digest.buildCodDigestMessages(rows,{...source,stations:[]},recipients,date,'morning',evening.subject).length,1,'Each recipient gets the daily uploaded/not-uploaded status report, including all-complete confirmation');
assert.match(evening.html,/YES — uploaded/);
const locationMail=digest.buildCodDigestMessages(rows,source,[{...recipients[0],canViewPendingReport:false}],date,'morning',evening.subject)[0];
assert.ok(locationMail.html.includes('/cod/submission?deposit_date='+date));
assert.ok(!locationMail.html.includes('/cod/pending'));
assert.equal(rows.find(r=>r.station.id==='s1').slipUploaded,true);
assert.equal(rows.find(r=>r.station.id==='s2').slipUploaded,false);
const delivery=compile('src/lib/portal-digest-delivery.ts',{'server-only':{},'./timeout-fetch':{timeoutFetch:f=>f},'./adhoc-digest-scope':{},'./cod-pending-mail-scope':{},'./ops-pulse/cod-pending-data':{}});
const control={state:'enabled',paused_until:null,config:{delivery_ready:true,timezone:'Asia/Kolkata',schedule_time:'20:30',day_offset:0,delivery_window_minutes:30,first_report_date:'2026-09-01'}};
assert.equal(delivery.dueReportDate(control,new Date('2026-09-02T14:59:59Z')),null);
assert.equal(delivery.dueReportDate(control,now),date);
assert.equal(delivery.dueReportDate(control,new Date('2026-09-02T16:00:00Z')),null);
assert.equal(delivery.dueReportDate({...control,config:{...control.config,schedule_time:'09:00',day_offset:-1}},new Date('2026-09-03T03:30:00Z')),date);
assert.equal(delivery.dueReportDate({...control,state:'paused'},now),null);
const limited={...control,config:{...control.config,last_report_date:'2026-09-02'}};
assert.equal(delivery.dueReportDate(limited,now),date);
assert.equal(delivery.dueReportDate(limited,new Date('2026-09-03T15:00:00Z')),null,'Emails stop after the last report date');
assert.equal(delivery.dueReportDate({...limited,config:{...limited.config,schedule_time:'09:00',day_offset:-1}},new Date('2026-09-03T03:30:00Z')),date,'Keep the final next-morning follow-up');
assert.equal(delivery.dueReportDate({...limited,config:{...limited.config,schedule_time:'09:00',day_offset:-1}},new Date('2026-09-04T03:30:00Z')),null);
assert.notEqual(delivery.digestThreadKey('c','ops','cod_pending_evening','u','2026-09'),delivery.digestThreadKey('c','ops','cod_pending_evening','u','2026-10'));
// Loader integration: failed imports do not create a zero report; morning has the same source cutoff.
const data=compile('src/lib/ops-pulse/cod-pending-data.ts',{'server-only':{},'./cod-pending':policy});
let pages=0;await assert.rejects(()=>data.pagedCodRows(async()=>{pages++;return {data:null,error:{message:'db failure'}}}),/db failure/);assert.equal(pages,1);
let filters=[];const fakeDb={from(table){const q={};for(const method of ['select','eq','is','gte','lte','in','order','limit','range'])q[method]=(...args)=>{filters.push([table,method,...args]);return q;};q.maybeSingle=async()=>({data:{id:'batch1',file_name:'file',created_at:'2026-09-02T08:30:00Z',completed_at:'2026-09-02T08:31:00Z',row_count:0},error:null});q.then=(a,b)=>Promise.resolve({data:[],count:0,error:null}).then(a,b);return q;}};
const ageData=compile('src/lib/ops-pulse/cod-ageing-data.ts',{'server-only':{},'./review-cod':{},'./cod-pending-data':data,'./cod-pending':policy,'./cod-ageing':ageing});
const loaded=await ageData.loadCodAgeing(fakeDb,'company',date,['NLRC']);assert.equal(loaded.dataDate,'2026-09-01');assert.equal(loaded.batchId,'batch1');assert.ok(filters.some(f=>f[1]==='lte'&&f[2]==='completed_at'&&f[3]==='2026-09-02T20:30:00+05:30'));
console.log('PASS COD: missing stations, deposit-date matching, proof, short/excess, duplicates, deadlines, late uploads, scope, safe exports, D-1 ageing, >2-day alerts, pinned source cutoff, monthly email subject and both reminder windows.');
const access=compile('src/lib/ops-pulse/cod-pending-access.ts',{'@/lib/authorization':{hasPermission:a=>a.allowed}});
for(const roleCode of ['LOCATION','OPERATIONS_LOCATION','PEOPLE_LOCATION'])assert.equal(access.canAccessDailyCodPending({allowed:true,roleCode}),false);
assert.equal(access.canAccessDailyCodPending({allowed:true,roleCode:'OPERATIONS_CM'}),true);
assert.equal(access.canAccessDailyCodPending({allowed:true,roleCode:'OPERATIONS_CM',effectiveRoleCodes:['OPERATIONS_LOCATION']}),false);
let auth=null;
const api=compile('src/app/api/ops-pulse/cod/pending/export/route.ts',{
 '@/lib/authorization':{getAuthorization:async()=>auth},'@/lib/ops-pulse/cod-pending-access':access,'@/lib/supabase-admin':{supabaseAdmin:{}},'@/lib/ops-pulse/cod-pending-data':{loadCodPendingReport:async()=>rows},'@/lib/ops-pulse/cod-pending':policy,'@/lib/ops-pulse/cod-ageing-data':{},'@/lib/ops-pulse/cod-ageing':ageing
});
const req=(q)=>new Request('https://ops.example/api/ops-pulse/cod/pending/export?'+q);
assert.equal((await api.GET(req('date='+date))).status,401);
auth={allowed:false};assert.equal((await api.GET(req('date='+date))).status,403);
auth={allowed:true,companyId:'company',hasAllLocationAccess:true,locationScopeIds:[],roleCode:'OPERATIONS_LOCATION'};
assert.equal((await api.GET(req('date='+date))).status,403,'Location account cannot export even with all-station scope');
assert.equal((await api.GET(req('date='+date+'&type=ageing'))).status,403);
auth={allowed:true,companyId:'company',hasAllLocationAccess:false,locationScopeIds:['s1'],roleCode:'OPERATIONS_CM'};
assert.equal((await api.GET(req('date=2026-02-30'))).status,400);
assert.equal((await api.GET(req('date='+date+'&location=s2'))).status,403);
const downloaded=await api.GET(req('date='+date+'&location=s1&status=all'));assert.equal(downloaded.status,200);assert.ok((await downloaded.text()).includes('NLRC'));
assert.match(downloaded.headers.get('Cache-Control'),/no-store/);
console.log('PASS COD export: signed-out denial, permission denial, invalid dates, station access and private download.');
// SMTP is mocked: the morning message must reply to the evening thread, not create a second monthly thread.
const currentDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
let mailOptions=null,threadFilters=[];
const sendModule=compile('src/lib/portal-digest-delivery.ts',{
 'server-only':{},'./timeout-fetch':{},'./adhoc-digest-scope':{},
 './cod-pending-mail-scope':{loadCodMailRecipients:async()=>[{email:'user@example.com',stationIds:['s1']}]},
 './ops-pulse/cod-pending-data':{loadCodPendingReport:async()=>[{station}]},
 nodemailer:{default:{createTransport:()=>({sendMail:async options=>{mailOptions=options;return {accepted:['user@example.com'],messageId:options.messageId,response:'mock accepted'};},close(){}})}}
});
const responses={
 portal_notification_controls:{state:'enabled',config:{delivery_ready:true,timezone:'Asia/Kolkata',schedule_time:'00:00',day_offset:0,email_domain:'example.com'}},
 email_notification_settings:{is_enabled:true,smtp_host:'mock.invalid',smtp_from:'mail@example.com',smtp_pass:'mock',smtp_port:587,smtp_user:'mock'},
 profiles:[{id:'u'}],portal_digest_threads:{root_message_id:'<evening-root@example.com>',last_message_id:'<evening-last@example.com>',subject:'COD | monthly'},
 portal_digest_deliveries:{scope_summary:{stationIds:['s1']}}
};
const mailDb={rpc:async(name)=>name==='portal_finish_digest'?{data:true,error:null}:{data:[{id:'delivery1',company_id:'c',event_key:'cod_pending_morning',recipient_email:'user@example.com',report_date:currentDate,subject:'COD | monthly',html:'mock',body:'mock'}],error:null},from(table){const q=new Proxy({}, {get(_,key){if(key==='then')return(resolve)=>resolve({data:responses[table],error:null});return(...args)=>{if(table==='portal_digest_threads')threadFilters.push([key,...args]);return q;};}});return q;}};
const sent=await sendModule.deliverPortalDigestQueue(mailDb,'ops',{queued:0,accepted:0,uncertain:0,skipped:0,errors:[]});
assert.equal(sent.accepted,1);assert.equal(mailOptions.inReplyTo,'<evening-last@example.com>');assert.deepEqual(mailOptions.references,['<evening-root@example.com>','<evening-last@example.com>']);assert.ok(threadFilters.some(f=>f[0]==='in'&&f[1]==='event_key'&&f[2].includes('cod_pending_evening')));
mailOptions=null;responses.portal_digest_deliveries={scope_summary:{stationIds:['s2']}};
const held=await sendModule.deliverPortalDigestQueue(mailDb,'ops',{queued:0,accepted:0,uncertain:0,skipped:0,errors:[]});assert.equal(held.skipped,1);assert.equal(mailOptions,null);
console.log('PASS COD delivery: evening/morning share monthly thread; removed station scope prevents SMTP.');
