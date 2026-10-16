# Fin accounting HTML workflow

Adds Bank & Tally sync at `/finance/treasury/sync`, backed by a separate Cloudflare Worker and SQLite Durable Object. Fixed to Fin company `43866344-b550-4e8a-9a2d-9d23f3d8a997` and Tally company `DROPX 2026-27`.

## Implemented workflow

1. Owner opens separate FedNet and CoCloud Browser Run sessions, signing in through private five-minute live-view links. Existing Chrome sessions are not transferred.
2. FedNet collection reads all statement pages, rejects filters or changing captures, checks exact paise amounts and running balances, and saves immutable evidence. Fin previews masked account details and imports through its existing atomic accounting RPC, with company/account, permission, duplicate and overlap checks.
3. Fin prepares selected eligible approved payment requests after fresh validation of approval, beneficiary, amount limits and debit account. Download revalidates the requests. The XLSX is a review checklist, not a certified FedNet upload format. Preparation does not mark requests paid or processing.
4. Owner uploads Tally ledger masters XML, explicitly maps bank transactions to existing ledgers and approves balanced Payment or Receipt vouchers. Bill-wise ledgers require an existing bill reference. Unissued approvals can be rejected and revised.
5. Package issue requires a successful-backup reference within 24 hours and a complete Day Book export uploaded within 30 minutes covering the posting dates. Existing matching vouchers block issue. Durable source uniqueness and atomic package issue prevent regeneration of issued jobs.
6. Owner downloads the XML or stages it in CoCloud File Manager > Export. An upload attempt is recorded before the external effect; uncertain outcomes block automatic retry. Accounts team imports the package once through Tally HTML.
7. A fresh Day Book XML export verifies identifier, date, voucher type, exact ledger amounts and a positive Tally MASTERID. Duplicate or mismatched evidence remains an exception. Generated import XML is rejected as posting proof.

Bank submission, OTP, Tally import/export and expired-session login remain user checkpoints. There is no unattended scheduler, automatic payment execution, remote-canvas control, GST invoice generation, new ledger creation or automatic resolution of existing-voucher conflicts. No server connector or open ODBC port is required.

## Deployment

From this folder:

```powershell
pnpm install
pnpm test
pnpm run check
pnpm exec wrangler login --scopes account:read user:read workers:write workers_scripts:write browser:write
pnpm run deploy
pnpm exec wrangler secret put ACCOUNTING_API_KEY
```

Use a fresh random secret of at least 32 characters. Set the same value in Fin's server-only ACCOUNTING_API_KEY and set ACCOUNTING_WORKER_URL to the deployed HTTPS origin. Do not commit secrets. The worker rejects private operations until its key is configured.

Deploy this Fin branch to the existing Finance project. The worker has its own Durable Object and Browser Run binding; it does not modify finance-worker. No Supabase migration is required. Existing finance_books permissions govern statement review/import; browser control, payment preparation and voucher workflow are owner-only.

Browser keep-alive is requested for 20 minutes. Provider sessions may expire earlier; reauthentication is manual. Verify Browser Run availability, bank login compatibility and CoCloud file staging in the deployed environment.

## Accounts-team sequence

- Enrol the Federal account in Fin Cash & reconciliation. Collect a short complete unfiltered statement period, review and import.
- Review the selected payment checklist, submit in the bank yourself, then use existing Payments > Process and reconciliation screens to record confirmed results.
- In the correct Tally company export ledger masters XML and a complete Day Book for the posting period. Upload with the company and completeness attestations.
- Resolve the previously observed Tally Backup Failed condition and take a successful backup. Record its actual reference. This is a human attestation, not an automated backup-service check.
- Map and approve vouchers, issue a package, stage/download it, and import once through Tally HTML. Export a new Day Book, upload it and verify the package.
- If an upload/import is uncertain or a matching voucher already exists, inspect Tally and CoCloud before any manual retry. Issued jobs cannot be regenerated automatically.

Company identity uses the fixed company name, any XML company metadata and operator attestation; it is not independently bound to a Tally company GUID. Only simple two-ledger Payment/Receipt vouchers with optional Agst Ref bill allocation are supported. Complex vouchers require separate mapping and validation.

## Security and retention

The shared key stays server-side. Fin checks company, role, same-origin writes and body limits. XML rejects DTD/entity declarations and bounds size/depth. Generated XML escapes text; the console renders data using textContent. Status masks bank account numbers.

Live-view links control the logged-in provider session: do not share them. Credentials are entered directly on provider pages; cookies remain in the temporary Cloudflare browser. Durable storage retains session IDs, financial evidence, ledger catalogs, voucher jobs/packages, payment checklists and audit metadata. There is no automatic retention deletion; define retention before long-term operation.

Approval is an explicit owner action, but does not require two different people as maker/checker. Duplicate controls do not replace Tally import controls or readback verification.

## Validation

From the repository root:

```powershell
node --test src/lib/finance/accounting-sync/*.test.mjs workers/accounting-html/test/*.test.mjs src/lib/finance/treasury/treasury.test.mjs scripts/finance360/accounting.test.mjs
node --max-old-space-size=8192 node_modules/typescript/bin/tsc --noEmit --pretty false
```

82 tests passed, including real SQLite transactions, stale approvals, source uniqueness, backup/evidence gates, atomic issue, exact readback, scoped payment preparation, amount ceilings, spreadsheet string preservation and accounting rollback/overlap controls. Collector tests use synthetic page frames.

A local browser exercise completed statement review, draft, approval, package issue and synthetic Tally readback verification. This does not certify live FedNet, CoCloud or Tally behavior. Verify the first real capture, upload and Tally import/readback with the accounts team before routine use. Existing accounting rules reject overlapping same-day statements; prefer completed dates.

## Rollback

Remove the two Fin accounting environment variables to disable new calls, or revert the Fin change. Preserve worker evidence storage and already imported accounting entries. Deleting the Durable Object namespace deletes retained evidence.

References: https://developers.cloudflare.com/browser-run/features/live-view/ ; https://help.tallysolutions.com/import-data-from-xml-or-json/ ; https://help.tallysolutions.com/sample-xml/
