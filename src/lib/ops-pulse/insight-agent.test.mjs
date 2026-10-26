import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import ts from 'typescript';
const require=createRequire(import.meta.url),cache=new Map();
function load(name){const file=path.resolve('src/lib/ops-pulse',name+'.ts');if(cache.has(file))return cache.get(file);const m={exports:{}};cache.set(file,m.exports);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;new Function('require','module','exports',code)(n=>n.startsWith('./')?load(n.slice(2).replace(/\.ts$/,'')):require(n),m,m.exports);return m.exports;}
const {summarizeAssistantAttendance}=load('assistant-attendance'),{signAssistantReport,verifyAssistantReport}=load('assistant-report-token'),{storeInsightFacts}=load('insight-facts'),{renderInsightEmail}=load('insight-email'),{validateInsightBrief}=load('insight-editor'),{assistantModelRead}=load('assistant-model-read');
test('punctuality and attendance exclude approved leave, holidays, open shifts and ambiguous days',()=>{
 const history={station:'TCC3',people:[{id:'a',name:'A',code:'a',role:'Picker',days:['on_time','late','unplanned_absence','leave','holiday','attendance_conflict','upcoming'].map((status,i)=>({date:`2026-10-0${i+1}`,status,lateMinutes:status==='late'?12:null}))}]};
 const r=summarizeAssistantAttendance([history],'2026-10-01','2026-10-07',{role:'picker'});assert.equal(r.rows[0].attendancePct,66.7);assert.equal(r.rows[0].punctualityPct,50);assert.equal(r.rows[0].unresolved,1);assert.equal(r.rows[0].rankingEligible,false);assert.deepEqual(r.topAttendance,[]);assert.equal(r.rows[0].lateMinutes,12);
 assert.equal(summarizeAssistantAttendance([history],'2026-10-01','2026-10-07',{role:'manager'}).totals.people,0);
});
test('sample eligibility is explicit and outside-store days never count',()=>{
 const r=summarizeAssistantAttendance([{station:'S',people:[{id:'a',name:'A',code:'A',role:'Picker',days:['on_time','on_time','on_time','outside_station'].map((status,i)=>({date:`2026-10-0${i+1}`,status}))}]}],'2026-10-01','2026-10-04');assert.equal(r.topPunctuality[0].reported,3);assert.equal(r.rows[0].evidenceDays,3);
});
const report={version:1,userId:'u',companyId:'c',stationIds:['s'],darkStore:true,question:'Picker report',answer:'A verified answer',checkedAt:'2026-10-27',expiresAt:1000,reads:[{name:'ops_attendance_analysis',data:{value:1}}]},actor={userId:'u',companyId:'c',stationIds:['s'],darkStore:true};
test('exports bind user, company, module permission, mode, store scope, expiry and signature',()=>{
 const token=signAssistantReport(report,'secret');assert.equal(verifyAssistantReport(token,'secret',actor,['ops_attendance_analysis'],999).question,report.question);
 for(const change of [{userId:'other'},{companyId:'other'},{stationIds:[]},{darkStore:false}])assert.throws(()=>verifyAssistantReport(token,'secret',{...actor,...change},['ops_attendance_analysis'],999));
 assert.throws(()=>verifyAssistantReport(token,'secret',actor,[],999));assert.throws(()=>verifyAssistantReport(token,'secret',actor,['ops_attendance_analysis'],1001));assert.throws(()=>verifyAssistantReport(token+'x','secret',actor,['ops_attendance_analysis'],999));assert.equal(signAssistantReport(report,''),null);
});
test('scorecard qualifiers, dates, missing stores and newest revision survive summarization',()=>{
 const facts=storeInsightFacts([{id:'s',station_code:'TCD4',station_name:'Nesapakkam'},{id:'missing',station_code:'TTG9'}],[{station_code:'TCD4',report_date:'2026-10-25',created_at:'2026-10-26',values_json:{score_pct:29,band:'Critical',points_available:79,points_earned:23,metrics:{reconciliation:{scored:true,status:'Red',actual_text:'100% (87% not reconciled)',target_text:'98.5%'}}}},{station_code:'TCD4',report_date:'2026-10-25',created_at:'2026-10-25',values_json:{score_pct:90}}],{shifts:[],days:[],actions:[]},'2026-10-27');
 assert.equal(facts.find(f=>f.id==='s:health').value,'29%');assert.equal(facts.find(f=>f.id==='s:reconciliation').value,'100% (87% not reconciled)');assert.equal(facts.find(f=>f.id==='missing:missing-health').value,'No imported scorecard');assert.match(facts.find(f=>f.id==='s:handover').detail,/zero does not establish/);
});
const fact={id:'f',topic:'Health',label:'Score',value:'29%',detail:'Verified',href:'//evil.test',sentiment:'attention',storeCode:'TCD4'};
const brief={headline:'Focus on inbound',greeting:'Check the evidence.',layout:'spotlight',cards:[{title:'TCD4 needs a check',explanation:'A source signal.',action:'Check the source.',factIds:['f']}]};
test('AI cards reject unknown evidence, excessive claims and fabricated digits',()=>{
 assert.equal(validateInsightBrief(brief,[fact]).cards.length,1);assert.throws(()=>validateInsightBrief({...brief,cards:[{...brief.cards[0],factIds:['hidden']}]},[fact]));assert.throws(()=>validateInsightBrief({...brief,greeting:'Loss fell 99%'},[fact]));
});
test('email escapes source content and prevents untrusted destinations',()=>{
 const r=renderInsightEmail({name:'<script>',date:'today',edition:'AM',checkedAt:'now',facts:[{...fact,detail:'<img onerror="bad">'}],brief});assert.ok(!r.html.includes('<script>'));assert.ok(!r.html.includes('href="https://ops.dropxlogistics.com//evil'));assert.ok(r.html.includes('&lt;img'));assert.ok(r.html.includes('Dark Store')||r.html.includes('DARK STORE'));assert.ok(r.html.includes('guide.png'));assert.ok(!r.text.includes('https://ops.dropxlogistics.com//evil'));
});
test('large attendance keeps full summary and signals row truncation',()=>{
 const r=assistantModelRead({name:'ops_attendance_analysis',data:{rows:Array.from({length:200},(_,i)=>({name:'x'.repeat(500),index:i})),totals:{people:200},topPunctuality:[{name:'A'}]}});assert.equal(r.data.totals.people,200);assert.equal(r.data.rows.length,20);assert.equal(r.data.truncated,true);assert.equal(r.data.topPunctuality[0].name,'A');
});
test('all four export files contain usable content',async()=>{
 const {exportAssistantReport}=load('assistant-report-export');
 const x=await exportAssistantReport(report,'xlsx');const XLSX=require('xlsx');const book=XLSX.read(x.bytes);assert.deepEqual(book.SheetNames,['Insight','Source 1']);
 const d=await exportAssistantReport(report,'docx');const zip=await require('jszip').loadAsync(d.bytes);assert.match(await zip.file('word/document.xml').async('string'),/A verified answer/);
 const p=await exportAssistantReport(report,'pdf');const pdf=await require('pdf-lib').PDFDocument.load(p.bytes);assert.ok(pdf.getPageCount()>0);
 const png=await exportAssistantReport(report,'png');const meta=await require('sharp')(png.bytes).metadata();assert.equal(meta.width,1200);assert.ok(meta.height>=400);
});

test('morning and evening share a monthly thread group without mixing operational status mail',async()=>{
 const {digestThreadEvents}=await import('../digest-thread-policy.ts');
 assert.deepEqual(digestThreadEvents('now_insight_morning'),digestThreadEvents('now_insight_evening'));
 assert.ok(!digestThreadEvents('now_insight_morning').includes('now_review_digest'));
 const source=fs.readFileSync('src/lib/portal-digest-delivery.ts','utf8');assert.match(source,/eq\("report_month",delivery.report_date.slice\(0,7\)\)/);assert.match(source,/references:thread/);assert.match(source,/Insight recipient scope changed/);
});
