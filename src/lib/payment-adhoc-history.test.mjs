import test from 'node:test';
import assert from 'node:assert/strict';
import {historyWindow,summarizeAdhocHistory} from './payment-adhoc-history.ts';
const row=(id,date,extra={})=>({id,work_date:date,status:'PENDING',approval_status:null,amount_approved:null,amount:null,amount_requested:100,...extra});
test('previous seven days crosses month boundary; MTD excludes today',()=>{
 const result=summarizeAdhocHistory([row('a','2026-09-30'),row('b','2026-10-01')],'2026-10-01','current');
 assert.equal(result.seven.count,1);assert.equal(result.mtd.count,0);assert.equal(result.through,'2026-09-30');
 assert.equal(historyWindow('2026-10-20').from,'2026-10-01');
});
test('deduplicates station aliases and excludes current, future, rejected, returned and draft requests',()=>{
 const a=row('a','2026-10-05');
 const rows=[a,a,row('current','2026-10-05'),row('future','2026-10-07'),...['REJECTED','RETURNED','DRAFT','CANCELLED'].map((status,i)=>row('x'+i,'2026-10-05',{status}))];
 assert.equal(summarizeAdhocHistory(rows,'2026-10-06','current').mtd.count,1);
});
test('amount priority preserves approved zero and tracks unknown amounts and pending separately',()=>{
 const rows=[row('a','2026-10-05',{amount_approved:0,status:'APPROVED'}),row('b','2026-10-05',{amount:1800}),row('c','2026-10-04',{amount_requested:null})];
 const result=summarizeAdhocHistory(rows,'2026-10-06','current');
 assert.deepEqual(result.mtd,{count:3,amount:1800,pending:2,missingAmounts:1});
 rows[1].amount=1900;assert.equal(summarizeAdhocHistory(rows,'2026-10-06','current').mtd.amount,1900);
});
