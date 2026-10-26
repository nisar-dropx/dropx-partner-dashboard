import test from 'node:test';import assert from 'node:assert/strict';import ts from 'typescript';import {readFileSync} from 'node:fs';
for(const kind of ['si-handover','store-ops']) for(const allowed of [true,false]) test(`${kind} export ${allowed?'uses scoped checklist reader for non-manager':'stops before exposing answers when reader denies scope'}`,async()=>{
 let proofReads=0,read=false;
 const source=readFileSync(new URL(`../../app/api/ops-pulse/${kind}/report-pack/route.ts`,import.meta.url),'utf8');
 const row={id:'r',location_id:'s',store_code:'TCD4',shift_date:'2026-10-26',work_date:'2026-10-26',status:'submitted',outgoing_name:'SI',owner_name:'SM',template:{sections:[]},answers:{}};
 const server={context:async()=>({companyId:'company',auth:{},master:{settings:{}}}),readChecklist:async()=>{read=true;if(!allowed)throw Error('Store scope denied');return{checklist:row}},stores:async()=>[],proofs:async()=>{proofReads++;return[]},periodCompletions:async()=>({weeklyDone:new Set(),monthlyDone:new Set()})};
 const module={exports:{}};new Function('require','module','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>n.endsWith('/server')?server:{progress:()=>({answered:0,total:0,pct:100}),statusLabels:{submitted:'Submitted'}},module,module.exports);
 const r=await module.exports.GET(new Request('https://ops.example/report-pack?id=r'));assert(read);assert.equal(r.status,allowed?200:403);assert.equal(proofReads,allowed?1:0);const body=await r.json();assert.equal(Boolean(body.checklist),allowed);
});
