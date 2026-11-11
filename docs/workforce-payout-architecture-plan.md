# Workforce payout architecture plan

## What is failing today

The payout page is a single blocking server render. It calculates the complete period, then loads review/publication state, payment previews, allocations, and source holds before rendering the table. The loader also reads shipment facts and four payout-input tables in parallel chunks. This is correct for financial safety, but it makes the slowest dependency determine page availability and increases database work on every refresh.

Bank-file generation has a second expensive path: it refreshes selected publications synchronously and then calls the transactional batch RPC. Enquiry upload parses the workbook, resolves legacy references, loads owned references in 50-row chunks for both ledgers, and finalizes all rows in one request. A timeout can therefore look like a rejection even after an earlier database batch has committed.

## Target workflow

1. Workforce calculates a versioned station worksheet for a closed period.
2. Station reviewers see one station card with payable count, balance, paid/processing amount, blockers, and last calculation time.
3. Reviewer confirms only that station. Confirmation creates an immutable station review with worksheet hash, row count, amount, actor, and version.
4. Finance sees only confirmed station reviews at `fin.dropxlogistics.com/finance/final-pnl` and can download a bank file for one or more confirmed stations.
5. Finance uploads the bank enquiry file. The import is an idempotent job, processed in bounded batches, with row diagnostics and resumable progress.
6. Payment state is reconciled from the immutable payment ledger. A partial credit pays only the remaining balance; a retry cannot create a duplicate UTR or second instruction.

## Required state machine

`calculated -> station_review -> finance_confirmed -> bank_file_issued -> enquiry_processing -> partially_paid | paid | needs_attention`

Rejected rows remain visible with a reason and source row. A station can be reopened only before a bank enquiry is recorded, or through an explicit Finance correction workflow. No UI may update payout or payment status directly; the existing database RPCs remain the authority.

## Performance architecture

- Split the page into a fast station summary query and a paged station-detail query. Do not load all daily breakdowns for the initial screen.
- Store a stable calculation snapshot keyed by `(company, period, station, revision)` and reuse it for review, Finance preview, and bank export.
- Replace per-worker input fan-out with one server-side period projection/RPC returning compact rows. Keep detailed evidence behind an explicit row expansion.
- Add covering indexes for company/period/station on payout facts, payment items, publication rows, review submissions, and enquiry reference lookup. Confirm with `EXPLAIN (ANALYZE, BUFFERS)` before applying.
- Keep payment preview and source-hold enrichment asynchronous or on-demand. A failure there must not hide the calculated worksheet; show a degraded status and retry action.
- Put hard limits on row count, workbook size, selected stations, and job duration. Never retry a timed-out bank operation blindly; use the operation id and replay-safe RPC.

## Bank-file and enquiry design

Bank download should return a durable batch id and a snapshot hash. Re-download uses the stored immutable items and never recalculates live rows. Finance can download by station, or select all confirmed stations, with a preview showing excluded rows before creation.

Enquiry upload should create an import record containing file hash, operation id, actor, period, and selected scope. Parse once, persist normalized row diagnostics, then process at most 20 rows per transaction (matching the existing safety rule). The UI polls progress and exposes `Updated`, `Already recorded`, `Needs attention`, and `Unmatched` separately. Exact replay of the same file is successful and does not change money.

## Edge cases to preserve

- stale calculation/publication hash, reopened station, changed bank details, inactive profile, missing PAN/Aadhaar, duplicate beneficiary, duplicate UTR, partial payment, overpayment, processing batch, conflicting station scope, legacy bare DropX references, unrelated rows, malformed workbook, and timeout after a committed batch;
- selected zero-match filters must remain selected and removable; available station/filter values must derive from the permission-scoped dataset after other filters;
- no bank file may be generated from a provisional or unconfirmed station;
- no error message may suggest changing bank amounts when the failure is authorization, ownership, timeout, or database availability.

## Delivery sequence

1. Instrument query timings, row counts, RPC duration, timeout/retry, and database error class (no personal or bank values in logs).
2. Ship the station review UI and read-only summary (this change), then validate with real permission scopes and empty/error states.
3. Add the station review table/RPC and Finance final-pnl integration in the shared Supabase project, one migration at a time with repeat tests.
4. Convert enquiry processing to resumable batches and add an import diagnostics download.
5. Move expensive payout detail and evidence behind lazy expansion; add load tests for 1, 5, 25, and 100 stations.

## Acceptance checks

Type-check and targeted payout/bank tests must pass. Verify initial page load remains usable when payment preview, publication refresh, or enquiry processing is unavailable. Verify refresh/retry with the same operation id, partial credits, duplicate UTRs, station scope, and concurrent station confirmation. Only then enable Finance downloads for the new station-confirmed path.
