import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolvePeopleReviewRoute,resolveStoreReviewLeaders} from './people-review-route.ts';
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

test('Dark Store route is City Manager → Regional Manager only (no National Head)',()=>{
 const g=darkStoreGraph();
 assert.deepEqual(resolvePeopleReviewRoute(g,'store').chain.map(p=>p.personId),['city','rm']);
});

test('Dark Store City → National Head when People has no Regional Manager (TZC4 / Abdul)',()=>{
 const g=darkStoreGraph();
 // Point every store line at City → NH so a leftover finance→RM seed cannot invent a conflict.
 g.relationships=[
  {subjectId:'si',managerId:'sm'},
  {subjectId:'sm',managerId:'city'},
  {subjectId:'city',managerId:'nh'},
  {subjectId:'nh',managerId:'pgm'},
  {subjectId:'finance',managerId:'city'}
 ];
 assert.deepEqual(resolvePeopleReviewRoute(g,'store').chain.map(p=>p.personId),['city','nh']);
});

test('Dark Store allows peer City Managers that share the same Regional Manager',()=>{
 const g=darkStoreGraph();
 g.people.push(person('city2','CTM',{role:'City Manager',name:'Other City',locationId:'store',scopeIds:['store']}));
 g.relationships.push({subjectId:'city2',managerId:'rm'});
 const route=resolvePeopleReviewRoute(g,'store');
 assert.equal(route.error,null);
 assert.deepEqual(route.chain.map(p=>p.personId),['city','rm']);
});

test('Dark Store still fails when Regional Managers diverge',()=>{
 const g=darkStoreGraph();
 g.people.push(
  person('city2','CTM',{role:'City Manager',locationId:'store',scopeIds:['store']}),
  person('rm2','RM',{role:'Regional Manager',name:'Other RM',scopeIds:['store']})
 );
 g.relationships.push({subjectId:'city2',managerId:'rm2'},{subjectId:'rm2',managerId:'nh'});
 assert.match(resolvePeopleReviewRoute(g,'store').error,/conflicting/);
 assert.match(resolvePeopleReviewRoute(g,'store').error,/Compare:/);
});

test('Dark Store mode can be forced when station model detection is missing',()=>{
 const g=darkStoreGraph();
 delete g.darkStoreStationIds;
 const route=resolvePeopleReviewRoute(g,'store',{darkStore:true});
 assert.equal(route.error,null);
 assert.deepEqual(route.chain.map(p=>p.personId),['city','rm']);
});

test('Dark Store ignores SI, Store Manager, finance and National Head as review stages',()=>{
 const g=darkStoreGraph();
 const ids=resolvePeopleReviewRoute(g,'store').chain.map(p=>p.personId);
 assert.deepEqual(ids,['city','rm']);
 assert.ok(!ids.includes('si') && !ids.includes('sm') && !ids.includes('finance') && !ids.includes('nh'));
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

test('Dark Store resolves from a scoped City Manager when nobody is posted at the store',()=>{
 const g=darkStoreGraph();
 g.people=g.people.map(p=>p.locationId==='store' && p.personId!=='city' ? {...p,locationId:null} : p);
 g.people.find(p=>p.personId==='city').locationId=null;
 const route=resolvePeopleReviewRoute(g,'store',{darkStore:true});
 assert.equal(route.error,null);
 assert.deepEqual(route.chain.map(p=>p.personId),['city','rm']);
});

test('Dark Store still stops at Regional Manager when National Head is full oversight',()=>{
 const g=darkStoreGraph();
 g.people.find(p=>p.personId==='nh').oversight=true;
 assert.deepEqual(resolvePeopleReviewRoute(g,'store').chain.map(p=>p.personId),['city','rm']);
});

// TCC3/TCD4 regression: a current floor posting must not hide managed-store scope.
const orphanStoreGraph = () => ({
 darkStoreStationIds: new Set(['store']),
 people: [person('local','SM',{role:'Store Manager',locationId:'store',scopeIds:[],userIds:[]}),
  person('ramesh','RM',{role:'Regional Manager',name:'Ramesh',scopeIds:['store']})],
 relationships: []
});
test('DS local posting without an operational chain falls back to the explicitly mapped RM',()=>{
 const g=orphanStoreGraph();
 const route=resolvePeopleReviewRoute(g,'store');
 assert.equal(route.error,null);
 assert.deepEqual(route.chain.map(p=>p.personId),['ramesh']);
 // A normal non-manager store worker also must not mask the mapping.
 g.people[0].code='PICKER';g.people[0].role='Picker';g.people[0].canManage=false;
 assert.equal(resolvePeopleReviewRoute(g,'store').chain[0].personId,'ramesh');
});
test('DS fallback follows City → RM relationships and updates when managed locations change',()=>{
 const g=orphanStoreGraph();
 g.people.push(person('city','CTM',{role:'City Manager',scopeIds:['store']}));
 g.relationships.push({subjectId:'city',managerId:'ramesh'});
 assert.deepEqual(resolvePeopleReviewRoute(g,'store').chain.map(p=>p.personId),['city','ramesh']);
 g.people=g.people.map(p=>({...p,scopeIds:[]}));
 assert.match(resolvePeopleReviewRoute(g,'store').error,/No City Manager or Regional Manager/);
});
test('DS fallback cannot guess between conflicting mapped RMs or missing Ops accounts',()=>{
 const g=orphanStoreGraph();
 g.people.push(person('rm2','RM',{role:'Regional Manager',scopeIds:['store']}));
 assert.match(resolvePeopleReviewRoute(g,'store').error,/conflicting.*store/);
 g.people.pop();
 for(const userIds of [[],['u1','u2']]) {
  g.people[1].userIds=userIds;
  assert.match(resolvePeopleReviewRoute(g,'store').error,/exactly one active/);
 }
});
test('DS fallback never treats global access as an explicit store assignment',()=>{
 const g=orphanStoreGraph();g.people[1].scopeIds=[];g.people[1].allLocations=true;
 assert.match(resolvePeopleReviewRoute(g,'store').error,/No City Manager or Regional Manager/);
 g.people.shift();
 assert.match(resolvePeopleReviewRoute(g,'store').error,/No City Manager or Regional Manager/);
});
test('DS scoped fallback does not conceal invalid local reporting relationships',()=>{
 const g=orphanStoreGraph();
 g.relationships=[{subjectId:'local',managerId:'missing'}];
 assert.match(resolvePeopleReviewRoute(g,'store').error,/inactive, expired or missing/);
 g.relationships=[{subjectId:'local',managerId:'local'}];
 assert.match(resolvePeopleReviewRoute(g,'store').error,/cycle/);
});
test('store leadership prefers Senior Store Manager, then Store Manager, then Incharge',()=>{
 const g=darkStoreGraph();
 g.people.push(person('senior','SRSM',{role:'Senior Store Manager',scopeIds:['store'],userIds:[]}));
 assert.deepEqual(resolveStoreReviewLeaders(g,'store'),[{personId:'senior',name:'senior',role:'Senior Store Manager'}]);
 g.people.pop();
 assert.deepEqual(resolveStoreReviewLeaders(g,'store'),[{personId:'sm',name:'sm',role:'Store Manager'}]);
 g.people=g.people.filter(p=>p.id!=='sm');
 assert.deepEqual(resolveStoreReviewLeaders(g,'store'),[{personId:'si',name:'si',role:'Shift Incharge'}]);
});
test('store leadership follows local reporting lines but never borrows unrelated global managers',()=>{
 const g=darkStoreGraph();g.people.forEach(p=>{p.scopeIds=[];p.allLocations=true;});
 g.people.push(person('unrelated','SSM',{role:'Senior Store Manager',locationId:'other',scopeIds:[],allLocations:true}));
 assert.equal(resolveStoreReviewLeaders(g,'store')[0].personId,'sm');
 assert.deepEqual(resolveStoreReviewLeaders(g,'unmapped'),[]);
});
test('store leadership preserves equal-tier names, deduplicates identities, and handles cycles',()=>{
 const g=orphanStoreGraph();
 g.people.push(person('local2','SM',{role:'Store Manager',locationId:'store',scopeIds:[]}));
 g.people.push({...g.people[0],id:'duplicate'});
 g.relationships.push({subjectId:'local',managerId:'local2'},{subjectId:'local2',managerId:'local'});
 assert.deepEqual(resolveStoreReviewLeaders(g,'store').map(p=>p.personId),['local','local2']);
});
test('store in-charge title is preserved and no manager is invented for an unmapped store',()=>{
 const g={people:[person('sic','OTHER',{role:'Store In Charge',locationId:'store',scopeIds:[],userIds:[]})],relationships:[]};
 assert.equal(resolveStoreReviewLeaders(g,'store')[0].role,'Store In Charge');
 assert.deepEqual(resolveStoreReviewLeaders(g,'missing'),[]);
});

test('DS managed locations are authoritative even when a portal membership is stale',()=>{
 const g=orphanStoreGraph();
 g.people[1].managedScopeIds=[];
 assert.match(resolvePeopleReviewRoute(g,'store').error,/No City Manager or Regional Manager/);
 g.people[1].managedScopeIds=['store'];g.people[1].scopeIds=[];
 assert.match(resolvePeopleReviewRoute(g,'store').error,/does not have OpsPulse access to this store/);
 g.people[1].scopeIds=['store'];
 assert.equal(resolvePeopleReviewRoute(g,'store').chain[0].personId,'ramesh');
});
