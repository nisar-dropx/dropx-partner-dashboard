import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as crypto from 'node:crypto';
function compile(path,mocks={}){const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>mocks[n]||{},m.exports,m);return m.exports;}
const cps=compile('../ops-pulse/cps.ts');
const reportCache=compile('./report-cache.ts');
const baseMocks={'./pnl':cps,'./report-cache':reportCache,'node:crypto':crypto};
const {loadHoCosts}=compile('./cfo-data.ts',baseMocks);
test('cross-month HO expenses use bounded monthly queries and retain every expense',async()=>{const calls=[];const c={companyId:'c',authorization:{hasAllLocationAccess:true},locations:[{is_ho:true,station_code:'HO'},{is_ho:false,station_code:'S'}],db:{rpc:async(name,args)=>{calls.push(args);assert.equal(args.p_from.slice(0,7),args.p_through.slice(0,7));return {data:{breakup:[{amount:100,date:args.p_from}]},error:null};}}};const r=await loadHoCosts(c,'2026-09-15','2026-10-06');assert.deepEqual(calls.map(x=>[x.p_from,x.p_through,x.p_stations]),[['2026-09-15','2026-09-30',['HO']],['2026-10-01','2026-10-06',['HO']]]);assert.equal(r.data.breakup.reduce((s,x)=>s+x.amount,0),200);});
test('location-scoped Finance users never query company-wide HO expenses',async()=>{const r=await loadHoCosts({authorization:{hasAllLocationAccess:false},db:{rpc:()=>{throw Error('must not query');}}},'2026-10-01','2026-10-06');assert.deepEqual(r.data.breakup,[]);});
test('failed month is an explicit error, never silently omitted from business expenses',async()=>{const c={companyId:'c',authorization:{hasAllLocationAccess:true},locations:[{is_ho:true,station_code:'HO'}],db:{rpc:async()=>({error:{message:'temporarily unavailable'}})}};assert((await loadHoCosts(c,'2026-10-01','2026-10-06')).error);});

test('CFO reuses one complete cost snapshot for shipment P&L and HO evidence',async()=>{
 let loads=0;const report={daily:[],breakup:[],generated_at:'now'};
 const {loadCfo}=compile('./cfo-data.ts',{...baseMocks,
  './pnl':{...cps,pnlFilters:q=>({from:q.from,to:q.to,region:'',cluster:'',location:''})},
  './data':{loadRent:async()=>[]},
  './business-master':{loadBusinessMaster:async()=>[],loadNowVolumes:async()=>[],locationModel:()=> 'EDSP'},
  '../ops-pulse/cps-data':{loadFinanceCpsEvidence:async()=>{loads++;return {report,evidence:{staff:[],associates:[]}};}},
  './pnl-data':{loadPnl:async(c,q,shared)=>{assert.equal(await shared,report);return {days:[],costs:[],pricing:[],revenueCalculations:[]};}},
 });
 const c={companyId:'test',authorization:{userId:'u',hasAllLocationAccess:false},locations:[{station_code:'A'}]};
 const q={period:'custom',from:'2026-10-01',to:'2026-10-07'};
 const [a,b]=await Promise.all([loadCfo(c,q),loadCfo(c,{...q,model:'EDSP',overhead:'1'})]);
 assert.equal(loads,1);assert.equal(a.viewFilters.includeOverhead,false);assert.equal(b.viewFilters.includeOverhead,true);assert.equal(b.viewFilters.model,'EDSP');
 await loadCfo({...c,locations:[{station_code:'B'}]},q);assert.equal(loads,2);
 await loadCfo({...c,authorization:{...c.authorization,userId:'another'}},q);assert.equal(loads,3);
});
