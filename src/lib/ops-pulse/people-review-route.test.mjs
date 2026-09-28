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
test('conflicting station routes and ambiguous accounts are never guessed',()=>{
 const g=graph();g.people.push(person('other','NEW',{locationId:'station'}));assert.match(resolvePeopleReviewRoute(g,'station').error,/conflicting/);
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
