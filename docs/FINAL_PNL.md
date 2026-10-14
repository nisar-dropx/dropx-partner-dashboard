# Invoice-based final P&L

Fin owns the user workflow at `/finance/final-pnl`; the existing `/finance/profitability` keeps its MG, volume, payout and overhead calculations and is labelled Live provisional P&L.

The company-scoped connection uses `FIN_PNL_API_KEY` in Vercel production and Finance-worker secrets. Fin's service-role credential remains inside the existing Fin server. The worker can read only the bounded, fixed-company monthly source endpoint, not arbitrary Supabase tables. User reads require `finance_pnl` access and full-company location scope. Edits/additions require the corresponding permission; preview roles remain read-only.

The final view joins invoice documents retained by Finance-worker with server-generated final expense and recovery evidence. Invoice service month controls income, and XPT rollup follows station parent relationships and portal aliases. GST is excluded. Invoice chargebacks are expenses; the loss register is not an additional expense.

Final workforce/helper costs use latest publication revisions, before recovery deductions. Employee costs use approved payroll net earnings plus statutory/other deductions and employer contributions. Operating costs reuse the existing CPS transaction deduplication and expense-period logic, including contract rent. Estimated shipment payout and configurable CPS inputs are excluded. Payroll-labelled transaction groups are held for review to avoid duplicate payroll expense. The view clearly identifies incomplete coverage and remains open for final cost adjustments.

NL/NNL recoveries retain the original loss month. Dispute outcome, scheduled payroll month and confirmed posting date are separate. Allocation plans alone never create P&L income. Source payroll links are checked before recognizing a recovery. Where the Ops NL register does not provide a posting link, Finance can explicitly confirm a deduction/receipt with an evidence reference; this is recorded as a manual confirmation. Finance schedules do not themselves change payroll. Later source refreshes revisit old loss months.

Manual additions, edits, reallocation, deletion, restoration and recovery schedules live in Finance-worker D1 with revision checks and immutable audit history. Synchronization preserves those corrections. No Tally records or bank payments are modified by this feature.

Validation: `pnpm run test:finance-final-pnl`, existing Finance regression tests, full prebuild and Next build. Finance-worker tests exercise invoice totals, GST, chargebacks, station mapping, authentication, stale edits, audit integrity, deletion/restore, schedules and original-month recovery. Test records are isolated from production.
