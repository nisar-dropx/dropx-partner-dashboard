import { existsSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// Kept in the Finance project's platform build command as well as package.json.
// A main/Dashboard checkout without the full Finance product must fail to build.
const required = [
  'src/app/finance/page.tsx',
  'src/app/finance/business/pnl-workspace.tsx',
  'src/app/finance/business/details/route.ts',
  'src/app/finance/profitability/page.tsx',
  'src/app/finance/final-pnl/page.tsx',
  'src/app/finance/revenue-reconciliation/page.tsx',
  'src/app/finance/treasury/page.tsx',
  'src/app/finance/books/page.tsx',
  'src/app/api/finance/accounting-sync/[action]/route.ts',
  'src/app/master/business/page.tsx',
  'src/app/master/assets/actions.ts',
  'src/components/finance-brand.tsx',
  'src/lib/finance/pnl-data.ts',
  'src/lib/finance/cost-data.ts',
  'src/lib/finance/cost-engine.ts',
  'src/lib/finance/cost-details.ts',
  'src/lib/finance/cost-types.ts',
  'src/lib/finance/final-pnl/sources.ts',
  'src/lib/finance/billing-periods.ts',
  'src/lib/bank-response-batches.ts',
  'src/app/api/payments/process/bank-response/route.ts',
  'src/app/api/cron/workforce-payout-publication-refresh/route.ts',
  'src/app/api/cron/attendance-reconciliation/route.ts',
];
for (const path of required) assert.ok(existsSync(path), `Incomplete Finance release: missing ${path}`);
const navigation = readFileSync('src/lib/finance/navigation.ts', 'utf8');
for (const route of ['/finance/profitability', '/finance/final-pnl', '/finance/treasury', '/finance/books']) {
  assert.ok(navigation.includes(route), `Incomplete Finance navigation: missing ${route}`);
}
if (existsSync('.vercel/project.json')) {
  const project = JSON.parse(readFileSync('.vercel/project.json', 'utf8'));
  assert.equal(project.projectId, 'prj_jGPCmnK52mKT2ejawPeKmwxgf1tL', 'This release belongs only to dropx-finance');
  // Vercel's build container writes the project ID but may omit its display name.
  if (project.projectName !== undefined) assert.equal(project.projectName, 'dropx-finance');
}
console.log(`Finance release integrity passed (${required.length} required product files).`);
