import test from 'node:test';import assert from 'node:assert/strict';
import {checklistSummary,summaryTask} from './checklist-summary.ts';
test('share summary retains all line items, zero values and non-English text',()=>{
 const row=summaryTask({label:'Stock',outcome:'no',numbers:{count:'0'},lines:Array.from({length:15},(_,i)=>({item:'Item '+i,quantity:'2'})),text:'പരിശോധിച്ചു · சரிபார்க்கப்பட்டது',informed:'Manager',recordStatus:'Needs attention'});
 assert.match(row.detail,/Item 14/);assert.match(row.detail,/count: 0/);assert.match(row.detail,/പരിശോധിച്ചു/);assert.equal(row.status,'Needs attention');
});
test('draft exports do not claim completion and never include evidence URLs',()=>{
 const a=checklistSummary({kind:'shift',checklist:{store_code:'TCD4',store_name:'Store',shift_date:'2026-10-26',shift_slot:'22:00',person_name:'SI',statusLabel:'In progress',pct:50,answered:1,total:2,submitted_at:null,notes:'One pending item'},sections:[{name:'Checks',tasks:[{id:'x',label:'Check',text:'',outcome:'',numbers:{},lines:[],informed:''}]}],proofs:[{task_id:'x',url:'https://private.invalid/token'}]});
 assert.match(a.submitted,/Not submitted/);assert.equal(a.sections[0].rows[0].status,'Not recorded');assert.equal(a.sections[0].rows[0].proofs,1);assert(!JSON.stringify(a).includes('private.invalid'));assert.match(a.title,/TCD4/);
});
