import {test} from 'node:test';
import assert from 'node:assert/strict';
import {quietCodDecision} from './lm-cod-quiet.ts';
const now=1794470000000,issue={ids:['DA1'],amount:10000},hours=n=>n*3600000;
test('one initial alert and one escalation; unchanged late checks remain silent',()=>{
 const first=quietCodDecision(null,issue,now);assert.equal(first.reason,'initial');
 assert.equal(quietCodDecision(first.next,issue,now+hours(1)).send,false);
 const escalated=quietCodDecision(first.next,issue,now+hours(2));assert.equal(escalated.reason,'escalation');
 for(const h of [4,6,8])assert.equal(quietCodDecision(escalated.next,issue,now+hours(h)).send,false);
});
test('new or worsening issues can update after cooldown; small value noise does not',()=>{
 const prior={...issue,firstSentAt:now,lastSentAt:now,escalated:true};
 assert.equal(quietCodDecision(prior,{...issue,ids:['DA1','DA2']},now+hours(1)).send,false);
 assert.equal(quietCodDecision(prior,{...issue,ids:['DA1','DA2']},now+hours(2)).reason,'changed');
 assert.equal(quietCodDecision(prior,{...issue,amount:10005},now+hours(2)).send,false);
 assert.equal(quietCodDecision(prior,{...issue,amount:10500},now+hours(2)).send,true);
 assert.equal(quietCodDecision(prior,{...issue,amount:9000},now+hours(2)).send,false);
});
test('verified clearance resets the issue; a later new issue gets an initial alert',()=>{
 const prior={...issue,firstSentAt:now,lastSentAt:now,escalated:true};
 const cleared=quietCodDecision(prior,{ids:[],amount:0},now+hours(2));assert.equal(cleared.send,false);assert.equal(cleared.next,null);
 assert.equal(quietCodDecision(cleared.next,{ids:['DA2'],amount:5000},now+hours(3)).reason,'initial');
});
