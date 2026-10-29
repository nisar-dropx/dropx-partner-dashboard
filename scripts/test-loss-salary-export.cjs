const fs=require('fs'),ts=require('typescript'),assert=require('node:assert/strict'),XLSX=require('xlsx');
let auth=null,loaded=0;
const m={exports:{}};
const js=ts.transpileModule(fs.readFileSync('src/app/api/ops-pulse/losses/recovery/export/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
new Function('require','module','exports',js)(id=>{
 if(id==='xlsx')return XLSX;
 if(id.endsWith('/authorization'))return {getAuthorization:async()=>auth,hasPermission:a=>a.allowed};
 if(id.endsWith('/loss-recovery-workspace'))return {loadRecoveryWorkspace:async a=>{assert.equal(a.companyId,'company');loaded++;return {rows:[],lines:[],settings:null}}};
 if(id.endsWith('/loss-recovery-queue-policy'))return {indiaMonth:()=> '2026-10'};
 if(id.endsWith('/loss-recovery-updates'))return {recoveryUpdates:()=>[],filterRecoveryUpdates:(r,f)=>{assert.equal(f.salaryScope,'earlier');assert.equal(f.station,'AAA');assert.equal(f.currentMonth,'2026-10');return r},recoveryUpdateExportRows:()=>[['Shipment ID','Salary month','Assigned amount'],['001234567890','2026-09',125.50]]};
 throw Error(id);
},m,m.exports);
(async()=>{
 const req=new Request('https://ops.example/api/ops-pulse/losses/recovery/export?salaryScope=earlier&station=AAA');
 assert.equal((await m.exports.GET(req)).status,403);auth={allowed:false};assert.equal((await m.exports.GET(req)).status,403);assert.equal(loaded,0);
 auth={allowed:true,companyId:'company'};const res=await m.exports.GET(req);assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'private, no-store');
 const book=XLSX.read(Buffer.from(await res.arrayBuffer()),{type:'buffer'}),sheet=book.Sheets[book.SheetNames[0]];
 assert.equal(sheet.A2.v,'001234567890');assert.equal(sheet.B2.v,'2026-09');assert.equal(sheet.C2.v,125.50);
 console.log('PASS salary-month export: permission before loading, filter forwarding, real workbook, exact shipment identifier.');
})().catch(e=>{console.error(e);process.exitCode=1});
