import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const m={exports:{}};
const source=readFileSync(new URL('./connect-payment-approvals.ts',import.meta.url),'utf8');
new Function('require','exports','module',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(id=>{assert.equal(id,'server-only','No station DB query or approval engine is permitted');return{}},m.exports,m);
test('station approvals are absent even for explicitly assigned managers and owners',async()=>{
 for(const ids of [[],['manager'],['owner','fallback']])assert.deepEqual(await m.exports.listConnectPaymentApprovals('company',ids),[]);
});
test('stale direct station decisions are rejected before any financial mutation',async()=>{
 for(const decision of ['approved','returned','rejected'])await assert.rejects(m.exports.decideConnectPaymentApproval('company',['manager'],'existing-station-request',decision,'Note'),/OpsPulse/);
});
test('HTTP route rejects station requests with 403 while retaining reportee and roster handlers',()=>{
 const route=readFileSync(new URL('../../app/api/connect/approvals/route.ts',import.meta.url),'utf8');
 assert.match(route,/if \(paymentRequestId\) \{[\s\S]*?status: 403/);
 for(const fn of ['listLeaveApprovals','listConnectRosterApprovals','listConnectAttendanceApprovals','listConnectPayAdvanceApprovals'])assert.ok(route.includes(fn));
 assert.ok(!route.includes('await decideConnectPaymentApproval'));
});
