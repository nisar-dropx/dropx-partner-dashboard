import assert from 'node:assert/strict';
import test from 'node:test';
import { loadReviewUserLinks } from './review-user-links.ts';

test('resolves auth user IDs without an invalid public.profiles embed; excludes inactive accounts',async()=>{
  const calls=[];
  const db={from(table){
    const builder={select(fields){assert.ok(!fields.includes('profiles!'));calls.push([table,'select',fields]);return this;},eq(key,value){calls.push([table,key,value]);return this;},in(key,values){calls.push([table,key,values]);return Promise.resolve({data:table==='hr_user_person_links'?[{person_id:'cm',user_id:'active'},{person_id:'old',user_id:'inactive'}]:[{id:'active'}],error:null});}};
    return builder;
  }};
  assert.deepEqual([...await loadReviewUserLinks(db,'company',['cm','old'])],[['cm','active']]);
  assert.ok(calls.some(c=>c[0]==='profiles'&&c[1]==='company_id'&&c[2]==='company'));
  assert.ok(calls.some(c=>c[0]==='profiles'&&c[1]==='is_active'&&c[2]===true));
});
test('an unlinked People manager stays unassigned; no login is created',async()=>{
  const db={from(table){assert.equal(table,'hr_user_person_links');return {select(){return this;},eq(){return this;},in(){return Promise.resolve({data:[],error:null});}};}};
  assert.equal((await loadReviewUserLinks(db,'company',['cm'])).size,0);
});
