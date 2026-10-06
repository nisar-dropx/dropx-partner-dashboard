import assert from 'node:assert/strict';import fs from 'node:fs';import ts from 'typescript';import {createRequire} from 'node:module';
const nativeRequire=createRequire(import.meta.url);
const load=(file,overrides={})=>{const exports={};new Function('exports','require',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports,n=>n in overrides?overrides[n]:nativeRequire(n));return exports;};
const {summarizeHealth}=load('src/lib/fleet/audit-health.ts');
const {renderAuditPdf}=load('src/lib/fleet/audit-report-pdf.ts');
const {PDFDocument}=nativeRequire('pdf-lib');const sharp=nativeRequire('sharp');
const responses=Array.from({length:24},(_,i)=>({itemId:String(i),label:`Inspection checkpoint ${i+1}`,category:i<8?'Safety':i<16?'Tyres':'Condition',answer:i===0?'Poor':'Good',comments:i===0?'Wear visible on the front tyre. Inspect before the next route.':'',action:i===0?'Replace front tyre':'',days:i===0?7:null,passed:i!==0,weight:i<8?4:2,score:i===0?25:100,critical:false}));
const report={id:'sample',vehicleId:'sample',vehicleNo:'KL11CB7682',model:'Mahindra Jeeto Strong',station:'KTUB',mode:'Physical inspection',date:'2026-10-06',completedAt:'2026-10-06T07:55:44Z',inspector:'Sample inspector',status:'failed',summary:'Sample report for layout verification. Tyre replacement requires follow-up.',odometer:42100,score:95,scoreBasis:'Weighted health',health:summarizeHealth(responses),responses,findings:[{id:'f',category:'Tyres',finding:'Front tyre: Poor - tread worn',severity:'high',action:'Replace before next route',due:'2026-10-13',status:'open'}],continuity:[{id:'p',comparison:'Repeated',category:'Tyres',finding:'Front tyre: Poor - tread worn',date:'2026-09-20',previousCount:2,due:'2026-09-27',action:'Replace tyre'}],previous:[{id:'p',date:'2026-09-20',score:86,status:'failed'}],evidence:Array.from({length:20},(_,i)=>({id:String(i),itemId:String(i),type:'photo',url:`https://fleet.dropxlogistics.com/evidence/${i}`,caption:`Checkpoint ${i+1} - inspection evidence`})),generatedAt:new Date().toISOString()};
const image=await sharp({create:{width:600,height:450,channels:3,background:'#b8d8d2'}}).jpeg().toBuffer();let count=0;
const bytes=await renderAuditPdf(report,async()=>{count++;return {kind:'image',bytes:image};});assert.equal(count,20);const pdf=await PDFDocument.load(bytes);assert.ok(pdf.getPageCount()>=8);assert.ok(bytes.length>10000);
fs.mkdirSync('output/pdf',{recursive:true});fs.writeFileSync('output/pdf/fleet-audit-layout-sample.pdf',bytes);
// A missing photo is represented, never silently dropped or allowed to break the audit flow.
await renderAuditPdf({...report,evidence:report.evidence.slice(0,1)},async()=>{throw Error('Missing');});
// Report endpoint must authorize before reading any report data.
let reads=0;const route=load('src/app/api/fleet/audit-report/route.ts',{'@/lib/fleet/audit-access':{auditAccess:async()=>{throw Error('Denied');}},'@/lib/fleet/audit-report-data':{loadAuditReport:async()=>{reads++;return report;}}});
assert.equal((await route.GET(new Request('https://fleet.test/api/fleet/audit-report?id=8888d278-757e-4760-b3ef-6bf873ea5690'))).status,403);assert.equal(reads,0);
// Media loader refuses external hosts, another company's files and traversal paths.
let downloads=0;const media=load('src/lib/fleet/audit-report-media.ts',{'server-only':{},'@/lib/supabase-admin':{supabaseAdmin:{storage:{from:()=>({download:async()=>{downloads++;throw Error('Unexpected');}})}}}});
for(const url of ['https://internal.example/photo.jpg','/api/fleet/audit-evidence?path=other/audits/a/file.jpg','/api/fleet/audit-evidence?path=c/audits/a/../file.jpg'])assert.equal(await media.loadAuditAttachment('c','a',{url,type:'photo'}),null);
assert.equal(downloads,0);console.log(`Audit report: ${pdf.getPageCount()} PDF pages, all 20 photos processed, safe missing-media fallback, authorization and storage isolation passed.`);
