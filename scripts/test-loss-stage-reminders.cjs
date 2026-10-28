const ts=require('typescript'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
function load(file){file=path.resolve(file);if(!path.extname(file))file+='.ts';const m={exports:{}};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;new Function('require','module','exports',code)(id=>id.startsWith('.')?load(path.join(path.dirname(file),id)):require(id),m,m.exports);return m.exports;}
const p=load('src/lib/loss-reminder-policy'),render=load('src/lib/loss-reminder-render').renderLossReminder;
for(let d=1;d<=31;d++){const date=`2026-10-${String(d).padStart(2,'0')}`;assert.equal(p.lossReminderInWindow('recovery',date),d<=5||d>=20);assert.equal(p.lossReminderInWindow('dispute',date),d>=7&&d<=11);assert.equal(p.lossReminderInWindow('response',date),d>=11&&d<=20);}
assert.equal(p.lossReminderThreadMonth('loss_reminder_recovery_morning','2027-01-05'),'2026-12');
for(const event of ['now_insight_morning','now_insight_evening','now_review_digest','cod_pending_evening'])for(const day of ['2027-01-01','2027-01-05','2027-01-31'])assert.equal(p.lossReminderThreadMonth(event,day),'2027-01');assert.equal(p.lossReminderThreadMonth('loss_reminder_dispute_morning','2027-01-07'),'2027-01');
const station={id:'s1',station_code:'DEMO1',source_code:'DS1',station_name:'Example station',cluster:'Example cluster'};
const c={month:'2026-09',case_key:'001234567890',station_code:'DS1',report:'nl',amount:8000,source_present:true,source_status:'Recoverable',data_source:'live',final_seen_at:null,lifecycle_status:'recovery_approved_scheduled',last_seen_at:'2026-10-28T06:00:00Z',source_updated_at:null,details:{tid:'001234567890',case_status:'resolved',extra:{current_sla_stage:'NL2'}}};
const input={date:'2026-10-28',stations:[station],cases:[c],plans:[],requests:[],redisputes:[],recoverableStatuses:['Recoverable']};
assert.equal(p.selectLossReminderRows('recovery',input)[0].pending,true);
const plan={month:c.month,case_key:c.case_key,approval_status:'proposed',source_amount:8000,source_status:'Recoverable',outcome_code:'recover_employee',allocations:[{amount:8000}]};
assert.equal(p.selectLossReminderRows('recovery',{...input,plans:[plan]})[0].pending,false);
assert.equal(p.selectLossReminderRows('recovery',{...input,plans:[{...plan,approval_status:'returned'}]})[0].pending,true);
assert.equal(p.selectLossReminderRows('recovery',{...input,redisputes:[{month:c.month,case_key:c.case_key,enabled:true,workflow_status:'awaiting_station'}]}).length,0);
assert.equal(p.selectLossReminderRows('recovery',{...input,stations:[]}).length,0);
const response={...c,source_status:'Pending',details:{case_status:'pending',extra:{current_sla_stage:'eDSP2'}}};
assert.equal(p.selectLossReminderRows('response',{...input,cases:[response]}).length,1);
assert.equal(p.selectLossReminderRows('dispute',{...input,cases:[response]}).length,0);
assert.equal(p.selectLossReminderRows('response',{...input,cases:[response],requests:[{month:c.month,case_key:c.case_key,status:'submitted',source_stage:'eDSP2'}]}).length,0);
assert.equal(p.selectLossReminderRows('response',{...input,cases:[response],requests:[{month:c.month,case_key:c.case_key,status:'submitted',source_stage:'eDSP1'}]}).length,1);
const rows=p.selectLossReminderRows('recovery',input);const mail=render({stage:'recovery',event:'loss_reminder_recovery_morning',date:'2026-10-28',rows,checkedAt:c.last_seen_at,sample:true});
assert.match(mail.html,/EXAMPLE DATA/);const XLSX=require('xlsx');const wb=XLSX.read(Buffer.from(mail.attachment.content,'base64'));assert.equal(wb.Sheets['NL pending'].E2.v,'001234567890');assert.equal(wb.Sheets['NL pending'].F2.v,8000);
const separate=render({stage:'recovery',event:'loss_reminder_recovery_morning',date:'2026-10-28',rows:[...rows,{...rows[0],report:'SLP Final',shipmentId:'999999999999',amount:1200},{...rows[0],report:'SLP Final',shipmentId:'888888888888',amount:2300,pending:false}],checkedAt:c.last_seen_at});
assert.match(separate.text,/NL: 1 pending \/ ₹8,000, 0 updated \/ ₹0 \| SLP: 1 pending \/ ₹1,200, 1 updated \/ ₹2,300/);
const separateBook=XLSX.read(Buffer.from(separate.attachment.content,'base64'));
assert.deepEqual(separateBook.SheetNames,['Station summary','NL pending','SLP pending']);
assert.equal(separateBook.Sheets['SLP pending'].F2.v,1200);
assert.equal(p.lossReminderEdition('loss_reminder_recovery_morning'),'11:00 a.m.');assert.equal(p.lossReminderEdition('loss_reminder_recovery_afternoon'),'4:00 p.m.');
const once={schedule_time:'16:00',one_time_schedule:{date:'2026-10-28',time:'17:00'}};
assert.equal(p.lossReminderScheduleTime('loss_reminder_recovery_afternoon','2026-10-28',once),'17:00');
assert.equal(p.lossReminderScheduleTime('loss_reminder_recovery_afternoon','2026-10-29',once),'16:00');
assert.equal(p.lossReminderScheduleTime('cod_pending_evening','2026-10-28',once),'16:00');
const deliveryModule={exports:{}};
new Function('require','module','exports',ts.transpileModule(fs.readFileSync('src/lib/portal-digest-delivery.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>id==='./loss-reminder-policy'?p:{},deliveryModule,deliveryModule.exports);
const onceControl={company_id:'sample',portal:'ops',event_key:'loss_reminder_recovery_afternoon',state:'enabled',paused_until:null,config:{...once,delivery_ready:true,timezone:'Asia/Kolkata',delivery_window_minutes:60,day_offset:0,first_report_date:'2026-10-28'}};
for(const [at,expected] of [['2026-10-28T10:30:00Z',null],['2026-10-28T11:29:59Z',null],['2026-10-28T11:30:00Z','2026-10-28'],['2026-10-28T12:31:00Z',null],['2026-10-29T10:29:59Z',null],['2026-10-29T10:30:00Z','2026-10-29']])assert.equal(deliveryModule.exports.dueReportDate(onceControl,new Date(at)),expected,at);
const fivePm=render({stage:'recovery',event:'loss_reminder_recovery_afternoon',date:'2026-10-28',scheduledTime:'17:00',rows,checkedAt:c.last_seen_at});
assert.match(fivePm.html,/5:00 p.m./);assert.match(fivePm.text,/5:00 p.m./);assert.equal(fivePm.subject,mail.subject);

assert.deepEqual(p.lossReminderMonths('2027-01-01'),['2026-12','2027-01']);
assert.deepEqual(p.lossReminderMonths('2026-11-05'),['2026-10','2026-11']);
// Apply the same date limit to NL/SLP, pending/updated, preview, totals and Excel.
const mixed=[];
for(const month of ['2026-08','2026-09','2026-10','2026-11'])for(const report of ['nl','slp'])mixed.push({...c,month,report,case_key:report+month,final_seen_at:c.last_seen_at});
assert.equal(p.lossReminderIncludesMonth('recovery','2026-11-05','nl','2026-09'),true);
assert.equal(p.lossReminderIncludesMonth('recovery','2026-11-20','nl','2026-10'),true);
assert.equal(p.lossReminderIncludesMonth('recovery','2027-01-20','nl','2026-12'),true);
const recent=p.selectLossReminderRows('recovery',{...input,cases:mixed});
assert.equal(recent.length,3);
assert.deepEqual([...new Set(recent.map(r=>r.month))],['2026-09','2026-10']);
const guarded=render({stage:'recovery',event:'loss_reminder_recovery_morning',date:input.date,rows:[...recent,{...recent[0],month:'2026-08',shipmentId:'OLD-PENDING',amount:999999},{...recent[0],month:'2026-08',shipmentId:'OLD-UPDATED',pending:false,amount:999999}],checkedAt:c.last_seen_at});
assert.equal(guarded.pending,3);assert.match(guarded.html,/NL: Sept? 2026 · SLP: Sept? 2026 – Oct 2026/);
const guardedBook=XLSX.read(Buffer.from(guarded.attachment.content,'base64'));
for(const name of ['NL pending','SLP pending']){const rows=XLSX.utils.sheet_to_json(guardedBook.Sheets[name]);assert.equal(rows.length,name==='NL pending'?1:2);assert.deepEqual(rows.map(r=>r['Loss month']),name==='NL pending'?['2026-09']:['2026-09','2026-10']);}
assert.equal(guardedBook.Sheets['Station summary'].D2.v,8000);assert.equal(guardedBook.Sheets['Station summary'].F2.v,0);

if(process.argv.includes('--samples')){
 fs.mkdirSync('output/loss-reminders',{recursive:true});
 for(const stage of p.LOSS_REMINDER_STAGES){
  const example=[];for(let s=0;s<3;s++)for(let n=0;n<5+s;n++)example.push({...rows[0],month:stage==='recovery'?'2026-09':'2026-10',stationId:'sample-'+s,station:['DEMO1','DEMO2','DEMO3'][s],owner:['Cluster A','Cluster B','Area manager C'][s],shipmentId:'90000000'+String(s*100+n).padStart(4,'0'),amount:[1250,2300,800][s]+n*100,report:stage==='recovery'&&n%2?'SLP Final':'NL',pending:stage!=='recovery'||n!==0,status:stage==='recovery'?'Recovery update pending':stage==='dispute'?'Dispute / accept pending':'Station response pending'});
  const r=render({stage,event:`loss_reminder_${stage}_morning`,date:stage==='dispute'?'2026-11-09':stage==='response'?'2026-11-16':'2026-10-28',rows:example,checkedAt:(stage==='dispute'?'2026-11-09':stage==='response'?'2026-11-16':'2026-10-28')+'T05:30:00Z',sample:true});fs.writeFileSync(`output/loss-reminders/${stage}.html`,r.html);fs.writeFileSync(`output/loss-reminders/${stage}.xlsx`,Buffer.from(r.attachment.content,'base64'));
 }
 fs.writeFileSync('output/loss-reminders/index.html','<!doctype html><meta charset="utf-8"><title>OpsPulse mail samples</title><style>body{font:15px Arial;background:#eef2f7;margin:25px;color:#17243b}a{color:#b54716}iframe{border:0;width:100%;height:690px}</style><h2>OpsPulse · Loss action emails</h2><p>Example data only · Three compact formats · 11 a.m. and 4 p.m. IST</p>'+p.LOSS_REMINDER_STAGES.map(stage=>`<section><a href="${stage}.html">Open ${stage} email</a> · <a href="${stage}.xlsx">Sample Excel</a><iframe src="${stage}.html"></iframe></section>`).join(''));
}
console.log('PASS reminder windows, thread boundaries, stage isolation, update/redispute handling, scope and Excel types');
