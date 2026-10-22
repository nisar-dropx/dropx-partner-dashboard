import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolvePeopleReviewRoute} from './people-review-route.ts';
import {visibleReviewStep,reviewRoutingIssue} from './review-policy.ts';
const person=(id,code,extra={})=>({id,personId:id,name:id,designationId:code,code,role:code,locationId:null,canManage:true,oversight:false,userIds:[id],scopeIds:['station'],allLocations:false,...extra});
const graph=()=>({people:[person('lead','TL',{locationId:'station'}),person('cluster','CLM'),person('area','AOM'),person('inayath','HLM',{role:'Head Operations- Last Mile'}),person('owner','MP',{oversight:true})],relationships:[{subjectId:'lead',managerId:'cluster'},{subjectId:'cluster',managerId:'area'},{subjectId:'area',managerId:'inayath'},{subjectId:'inayath',managerId:'owner'}]});
test('People includes Ops Head and arbitrary future manager designations without a title rule',()=>{
 const g=graph();assert.deepEqual(resolvePeopleReviewRoute(g,'station').chain.map(p=>p.personId),['cluster','area','inayath']);
 g.people[3].code='FUTURE_ROLE';g.people[3].role='New manager designation';assert.equal(resolvePeopleReviewRoute(g,'station').chain.at(-1).personId,'inayath');
});
test('does not stop at National Head if People has another manager above it',()=>{const g=graph();g.people[2].code='NH';g.people[2].role='National Head';assert.equal(resolvePeopleReviewRoute(g,'station').chain.at(-1).personId,'inayath');});
test('effective People manager replacement changes route identity, not only label',()=>{const g=graph();g.people[3]={...g.people[3],id:'new',personId:'new',userIds:['new']};g.relationships[2].managerId='new';g.relationships[3].subjectId='new';assert.equal(resolvePeopleReviewRoute(g,'station').chain.at(-1).reviewerUserId,'new');});
test('cycles, dangling relationships and multiple primary managers fail closed',()=>{
 let g=graph();g.relationships.push({subjectId:'inayath',managerId:'area'});assert.match(resolvePeopleReviewRoute(g,'station').error,/Multiple/);
 g=graph();g.relationships[3].managerId='area';assert.match(resolvePeopleReviewRoute(g,'station').error,/cycle/);
 g=graph();g.people.splice(3,1);assert.match(resolvePeopleReviewRoute(g,'station').error,/inactive/);
});
test('orphan eligible people at a station do not block the operational CM→AOM route',()=>{
 const g=graph();g.people.push(person('other','NEW',{locationId:'station'}));
 assert.deepEqual(resolvePeopleReviewRoute(g,'station').chain.map(p=>p.personId),['cluster','area','inayath']);
});
test('two different Cluster Manager routes for the same station still fail closed',()=>{
 const g=graph();
 g.people.push(person('cm2','CLM',{locationId:'station'}),person('aom2','AOM'));
 g.relationships.push({subjectId:'cm2',managerId:'aom2'},{subjectId:'aom2',managerId:'inayath'});
 assert.match(resolvePeopleReviewRoute(g,'station').error,/conflicting/);
});
test('ambiguous OpsPulse accounts are never guessed',()=>{
 for(const ids of [[],['a','b']]){const h=graph();h.people[3].userIds=ids;assert.match(resolvePeopleReviewRoute(h,'station').error,/exactly one/);}
});
test('Ops scope is checked for every manager, including linked new head',()=>{const g=graph();g.people[3].scopeIds=[];assert.match(resolvePeopleReviewRoute(g,'station').error,/access/);});
test('missing station roots may use scoped managers only when routes converge',()=>{const g=graph();g.people[0].locationId=null;assert.equal(resolvePeopleReviewRoute(g,'station').chain.at(-1).personId,'inayath');});
test('People stages display and do not require a hardcoded National level',()=>{
 const step={status:'pending',reviewer_role:'Future manager',routing_source:'people'};
 assert.equal(visibleReviewStep(step),true);assert.equal(reviewRoutingIssue([step]),null);
 assert.equal(visibleReviewStep({...step,route_superseded_at:'2026-09-28'}),false);
});

test('a disabled manager in an existing reporting line is a mapping issue, not a skipped approval',()=>{const g=graph();g.people[3].canManage=false;assert.match(resolvePeopleReviewRoute(g,'station').error,/not enabled/);});
test('a sub-station with nobody posted uses its mother station route (no conflicting scope seeds)',()=>{
 const g=graph();
 g.people.push(person('finance','FIN',{scopeIds:['station','sub']}));
 g.people=g.people.map(p=>({...p,scopeIds:[...new Set([...p.scopeIds,'sub'])]}));
 g.relationships.push({subjectId:'finance',managerId:'owner'});
 g.parentStationById=new Map([['sub','station']]);
 assert.deepEqual(resolvePeopleReviewRoute(g,'sub').chain.map(p=>p.personId),['cluster','area','inayath']);
});

const darkStoreGraph=()=>({
 darkStoreStationIds:new Set(['store']),
 people:[
  person('si','SIC',{role:'Shift Incharge',locationId:'store',scopeIds:['store']}),
  person('sm','SM',{role:'Store Manager',scopeIds:['store']}),
  person('city','CTM',{role:'City Manager',scopeIds:['store']}),
  person('rm','RM',{role:'Regional Manager',scopeIds:['store']}),
  person('nh','NH',{role:'National Head',scopeIds:['store']}),
  person('pgm','PGM',{role:'Program Manager',oversight:true,scopeIds:['store']}),
  person('finance','FIN',{role:'Finance Manager',locationId:'store',scopeIds:['store']})
 ],
 relationships:[
  {subjectId:'si',managerId:'sm'},
  {subjectId:'sm',managerId:'city'},
  {subjectId:'city',managerId:'rm'},
  {subjectId:'rm',managerId:'nh'},
  {subjectId:'nh',managerId:'pgm'},
  {subjectId:'finance',managerId:'rm'}
 ]
});

test('Dark Store route is Shift Incharge → Store → City → Regional → NH only',()=>{
 const g=darkStoreGraph();
 assert.deepEqual(resolvePeopleReviewRoute(g,'store').chain.map(p=>p.personId),['si','sm','city','rm','nh']);
});

test('Dark Store picks one Shift Incharge when peers share the same managers above',()=>{
 const g=darkStoreGraph();
 g.people[0].name='Asha SI';
 g.people.push(person('si2','SIC',{role:'Shift Incharge',name:'Zara SI',locationId:'store',scopeIds:['store']}));
 g.relationships.push({subjectId:'si2',managerId:'sm'});
 const route=resolvePeopleReviewRoute(g,'store');
 assert.equal(route.error,null);
 // Stable pick: alphabetical by name among equal-length peer roots.
 assert.deepEqual(route.chain.map(p=>p.personId),['si','sm','city','rm','nh']);
});

test('Dark Store allows peer SI/SM lines that share the same City → RM → NH',()=>{
 const g=darkStoreGraph();
 g.people.push(
  person('si2','SIC',{role:'Shift Incharge',name:'Zara SI',locationId:'store',scopeIds:['store']}),
  person('sm2','SM',{role:'Store Manager',name:'Other SM',scopeIds:['store']})
 );
 g.relationships.push({subjectId:'si2',managerId:'sm2'},{subjectId:'sm2',managerId:'city'});
 const route=resolvePeopleReviewRoute(g,'store');
 assert.equal(route.error,null);
 assert.deepEqual(route.chain.map(p=>p.personId).slice(2),['city','rm','nh']);
});

test('Dark Store still fails when City Managers diverge',()=>{
 const g=darkStoreGraph();
 g.people.push(
  person('si2','SIC',{role:'Shift Incharge',locationId:'store',scopeIds:['store']}),
  person('sm2','SM',{role:'Store Manager',scopeIds:['store']}),
  person('city2','CTM',{role:'City Manager',name:'Other City',scopeIds:['store']})
 );
 g.relationships.push({subjectId:'si2',managerId:'sm2'},{subjectId:'sm2',managerId:'city2'},{subjectId:'city2',managerId:'rm'});
 assert.match(resolvePeopleReviewRoute(g,'store').error,/conflicting/);
 assert.match(resolvePeopleReviewRoute(g,'store').error,/Compare:/);
});

test('Dark Store mode can be forced when station model detection is missing',()=>{
 const g=darkStoreGraph();
 delete g.darkStoreStationIds;
 // Without DS mode, LM floor rules would drop Store Manager seats in some graphs; force keeps the DS route.
 const route=resolvePeopleReviewRoute(g,'store',{darkStore:true});
 assert.equal(route.error,null);
 assert.deepEqual(route.chain.map(p=>p.personId),['si','sm','city','rm','nh']);
});

test('Dark Store keeps NH on the route even when marked full oversight',()=>{
 const g=darkStoreGraph();
 g.people[4].oversight=true;
 assert.deepEqual(resolvePeopleReviewRoute(g,'store').chain.map(p=>p.personId),['si','sm','city','rm','nh']);
});

test('Dark Store ignores finance / LM seats posted at the store',()=>{
 const g=darkStoreGraph();
 g.people.push(person('cm','CLM',{role:'Cluster Manager',locationId:'store',scopeIds:['store']}));
 g.relationships.push({subjectId:'cm',managerId:'rm'});
 assert.deepEqual(resolvePeopleReviewRoute(g,'store').chain.map(p=>p.personId),['si','sm','city','rm','nh']);
 assert.ok(!resolvePeopleReviewRoute(g,'store').chain.some(step=>step.personId==='finance'||step.personId==='cm'));
});

test('finance is never a review stage for Last Mile or Dark Store',()=>{
 const lm=graph();
 lm.people.push(person('fin','FINMGR',{role:'Finance Manager',locationId:'station'}));
 lm.relationships.push({subjectId:'fin',managerId:'inayath'});
 assert.ok(!resolvePeopleReviewRoute(lm,'station').chain.some(step=>step.personId==='fin'));
 const ds=darkStoreGraph();
 assert.ok(!resolvePeopleReviewRoute(ds,'store').chain.some(step=>step.personId==='finance'));
});

test('National Head stays on Last Mile route even when marked full oversight (shared with DS)',()=>{
 const g=graph();
 g.people.push(person('nh','NH',{role:'National Head',oversight:true}));
 g.relationships[3].managerId='nh';
 g.relationships.push({subjectId:'nh',managerId:'owner'});
 assert.deepEqual(resolvePeopleReviewRoute(g,'station').chain.map(p=>p.personId),['cluster','area','inayath','nh']);
});
