import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const exports = {};
new Function('exports', ts.transpileModule(readFileSync('src/lib/fleet/daily-status-email.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText)(exports);

const recipientExports = {};
new Function('exports', 'require', ts.transpileModule(readFileSync('src/lib/fleet/daily-status-recipients.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText)(recipientExports, (specifier) => specifier === '@/lib/adhoc-digest-scope' ? { adHocOpsRoles: new Set() } : {});

const rows = [{ station: 'KOZA', ownTotal: 12, ownOperational: 6, ownNonOperational: 6, partnerTotal: 0, partnerOperational: 0, partnerNonOperational: 0, totalNonOperational: 6, adHocVans: 0 }];
const report = exports.buildFleetDailyStatusEmail({
  date: '2026-10-04',
  rows,
  exceptions: [],
  adHocRows: [
    { station: 'KOZA', type: 'Van', todayCount: 2, todayAmount: 1500, todayPendingCount: 1, todayPendingAmount: 1600, pendingCount: 3, pendingAmount: 4200, mtdCount: 8, mtdAmount: 6400 },
    { station: 'KOZA', type: 'Driver', todayCount: 1, todayAmount: 700, todayPendingCount: 2, todayPendingAmount: 1400, pendingCount: 4, pendingAmount: 2800, mtdCount: 4, mtdAmount: 2800 },
    { station: 'MTDO', type: 'Van', todayCount: 0, todayAmount: 0, todayPendingCount: 0, todayPendingAmount: 0, pendingCount: 2, pendingAmount: 3200, mtdCount: 5, mtdAmount: 8000 }
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
assert.doesNotMatch(report.html, /MTDO/);
assert.match(report.html, /Ad hoc approved today/);
assert.match(report.html, /3 pending approvals today/);
assert.doesNotMatch(report.html, /Open pending/);
assert.doesNotMatch(report.html, /Ad hoc today/);
assert.doesNotMatch(report.html, /Ad hoc MTD \+ open/);
assert.doesNotMatch(report.html, /Approved ad hoc usage/);
assert.doesNotMatch(report.html, /Review and update Fleet|Review Fleet:/);
assert.match(report.text, /32 vehicles/);
assert.match(report.text, /3 approved ad hoc usages/);
assert.match(report.text, /3 pending approvals/);

const deliveries = recipientExports.resolveFleetDailyStatusDeliveryRecipients(
  [
    { email: 'ops@example.com', name: 'Mapped Ops', stationCodes: ['KOZA', 'QLDA'], source: 'people' },
    { email: 'quiet@example.com', name: 'Other Ops', stationCodes: ['TLPA'], source: 'people' }
  ],
  [
    { email: 'ops@example.com', name: 'Mapped Ops', stationCodes: ['KTUO'] },
    { email: 'leader@example.com', name: 'Business Head', stationCodes: [] }
  ],
  ['KOZA', 'QLDA', 'KTUO', 'TLPA'],
  ['KOZA'],
  true
);
assert.deepEqual(deliveries.map((row) => row.email), ['leader@example.com', 'ops@example.com']);
assert.deepEqual(deliveries.find((row) => row.email === 'ops@example.com').stationCodes, ['KOZA', 'KTUO', 'QLDA']);
assert.deepEqual(deliveries.find((row) => row.email === 'leader@example.com').stationCodes, ['KOZA', 'KTUO', 'QLDA', 'TLPA']);
assert.ok(!deliveries.some((row) => row.email === 'quiet@example.com'));

const route = readFileSync('src/app/api/cron/fleet-daily-status/route.ts', 'utf8');
assert.match(route, /to: \[deliveryEmail\]/);
assert.match(route, /ignoreDuplicates: true/);
assert.match(route, /\.eq\("recipient_email", deliveryEmail\)/);
assert.match(route, /stationScope\.has/);
assert.match(route, /typedActivity\.filter\(\(row\) => pending\(row\.approvalStatus, row\.source\)\)/);
assert.match(route, /todayAdHocStations\.has\(row\.station\)/);
assert.match(route, /row\.todayPendingCount/);
const migration = readFileSync('supabase/migrations/20261004172422_fleet_daily_status_recipient_threads.sql', 'utf8');
assert.match(migration, /unique \(company_id, report_date, recipient_email\)/i);
assert.match(migration, /daily_status_send_time = '20:00:00'/);
assert.match(migration, /'\{monthlyThread\}'/);

console.log('Fleet daily status email: station-scoped recipient delivery, one recipient/month thread, 8:00 PM schedule, station-level T/A/P counts, and compact Van/Driver amount detail.');
const external = exports.buildFleetDailyStatusEmail({date:'2026-10-06',region:'AP',rows:[{station:'GDRD',ownTotal:0,ownOperational:0,ownNonOperational:0,partnerTotal:3,partnerOperational:2,partnerNonOperational:1,totalNonOperational:1,adHocVans:0}],exceptions:[{vehicle_no:'PRIVATE-PARTNER',ownership_type:'rented'}]});
assert.match(external.html,/ODCD \/ Rented \/ Van Vendor/);
assert.match(external.html,/fleet position · AP/);
assert.doesNotMatch(external.html,/>DropX owned<|PRIVATE-PARTNER|Non-operational vehicle actions|DropX-owned non-operational vehicles/);
const mixed = exports.buildFleetDailyStatusEmail({date:'2026-10-06',rows,exceptions:[{vehicle_no:'PARTNER-HIDDEN',ownership_type:'odcd'},{vehicle_no:'OWN-SHOWN',ownership_type:'own',station_code:'KOZA'}]});
assert.match(mixed.html,/OWN-SHOWN/);assert.doesNotMatch(mixed.html,/PARTNER-HIDDEN/);
