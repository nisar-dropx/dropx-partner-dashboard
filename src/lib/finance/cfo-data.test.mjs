import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
function compile(path,mocks={}){const m={exports:{}};new Function('require','exports','module',ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>mocks[n]||{},m.exports,m);return m.exports;}
const cps=compile('../ops-pulse/cps.ts');
const {loadHoCosts}=compile('./cfo-data.ts',{'./pnl':cps});
test('cross-month HO expenses use bounded monthly queries and retain every expense',async()=>{const calls=[];const c={companyId:'c',authorization:{hasAllLocationAccess:true},locations:[{is_ho:true,station_code:'HO'},{is_ho:false,station_code:'S'}],db:{rpc:async(name,args)=>{calls.push(args);assert.equal(args.p_from.slice(0,7),args.p_through.slice(0,7));return {data:{breakup:[{amount:100,date:args.p_from}]},error:null};}}};const r=await loadHoCosts(c,'2026-09-15','2026-10-06');assert.deepEqual(calls.map(x=>[x.p_from,x.p_through,x.p_stations]),[['2026-09-15','2026-09-30',['HO']],['2026-10-01','2026-10-06',['HO']]]);assert.equal(r.data.breakup.reduce((s,x)=>s+x.amount,0),200);});
test('location-scoped Finance users never query company-wide HO expenses',async()=>{const r=await loadHoCosts({authorization:{hasAllLocationAccess:false},db:{rpc:()=>{throw Error('must not query');}}},'2026-10-01','2026-10-06');assert.deepEqual(r.data.breakup,[]);});
test('failed month is an explicit error, never silently omitted from business expenses',async()=>{const c={companyId:'c',authorization:{hasAllLocationAccess:true},locations:[{is_ho:true,station_code:'HO'}],db:{rpc:async()=>({error:{message:'temporarily unavailable'}})}};assert((await loadHoCosts(c,'2026-10-01','2026-10-06')).error);});
