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
    { station: 'KOZA', type: 'Van', todayCount: 2, todayAmount: 1500, pendingCount: 1, pendingAmount: 1600, mtdCount: 8, mtdAmount: 6400 },
    { station: 'KOZA', type: 'Driver', todayCount: 1, todayAmount: 700, pendingCount: 2, pendingAmount: 1400, mtdCount: 4, mtdAmount: 2800 }
  ],
  totals: { totalVehicles: 32, operational: 26, nonOperational: 6, adHoc: 3, adHocPending: 3, stationCount: 12 },
  config: { title: 'Configured title', footer: 'Configured footer', accentColor: '#123456' }
});

assert.match(report.html, /Configured title/);
assert.match(report.html, /Configured footer/);
assert.match(report.html, /#123456/);
assert.match(report.html, />32</);
assert.match(report.html, />12</);
assert.match(report.html, /Ad hoc today/);
assert.match(report.html, /Ad hoc MTD/);
assert.match(report.html, /V 2 · ₹1,500/);
assert.match(report.html, /D 1 · ₹700/);
assert.match(report.html, /V 1 pending · ₹1,600/);
assert.match(report.html, /D 2 pending · ₹1,400/);
assert.match(report.html, /V 8 · ₹6,400/);
assert.match(report.html, /D 4 · ₹2,800/);
assert.doesNotMatch(report.html, /Approved ad hoc usage/);
assert.doesNotMatch(report.html, /Review and update Fleet|Review Fleet:/);
assert.match(report.text, /32 vehicles/);
assert.match(report.text, /3 approved ad hoc usages/);
assert.match(report.text, /3 pending approvals/);
console.log('Fleet daily status email: full-fleet totals, compact approved and pending Van\/Driver values, configurable styling, and no portal access link passed.');
