import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { remittanceAmountCheck, codRemittanceRows } from './cod-remittance-variance.ts';
import { codStatusChecks, codStatusCategory, matchesCodFilters, compareCodRows } from './cod-status.ts';
const now=new Date('2026-10-16T20:00:00+05:30');
const submitted=(extra={})=>({id:'new',code:'AC-NEW',status:'SUBMITTED',expectedAmount:1000.1,actualAmount:1000.1,variance:0,createdAt:now.getTime()-3600000,updatedAt:now.getTime(),submittedAt:now.getTime(),createdBy:'auditor',submittedBy:'auditor',...extra});
function snapshot(rows=[submitted()]) {return {date:'2026-10-16',fetchedAt:now.toISOString(),reconciliation:{state:'ok',checkedAt:now.toISOString(),data:{complete:true,pendingCount:0,pendingAmount:0,drivers:[]}},prepareDeposit:{state:'ok',checkedAt:now.toISOString(),data:{sourceScope:'outstanding_history',sourceWindow:{startTime:0,endTime:now.getTime()},expectedAmount:0,actualAmount:0,variance:0}},remittances:{state:'ok',checkedAt:now.toISOString(),data:{complete:true,openCount:0,submittedToday:true,latestSubmitted:rows[0],rows}}};}
const checks=(s,tolerance=5)=>codStatusChecks(s,null,now,false,'',null,15,tolerance);

test('submitted shortages and excesses above ₹5 override updated-today green',()=>{
 for(const actualAmount of [990.1,1010.1]) {
  const s=snapshot([submitted({actualAmount})]);
  assert.equal(checks(s).remittances.tone,'attention');
  assert.match(checks(s).remittances.reason,/expected ₹1,000.10, actual/);
  assert.match(checks(s).remittances.label,actualAmount<1000?/Short by/:/Excess/);
  assert.equal(codStatusCategory(s,now),'attention');
 }
});
test('paise precision: ±₹5 remains clear; ±₹5.01 flags; small decimals do not',()=>{
 for(const difference of [-5,-1,-0.01,0,0.01,1,5]) assert.equal(remittanceAmountCheck(submitted({actualAmount:1000.1+difference})).tone,'clear');
 for(const difference of [-5.01,5.01]) assert.equal(remittanceAmountCheck(submitted({actualAmount:1000.1+difference})).tone,'attention');
 assert.equal(remittanceAmountCheck(submitted({expectedAmount:101747.55,actualAmount:101751,variance:3.45})).tone,'clear');
});
test('station overrides apply to summary, filters and sorting; zero tolerance is valid',()=>{
 const s=snapshot([submitted({actualAmount:1002.1})]);
 assert.equal(checks(s,1).remittances.tone,'attention');assert.equal(checks(s,5).remittances.tone,'clear');
 assert.equal(checks(s,0).remittances.tone,'attention');
 const a={id:'a',code:'AAA',name:'A',model:'EDSP',region:'AP',manager:'Manager',maxAgeMinutes:15,remittanceTolerance:5};
 const b={...a,id:'b',code:'BBB',remittanceTolerance:1};
 assert.ok(matchesCodFilters(b,checks(s,1),'attention',{remittances:['attention'],overall:['attention']}));
 assert.ok(!matchesCodFilters(a,checks(s,5),'clear',{remittances:['attention']}));
 assert.deepEqual([a,b].sort((x,y)=>compareCodRows(x,y,{a:s,b:s},'remittances','asc',now)).map(x=>x.id),['b','a']);
});
test('a clean latest submission cannot hide historical variance; opposite differences do not cancel',()=>{
 const old=submitted({id:'older',code:'AC-OLD',expectedAmount:79917.71,actualAmount:2605.05});
 const s=snapshot([submitted(),old,submitted({id:'excess',code:'AC-EXCESS',actualAmount:90000})]);
 assert.equal(checks(s).remittances.tone,'attention');assert.match(checks(s).remittances.label,/2 remittance differences/);
 assert.equal(s.remittances.data.rows.length,3);
 // Summary-only latest is checked once and included in the details.
 s.remittances.data.latestSubmitted=submitted({id:'summary',code:'AC-SUMMARY',actualAmount:1});
 assert.equal(codRemittanceRows(s.remittances.data).length,4);
 s.remittances.data.rows=[];
 assert.match(checks(s).remittances.reason,/AC-SUMMARY/);
});
test('missing amounts/configuration never become clearance; recomputation ignores stale variance field',()=>{
 for(const bad of [null,undefined,NaN,Infinity,'1000.10',-1]) {
  for(const key of ['actualAmount','expectedAmount']) assert.equal(checks(snapshot([submitted({[key]:bad})])).remittances.tone,'unavailable');
 }
 for(const tolerance of [null,-1,Infinity,NaN]) assert.equal(checks(snapshot(),tolerance).remittances.tone,'unavailable');
 assert.equal(remittanceAmountCheck(submitted({actualAmount:950,variance:0})).tone,'attention');
});
test('open/cancelled rows do not generate deposit shortages; existing pickup timing still applies',()=>{
 const policy={rule:'Next Day',start:'10:00',end:'10:30',preparationFrom:'16:00'};
 for(const status of ['CREATED','PENDING_SUBMISSION','CANCELLED']) assert.equal(remittanceAmountCheck(submitted({status,actualAmount:0})),null);
 const s=snapshot([submitted({submittedAt:now.getTime()-3600000})]);s.remittances.data.rows.push(submitted({id:'open',status:'CREATED',createdAt:now.getTime(),submittedAt:null,actualAmount:0}));s.remittances.data.openCount=1;
 assert.equal(codStatusChecks(s,policy,now).remittances.tone,'waiting');
 s.remittances.data.rows[0].actualAmount=900;
 assert.equal(codStatusChecks(s,policy,now).remittances.tone,'attention');
});
test('failed/stale data cannot present a current variance result; partial source retains confirmed alert',()=>{
 const s=snapshot([submitted({actualAmount:900})]);s.remittances.data.complete=false;
 assert.equal(checks(s).remittances.tone,'attention');
 s.remittances.checkedAt='2026-10-16T00:00:00+05:30';assert.equal(checks(s).remittances.tone,'unavailable');
 assert.equal(codStatusChecks(snapshot([submitted({actualAmount:900})]),null,now,true).remittances.tone,'unavailable');
});
test('migration defaults existing/new stations to ₹5, persists overrides and rejects invalid DB values',async()=>{
 const db=new PGlite();
 try {
  await db.exec('create table public.cod_station_settings (id int primary key); insert into public.cod_station_settings values(1);');
  const sql=fs.readFileSync(new URL('../../../supabase/migrations/20261016220000_cod_remittance_variance_tolerance.sql',import.meta.url),'utf8');
  await db.exec(sql);await db.exec(sql);
  assert.equal(Number((await db.query('select remittance_variance_tolerance from cod_station_settings')).rows[0].remittance_variance_tolerance),5);
  await db.exec('insert into cod_station_settings(id) values(2); update cod_station_settings set remittance_variance_tolerance=1.25 where id=1');
  assert.deepEqual((await db.query('select remittance_variance_tolerance::float as tolerance from cod_station_settings order by id')).rows,[{tolerance:1.25},{tolerance:5}]);
  for(const value of ['-1','null',"'NaN'",'1000000']) await assert.rejects(db.exec(`update cod_station_settings set remittance_variance_tolerance=${value} where id=1`));
 } finally {await db.close();}
});
