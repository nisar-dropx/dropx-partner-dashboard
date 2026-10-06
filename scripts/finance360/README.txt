Finance accounting workspace

Route: /finance/books (Finance hosts only)
Permission: finance_books; company-wide location scope required.
View does not imply add/edit. Read-only preview cannot write. Owners retain their existing owner privileges. Other Finance roles require an explicit grant in Users & Access.

All new accounting data is stored under finance360_* tables. This release does not change existing payroll, operational P&L, payment processing or asset records. Those sources are linked in the UI but do not auto-post into the new books.

Controls:
- Exact decimal validation, atomic imports and deferred database balance checks.
- Stable voucher references and content fingerprints reject duplicate imports.
- Composite company foreign keys and service-only grants; browser roles have no direct database access.
- Posted journals and ledger lines are immutable. Corrections use dated reversal vouchers.
- Period locks, immutable audit history and coverage declarations.
- Coverage attestation is cleared by later backdated postings in the declared period.
- Bank CSV/Excel imports validate running / closing balances, overlap and contiguous statement joins.
- Reconciliation requires the same ledger, amount and direction. Reversed journals cannot match; reversing a matched journal clears its match.
- Lender statements are immutable snapshots. A corrected same-date snapshot becomes the latest; prior evidence remains.
- Reports show a draft qualification and dated source balances. No accounting data means reports are unavailable, rather than zero.

Upload constraints: one CSV/XLSX data sheet per file, values only; <=500 KB, <=5,000 lines and <=700,000 characters normalized. Large exports must be split at voucher boundaries; the importer does not truncate rows. Maximum single input amount: 13 integer digits plus 2 decimals. Ledger detail, audit and import history are paginated; financial aggregates are calculated in PostgreSQL. Chart / trial-balance loads page through the API's row cap.

Before Tally retirement:
1. Convert native Tally exports and reconcile master/group mappings, opening balances, voucher counts and debit/credit totals for each year.
2. Import complete current-year data and compare trial balance, P&L and BS to Tally.
3. Complete bank and loan reconciliations and review accruals, depreciation and taxes.
4. Implement and validate operational posting, invoice/bill/receivable/payable workflows, GST/TDS statutory outputs, e-invoicing, fixed-asset depreciation, cash-flow classification, and bank integrations as required.
5. Complete accountant-approved parallel closes, recovery/export testing and cutover approval.

Current limits: native Tally ZIP/XML conversion is not implemented in the uploader; bank PDFs, live bank feeds and lender integrations are not connected. Loan positions are manually recorded from lender statements. No tax returns are filed and no financial transactions are executed.

Validation:
node --test scripts/finance360/accounting.test.mjs
pnpm run prebuild
TypeScript noEmit and Vercel production build.
SQL tests run in isolated PGlite with synthetic data; no test vouchers are inserted into the production company.

Database schema is applied through Supabase apply_migration and registered there; schema.sql is the reviewed source. Production release must follow /Users/jamsheer/Documents/Codex/AGENTS.md (commit/push first, exact Finance project, verify candidate and custom domain).
