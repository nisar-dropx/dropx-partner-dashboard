import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const exports = {};
new Function('exports', ts.transpileModule(readFileSync('src/lib/fleet/daily-status-email.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText)(exports);

const rows = [{ station: 'KOZA', ownTotal: 12, ownOperational: 6, ownNonOperational: 6, partnerTotal: 0, partnerOperational: 0, partnerNonOperational: 0, totalNonOperational: 6, adHocVans: 0 }];
const report = exports.buildFleetDailyStatusEmail({
  date: '2026-10-04',
  rows,
  exceptions: [],
  adHocRows: [
    { station: 'KOZA', type: 'Van', todayCount: 2, todayAmount: 1500, todayPendingCount: 1, todayPendingAmount: 1600, pendingCount: 3, pendingAmount: 4200, mtdCount: 8, mtdAmount: 6400 },
    { station: 'KOZA', type: 'Driver', todayCount: 1, todayAmount: 700, todayPendingCount: 2, todayPendingAmount: 1400, pendingCount: 4, pendingAmount: 2800, mtdCount: 4, mtdAmount: 2800 }
  ],
  totals: { totalVehicles: 32, operational: 26, nonOperational: 6, adHoc: 3, adHocPending: 3, stationCount: 12 },
  config: { title: 'Configured title', footer: 'Configured footer', accentColor: '#123456' }
});

assert.match(report.html, /Configured title/);
assert.match(report.html, /Configured footer/);
assert.match(report.html, /#123456/);
assert.match(report.html, />32</);
assert.match(report.html, />12</);
assert.match(report.html, /Ad hoc usage and approvals/);
assert.match(report.html, /Today/);
assert.match(report.html, /Ad hoc count/);
assert.match(report.html, /T \/ A \/ P/);
assert.match(report.html, /6 \/ 3 \/ 3/);
assert.match(report.html, /19 \/ 12 \/ 7/);
assert.match(report.html, /<th[^>]*>Van<\/th><th[^>]*>Driver<\/th><th[^>]*>Van<\/th><th[^>]*>Driver<\/th>/);
assert.match(report.html, /Total <strong>3<\/strong> · ₹3,100/);
assert.match(report.html, /Approved 2 · ₹1,500/);
assert.match(report.html, /Pending 1 · ₹1,600/);
assert.match(report.html, /Total <strong>3<\/strong> · ₹2,100/);
assert.match(report.html, /Approved 1 · ₹700/);
assert.match(report.html, /Pending 2 · ₹1,400/);
assert.match(report.html, /Total <strong>11<\/strong> · ₹10,600/);
assert.match(report.html, /Approved 8 · ₹6,400/);
assert.match(report.html, /Pending 3 · ₹4,200/);
assert.match(report.html, /Total <strong>8<\/strong> · ₹5,600/);
assert.match(report.html, /Approved 4 · ₹2,800/);
assert.match(report.html, /Pending 4 · ₹2,800/);
assert.doesNotMatch(report.html, /Open pending/);
assert.doesNotMatch(report.html, /Ad hoc today/);
assert.doesNotMatch(report.html, /Ad hoc MTD \+ open/);
assert.doesNotMatch(report.html, /Approved ad hoc usage/);
assert.doesNotMatch(report.html, /Review and update Fleet|Review Fleet:/);
assert.match(report.text, /32 vehicles/);
assert.match(report.text, /3 approved ad hoc usages/);
assert.match(report.text, /3 pending approvals/);
console.log('Fleet daily status email: station-level T/A/P counts plus compact Today and MTD count-and-amount detail, configurable styling, and no portal access link passed.');
