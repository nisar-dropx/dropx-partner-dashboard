import test from 'node:test';
import assert from 'node:assert/strict';
import {buildStationSummary, stationLossCategory} from './station-summary.ts';

const entry = (id, station, side, paise, extra = {}) => ({id, station, side, paise, sourceStation: station, month: '2026-10', head: 'Source', description: '', reference: id, source: 'Recorded', date: '2026-10-31', ...extra});
const pool = (code, extra = {}) => ({code, mode: 'corporate', entries: [], rule: {recipient_models: ['EDSP','NOW']}, total: 10003, income: 0, allocated: 10003, unallocated: 0, issue: '', allocations: [], corporateShares: [{model:'EDSP',paise:7502,revenuePaise:90000,weight:.75},{model:'NOW',paise:2501,revenuePaise:30000,weight:.25}], ...extra});
const fixture = () => ({month:'2026-10', stations:['B','N','A'], dimensions:['A','B','N'].map(code => ({code,name:code,model:code==='N'?'NOW':'EDSP',isHo:false})), entries:[entry('a','A','income',60000),entry('b','B','income',30000),entry('n','N','income',30000),entry('a-cost','A','expense',10000),entry('b-cost','B','expense',10000),entry('n-cost','N','expense',10000),entry('ho-allocation:regional:A','A','expense',2500),entry('ho-allocation:regional:B','B','expense',7501)], overheadPools:[pool('HO_CLT')]});

test('station fully-loaded results conserve saved vertical shares before any display filter', () => {
 const report=fixture(), before=JSON.stringify(report), result=buildStationSummary(report);
 assert.deepEqual(result.rows.map(row=>[row.station,row.corporateHo]),[['A',5001],['B',2501],['N',2501]]);
 assert.deepEqual(result.rows.map(row=>[row.station,row.net]),[['A',42499],['B',9998],['N',17499]]);
 assert.equal(result.rows.reduce((n,row)=>n+row.corporateHo,0),10003);
 assert.equal(result.rows.filter(row=>row.dimension.model==='EDSP').reduce((n,row)=>n+row.corporateHo,0),7502);
 assert.equal(result.rows.filter(row=>row.station==='A')[0].net,42499);
 assert.equal(JSON.stringify(report),before,'Do not modify worker evidence or allocations');
});
test('recovery improves net but never increases corporate allocation weight; chargebacks count once',()=>{
 const report=fixture();report.entries.push(entry('recover','A','income',90000,{recovery:true}),entry('loss','A','expense',20000,{head:'Loss chargeback',description:'Package loss'}));
 const row=buildStationSummary(report).rows.find(row=>row.station==='A');
 assert.equal(row.corporateHo,5001);assert.equal(row.revenue,60000);assert.equal(row.recovery,90000);
 assert.equal(row.chargebacks,20000);assert.equal(row.directExpense,30000);assert.equal(row.operatingExpense,10000);assert.equal(row.net,112499);
});
test('missing station revenue keeps the current result numeric and flags the missing allocation',()=>{
 const report=fixture();report.entries=report.entries.filter(e=>e.id!=='b');const result=buildStationSummary(report);
 for(const code of ['A','B']){const row=result.rows.find(row=>row.station===code);assert.equal(row.corporateHo,null);assert.equal(row.net,code==='A'?47500:-17501);assert.equal(row.complete,false);assert.match(row.issues.join(' '),/revenue for B/);}
 assert.equal(result.rows.find(row=>row.station==='N').corporateHo,2501);assert.equal(result.unallocatedCorporate,7502);
});
test('unallocated corporate pools affect only configured verticals',()=>{
 const report=fixture();report.overheadPools=[pool('HO_MJR',{rule:{recipient_models:['EDSP']},unallocated:10003,allocated:0,corporateShares:[],issue:'Missing revenue'})];
 const rows=buildStationSummary(report).rows;assert.equal(rows.find(row=>row.station==='A').net,47500);assert.equal(rows.find(row=>row.station==='A').complete,false);assert.equal(rows.find(row=>row.station==='N').net,20000);
});
test('regional pending scope, missing expenses and unknown assignment remain visible',()=>{
 const report=fixture();report.entries=report.entries.filter(e=>e.id!=='n-cost');report.entries.push(entry('unmapped','Unmapped · X','expense',100));
 report.overheadPools.push(pool('HO_AP',{mode:'regional',rule:{recipient_codes:['B']},unallocated:500,total:500,allocated:0,corporateShares:[]}));
 const result=buildStationSummary(report);assert.equal(result.rows.find(row=>row.station==='B').regionalHoPending,true);assert.equal(result.rows.find(row=>row.station==='B').net,9998);assert.equal(result.rows.find(row=>row.station==='B').complete,false);assert.equal(result.rows.find(row=>row.station==='A').complete,true);assert.equal(result.rows.find(row=>row.station==='N').net,27499);assert.equal(result.rows.find(row=>row.station==='N').complete,false);assert.equal(result.unassignedEntries.length,1);
});
test('deleted records and HO locations do not become station amounts; zero recorded revenue is distinct from missing',()=>{
 const report=fixture();report.stations.push('HO_CLT');report.entries.push(entry('deleted','A','expense',999999,{deleted:true}));report.entries.find(e=>e.id==='b').paise=0;
 const result=buildStationSummary(report);assert.equal(result.rows.length,3);assert.equal(result.rows.find(row=>row.station==='B').corporateHo,0);assert.equal(result.rows.find(row=>row.station==='B').complete,true);assert.equal(result.rows.find(row=>row.station==='A').directExpense,10000);
});
test('explicit package and cash losses classify without treating unrelated expenses as losses',()=>{
 assert.equal(stationLossCategory({side:'expense',head:'Loss chargeback',description:'COD shortage'}),'cod');
 assert.equal(stationLossCategory({side:'expense',head:'Chargeback',description:'NNL package loss'}),'package');
 assert.equal(stationLossCategory({side:'expense',head:'Loss chargeback',description:'Other debit'}),'other');
 assert.equal(stationLossCategory({side:'expense',head:'Fuel',description:'Delivery van'}),null);
 assert.equal(stationLossCategory({side:'expense',head:'Service adjustment',description:'Minimum guarantee shortfall'}),null);
 assert.equal(stationLossCategory({side:'income',head:'Loss recovery',description:'Package loss'}),null);
});
test('regional allocation gaps identify the exact missing child source across affected stations',()=>{
 const report=fixture();report.overheadPools=[pool('HO_REGION',{mode:'regional',rule:{recipient_codes:['A','B'],allocation:'volume'},unallocated:500,total:500,allocated:0,corporateShares:[],issue:'Delivery volume is missing for B.'})];
 report.volumes=[{station:'B',delivered:100,reportedDays:31,through:'2026-10-31',missingSources:['B-XPT'],unit:'deliveries'},{station:'N',delivered:null,missingSources:['N']}];
 const rows=buildStationSummary(report).rows;
 for(const code of ['A','B'])assert.match(rows.find(row=>row.station===code).issues.join(' '),/B → B-XPT/);
 assert.doesNotMatch(rows.find(row=>row.station==='A').issues.join(' '),/N → N/);
 assert.equal(rows.find(row=>row.station==='N').complete,true);
});
