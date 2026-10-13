import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesCodFilters,toggleCodSelection,codFreshness} from './cod-status.ts';
const location={id:'a',code:'A',name:'Alpha',model:'XPT',region:'AP',manager:'Bharat',managers:['Bharat','Anil']};
const checks={reconciliation:{tone:'attention'},prepareDeposit:{tone:'waiting'},remittances:{tone:'clear'}};
test('column selections OR within a column, AND between columns; empty means all',()=>{
 assert.equal(matchesCodFilters(location,checks,'attention',{station:['a','b'],region:['AP','KL'],manager:['Anil'],reconciliation:['attention','waiting'],prepareDeposit:['waiting']}),true);
 assert.equal(matchesCodFilters(location,checks,'attention',{reconciliation:['attention','waiting'],prepareDeposit:['clear']}),false);
 assert.equal(matchesCodFilters(location,checks,'attention',{station:['b']}),false);
 assert.equal(matchesCodFilters(location,checks,'attention',{overall:[],manager:[],region:[]}),true);
 assert.equal(matchesCodFilters({...location,manager:'',managers:[]},checks,'attention',{manager:['__unmapped']}),true);
});
test('summary cards support multiple selections and remove each independently',()=>{
 const selected=toggleCodSelection(toggleCodSelection([],'attention'),'waiting');
 assert.deepEqual(selected,['attention','waiting']);
 assert.equal(matchesCodFilters(location,checks,'attention',{overall:selected}),true);
 assert.deepEqual(toggleCodSelection(selected,'attention'),['waiting']);
 assert.deepEqual(toggleCodSelection(['attention'],'attention'),[]);
});
test('last-check filters respect master freshness, component times and failures',()=>{
 const now=new Date('2026-10-13T12:00:00+05:30');
 const snapshot={date:'2026-10-13',fetchedAt:now.toISOString(),...Object.fromEntries(Object.keys(checks).map(p=>[p,{checkedAt:now.toISOString()}]))};
 assert.equal(codFreshness(snapshot,15,now),'fresh');
 assert.equal(codFreshness(snapshot,null,now),'stale');
 assert.equal(codFreshness({...snapshot,prepareDeposit:{checkedAt:'2026-10-13T10:00:00+05:30'}},15,now),'stale');
 assert.equal(codFreshness(snapshot,15,now,false,true),'failed');
 assert.equal(codFreshness(undefined,15,now,true),'checking');
 assert.equal(codFreshness(undefined,15,now),'unchecked');
});
