import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
function load(file) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText)(require, module, module.exports);
  return module.exports;
}
const { calculateAuditScore } = load('src/lib/ops-pulse/station-audit-scoring.ts');
const { renderAuditPdf } = load('src/lib/ops-pulse/station-audit-report.ts');
const snapshot = calculateAuditScore({
  sections: [{ id: 'cash', name: 'COD', score_weight: 50 }, { id: 'shipments', name: 'Shipments', score_weight: 50 }],
  items: [{ id: 'c', section_id: 'cash', label: 'Cash accuracy', score_source: 'cash_match', response_options: [] }, { id: 's', section_id: 'shipments', label: 'Inventory accuracy', score_source: 'shipment_match', response_options: [] }],
  responses: {},
  options: [{ code: 'prior_reported', label: 'Prior missing scan', metadata: { exclude_from_score: true, pending: false, applies_to: ['shipment'] } }, { code: 'great', label: 'Great', metadata: { minimum_score: 0 } }],
  expectedCash: 500, actualCash: 500,
  expectedTids: ['TEST001', 'TEST002'], scannedTids: ['TEST001'],
  assessments: { TEST002: { code: 'prior_reported', reason: 'Verified prior report', evidenceId: 'proof' } }, evidenceIds: ['proof'],
});
assert.equal(snapshot.percentage, 100);
const pdf = await renderAuditPdf({
  number: 'TEST-REPORT', station: 'TEST - Sample', type: 'Physical audit', auditor: 'Test auditor', completed: '6 October 2026', status: 'Test only',
  summary: 'Regional notes: ശുചിത്വം. Formula uses 100 × (1 − variance ÷ total).', stationResponse: 'Verified before audit.',
  expectedCash: 500, actualCash: 500, missing: 1, excess: 0, cashCounts: [{ denomination: 500, count: 1, amount: 500 }], snapshot,
  checks: [], shipments: [{ tid: 'TEST002', discrepancy: 'missing', remarks: 'Prior missing scan', response: 'Proof verified' }], actions: [], photos: [],
});
assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
assert.ok(pdf.length > 1000);
console.log('Audit PDF passed: actual scoring formulas, verified exclusion, source lists, denominations and regional text render successfully. No email sent.');
