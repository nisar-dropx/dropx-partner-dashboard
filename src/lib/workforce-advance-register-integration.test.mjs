import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const registerPage = source("../app/payments/workforce-advances/page.tsx");
const registerComponent = source("../components/workforce-advance-register.tsx");
const registerView = source("./workforce-advance-register-view.ts");
const addAdvanceRoute = source("../app/api/payments/workforce-advances/route.ts");
const reassignAdvanceRoute = source("../app/api/payments/workforce-advances/reassign/route.ts");
const bulkUploadComponent = source("../components/workforce-advance-bulk-upload.tsx");
const bulkUploadRoute = source("../app/api/payments/workforce-advances/bulk-upload/route.ts");
const payoutPage = source("../app/payments/workforce-payouts/page.tsx");
const payoutTable = source("../components/workforce-payout-table.tsx");
const payoutLoader = source("./workforce-payout-loader.ts");
const deductAdvancesRoute = source("../app/api/payments/workforce-payouts/deduct-advances/route.ts");
const recoveryHardeningMigration = source("../../supabase/migrations/20261007110000_workforce_advance_recovery_hardening.sql");
const finalSafetyMigration = source("../../supabase/migrations/20261007112000_workforce_advance_recovery_overlap_lock_order.sql");
const allPendingRecoveryMigration = source("../../supabase/migrations/20261007170000_workforce_advance_recovery_all_pending.sql");
const periodDependencyMigration = source("../../supabase/migrations/20261007171000_workforce_payout_period_dependency_revisions.sql");
const accessPages = source("./access-pages.ts");
const accessSurface = source("./access-surface.ts");
const importHardeningMigration = source("../../supabase/migrations/20261007111000_workforce_advance_import_hardening.sql");
const reassignmentMigration = source("../../supabase/migrations/20261007210000_workforce_advance_reassignment.sql");
const reassignmentPaidLocationFix = source("../../supabase/migrations/20261007211000_workforce_advance_reassignment_paid_location_fix.sql");
const dependencyRefreshMigration = source("../../supabase/migrations/20261010041629_workforce_payout_dependency_refresh_queue.sql");

test("Workforce Advance Register is shared by Dashboard and Ops with separate page codes", () => {
  assert.match(registerPage, /currentAdminAccessSurface\(\)/);
  assert.match(
    registerPage,
    /surface\s*===\s*["']ops["']\s*\?\s*["']ops_workforce_advances["']\s*:\s*["']workforce_advances["']/
  );
  assert.match(registerPage, /requirePagePermission\(pageCode,\s*["']access["']\)/);
  assert.match(registerPage, /<AppShell[^>]+pageCode=\{pageCode\}/);
  assert.match(accessPages, /code:\s*["']workforce_advances["'][^\n]+Workforce Advance Register/);
  assert.match(accessPages, /code:\s*["']ops_workforce_advances["'][^\n]+Workforce Advance Register/);
  assert.match(accessSurface, /["']ops_workforce_advances["']/);
});

test("the register and both advance creation paths use canonical current-location scope", () => {
  assert.match(registerPage, /const allLocations\s*=\s*authorization\.hasAllLocationAccess\s*\|\|\s*isCompanyOwner\(authorization\)/);
  assert.match(registerPage, /if\s*\(!allLocations\)/);
  assert.match(registerPage, /authorization\.locationScopeIds/);
  assert.match(registerPage, /\.or\(["']migration_state\.is\.null,migration_state\.neq\.reclassified["']\)/);
  assert.match(registerPage, /workforceQuery\s*=\s*workforceQuery\.in\(["']location_id["'],\s*scope\)/);
  assert.match(registerPage, /visibleWorkforceIds\s*=\s*workforceResult\.data\.map/);
  assert.match(registerPage, /\.in\(["']workforce_id["'],\s*visibleWorkforceIds\.slice\(index,\s*index\s*\+\s*100\)\)/);
  assert.doesNotMatch(registerPage, /\.in\(["']station_id["'],\s*scope\)/);
  assert.doesNotMatch(registerPage, /\.from\(["']stations["']\)[\s\S]{0,300}?\.in\(["']id["'],\s*scope\)/);
  assert.match(registerPage, /const paidStation\s*=\s*stationById\.get\(String\(advance\.station_id\)\)/);
  assert.match(registerPage, /const currentStation\s*=\s*stationById\.get\(String\(worker\?\.location_id\s*\?\?\s*["']["']\)\)/);
  assert.match(registerPage, /location:\s*linkStatus\s*===\s*["']pending["']\s*\?\s*["']—["']\s*:\s*String\(currentStation\?\.station_code\s*\?\?\s*currentStation\?\.station_name/);
  assert.match(registerPage, /paidLocation:\s*linkStatus\s*===\s*["']pending["']\s*\?\s*["']—["']\s*:\s*String\(paidStation\?\.station_code\s*\?\?\s*paidStation\?\.station_name/);
  assert.match(registerComponent, /row\.paidLocation\s*!==\s*row\.location\s*\?\s*<small>Advance paid at \{row\.paidLocation\}<\/small>/);

  assert.match(addAdvanceRoute, /const stationId\s*=\s*String\(worker\.data\?\.location_id\s*\?\?\s*["']["']\)/);
  assert.match(addAdvanceRoute, /\.select\(["']id,dropx_id,location_id["']\)/);
  assert.match(addAdvanceRoute, /\.or\(["']migration_state\.is\.null,migration_state\.neq\.reclassified["']\)/);
  assert.match(addAdvanceRoute, /!allLocations\s*&&\s*!authorization\.locationScopeIds\.includes\(stationId\)/);
  assert.match(addAdvanceRoute, /workforce_id:\s*workforceId,[\s\S]*?station_id:\s*stationId/);
  assert.match(addAdvanceRoute, /imported_dropx_id:\s*importedDropxId,[\s\S]*?link_status:\s*["']linked["']/);

  assert.match(bulkUploadRoute, /authorization\.hasAllLocationAccess\s*\|\|\s*isCompanyOwner\(authorization\)/);
  assert.match(bulkUploadRoute, /new Set\(authorization\.locationScopeIds\)/);
  assert.match(bulkUploadRoute, /workersQuery\s*=\s*workersQuery\.in\(["']location_id["']/);
  assert.match(bulkUploadRoute, /!allLocations\s*&&\s*!allowedLocations\.has\(stationId\)/);
  assert.match(bulkUploadRoute, /outside your assigned locations/i);
  assert.match(bulkUploadRoute, /\.or\(["']migration_state\.is\.null,migration_state\.neq\.reclassified["']\)/);
  assert.match(bulkUploadRoute, /const stationId\s*=\s*String\(worker\.location_id\s*\?\?\s*["']["']\)/);
  assert.match(bulkUploadRoute, /dropx_id:\s*row\.dropxId/);
  assert.doesNotMatch(bulkUploadRoute, /p_rows:[\s\S]{0,500}?workforce_id:\s*row\.workforceId/);
  assert.doesNotMatch(bulkUploadRoute, /p_rows:[\s\S]{0,500}?station_id:\s*row\.stationId/);
});

test("bulk upload requires add permission and follows preview then explicit confirmation", () => {
  assert.match(
    bulkUploadRoute,
    /currentAdminAccessSurface\(\)\s*===\s*["']ops["']\s*\?\s*["']ops_workforce_advances["']\s*:\s*["']workforce_advances["']/
  );
  assert.match(bulkUploadRoute, /hasPermission\(authorization,\s*pageCode,\s*["']add["']\)/);
  assert.match(bulkUploadRoute, /mode\s*!==\s*["']preview["']\s*&&\s*mode\s*!==\s*["']commit["']/);
  assert.match(bulkUploadRoute, /if\s*\(mode\s*===\s*["']preview["']\)\s*return Response\.json\(preview/);
  assert.match(bulkUploadRoute, /if\s*\(issues\.length\)\s*return Response\.json/);
  assert.match(bulkUploadRoute, /file_sha256/);
  assert.match(bulkUploadRoute, /already imported/i);
  assert.match(bulkUploadRoute, /workforceAdvanceImportBusinessKey/);
  assert.match(bulkUploadRoute, /dropx_id:\s*row\.dropxId/);
  assert.doesNotMatch(bulkUploadRoute, /external_reference:\s*row\.businessKey/);
  assert.match(bulkUploadRoute, /deducted_amount:\s*row\.deductedAmount/);
  assert.match(bulkUploadRoute, /already in the register as/);

  assert.match(bulkUploadComponent, /submit\(["']preview["']\)/);
  assert.match(bulkUploadComponent, /preview\.canCommit/);
  assert.match(bulkUploadComponent, /window\.confirm\(/);
  assert.match(bulkUploadComponent, /submit\(["']commit["']\)/);
  assert.match(bulkUploadComponent, /Nothing has been added yet/i);
  assert.match(bulkUploadComponent, /DEDUCTED_AMOUNT will be recorded as already recovered/i);
  assert.match(bulkUploadComponent, /Duplicate advances are blocked even if the workbook was re-saved/i);
  assert.match(bulkUploadComponent, /Already deducted/);
  assert.match(registerComponent, /canAdd\s*\?\s*<>[\s\S]*?<WorkforceAdvanceBulkUpload\s*\/>/);
});

test("advance reassignment is edit-only, company-scoped, transactional and audit-backed", () => {
  assert.match(registerPage, /const canEdit\s*=\s*hasPermission\(authorization,\s*pageCode,\s*["']edit["']\)/);
  assert.match(registerPage, /<WorkforceAdvanceRegister[^>]+canEdit=\{canEdit\}/);
  assert.match(registerComponent, /<th className=["']workforce-advance-action-cell["']>Actions<\/th>/);
  assert.match(registerComponent, /<AdvanceReassignmentModal/);
  assert.match(registerComponent, /fetch\(["']\/api\/payments\/workforce-advances\/reassign["']/);
  assert.match(registerComponent, /const locked\s*=\s*row\.deducted\s*>\s*0/);
  assert.match(registerComponent, /disabled=\{locked\}/);
  assert.match(registerComponent, /workforceOptions\.filter\(\(option\)\s*=>\s*option\.id\s*!==\s*reassignRow\.workforceId\)/);
  assert.match(registerComponent, /if\s*\(!normalizedReason\)[\s\S]*?Enter the reason for this reassignment/);
  assert.match(registerComponent, /<textarea[\s\S]{0,500}?\brequired\b/);
  assert.match(registerComponent, /Original imported ID/);
  assert.match(registerComponent, /Reassignment history \(\{row\.reassignmentHistory\.length\}\)/);
  assert.match(registerPage, /from_station_id[\s\S]*?to_station_id/);
  assert.match(
    registerPage,
    /!allLocations\s*&&\s*!reassignmentLocationIds\.every\(\(locationId\)\s*=>\s*allowedLocationIds\.has\(locationId\)\)/
  );
  assert.match(registerPage, /normalizeDropxId\(worker\.dropx_id\)\s*!==\s*["']{2}/);

  assert.match(reassignAdvanceRoute, /sameOrigin\(request\)/);
  assert.match(
    reassignAdvanceRoute,
    /currentAdminAccessSurface\(\)\s*===\s*["']ops["']\s*\?\s*["']ops_workforce_advances["']\s*:\s*["']workforce_advances["']/
  );
  assert.match(reassignAdvanceRoute, /hasPermission\(authorization,\s*pageCode,\s*["']edit["']\)/);
  assert.doesNotMatch(reassignAdvanceRoute, /hasPermission\(authorization,\s*pageCode,\s*["']add["']\)/);
  assert.match(reassignAdvanceRoute, /reason\.length\s*<\s*3\s*\|\|\s*reason\.length\s*>\s*500/);
  assert.match(reassignAdvanceRoute, /rpc\(["']workforce_reassign_advance["']/);
  for (const parameter of [
    "p_company_id",
    "p_advance_id",
    "p_target_workforce_id",
    "p_expected_workforce_id",
    "p_expected_identity_revision",
    "p_reason",
    "p_actor_user_id",
    "p_allowed_location_ids"
  ]) assert.match(reassignAdvanceRoute, new RegExp(`${parameter}:`));
  assert.match(
    reassignAdvanceRoute,
    /p_allowed_location_ids:\s*allLocations\s*\?\s*null\s*:\s*authorization\.locationScopeIds/
  );

  assert.match(reassignmentMigration, /add column identity_revision integer not null default 0/i);
  assert.match(reassignmentMigration, /create table public\.workforce_advance_reassignments/i);
  assert.match(reassignmentMigration, /foreign key \(company_id, advance_id\)[\s\S]*?references public\.workforce_advances\(company_id, id\)[\s\S]*?on delete restrict/i);
  assert.match(reassignmentMigration, /unique \(company_id, advance_id, revision\)/i);
  assert.match(reassignmentMigration, /before update or delete on public\.workforce_advance_reassignments/i);
  assert.match(reassignmentMigration, /original imported DropX ID is immutable/i);
  assert.match(reassignmentMigration, /identity changes require an immutable reassignment audit/i);
  assert.match(reassignmentMigration, /create or replace function public\.workforce_reassign_advance/i);
  assert.match(reassignmentMigration, /order by workforce\.id[\s\S]*?for update;[\s\S]*?lock_workforce_payment_allocation_company\(p_company_id\)/i);
  assert.match(reassignmentMigration, /advance\.identity_revision\s*<>\s*p_expected_identity_revision/i);
  assert.match(reassignmentMigration, /advance\.workforce_id is distinct from p_expected_workforce_id/i);
  assert.match(reassignmentMigration, /opening_deducted_amount\s*>\s*0\s*or\s*v_active_deducted\s*>\s*0/i);
  assert.match(reassignmentMigration, /source or target Workforce advance is outside your assigned locations/i);
  assert.match(reassignmentMigration, /insert into public\.workforce_advance_reassignments/i);
  assert.match(reassignmentMigration, /identity_revision\s*=\s*v_next_revision/i);
  assert.match(reassignmentMigration, /alter table public\.workforce_advance_reassignments enable row level security/i);
  assert.match(reassignmentMigration, /grant select on table public\.workforce_advance_reassignments to service_role/i);
  assert.match(reassignmentMigration, /revoke all on function public\.workforce_reassign_advance[\s\S]*?from public, anon, authenticated, service_role/i);
  assert.match(reassignmentMigration, /grant execute on function public\.workforce_reassign_advance[\s\S]*?to service_role/i);
  assert.match(reassignmentPaidLocationFix, /Historical station where the advance was paid/i);
  assert.match(reassignmentPaidLocationFix, /The advance paid-at location is immutable/i);
  assert.doesNotMatch(
    reassignmentPaidLocationFix,
    /set[\s\S]{0,180}?station_id\s*=\s*v_target_workforce\.location_id/i
  );
  assert.match(
    reassignmentPaidLocationFix,
    /v_advance\.workforce_id,\s*v_source_workforce\.location_id/i
  );
  assert.match(reassignmentPaidLocationFix, /'paidLocationPreserved',\s*true/i);
});

test("unregistered DropX IDs preview and render as non-deductible pending advances", () => {
  assert.match(bulkUploadRoute, /workersByDropxId\.get\(row\.normalizedDropxId\)/);
  assert.match(bulkUploadRoute, /if\s*\(!matches\.length\)[\s\S]*?if\s*\(!allLocations\)[\s\S]*?not available in your assigned locations/i);
  assert.match(bulkUploadRoute, /fullName:\s*["']Awaiting Workforce registration["']/);
  assert.match(bulkUploadRoute, /linkStatus:\s*["']pending["']/);
  assert.match(bulkUploadRoute, /pendingRows:/);
  assert.match(bulkUploadComponent, /Awaiting Workforce registration/);
  assert.match(bulkUploadComponent, /cannot be deducted from payouts until registration links it automatically/i);

  for (const column of ["imported_dropx_id", "link_status", "opening_deducted_amount", "linked_at"]) {
    assert.match(registerPage, new RegExp(column));
  }
  assert.match(registerPage, /linkStatus\s*===\s*["']pending["'][\s\S]*?advance\.opening_deducted_amount/);
  assert.match(registerPage, /status:\s*linkStatus\s*===\s*["']pending["']\s*\?\s*["']Awaiting Workforce registration["']/);
  assert.match(registerComponent, /Not eligible for payout deduction/);
  assert.match(registerComponent, /row\.linkStatus\s*===\s*["']pending["']/);
});

test("bulk import hardening atomically records opening deductions and stable duplicate keys", () => {
  assert.match(importHardeningMigration, /v_deducted_amount\s*:=\s*coalesce/i);
  assert.match(importHardeningMigration, /v_deducted_amount\s*<\s*0[\s\S]*?v_deducted_amount\s*>\s*v_amount/i);
  assert.match(importHardeningMigration, /v_business_key\s*:=\s*'WAI1-'\s*\|\|\s*md5/i);
  assert.match(importHardeningMigration, /duplicates an advance already in the register/i);
  assert.match(importHardeningMigration, /insert into public\.workforce_advance_recoveries\([\s\S]*?'opening_balance'[\s\S]*?'deducted'/i);
  assert.match(importHardeningMigration, /period_start, period_end[\s\S]*?v_advance_date, v_advance_date/i);
  assert.match(importHardeningMigration, /revoke all on function public\.workforce_apply_advance_import/i);
  assert.match(importHardeningMigration, /grant execute on function public\.workforce_apply_advance_import/i);
});

test("manual advance entry has an accessible searchable Workforce selector and labelled register filters", () => {
  assert.match(registerComponent, /function\s+WorkforceSearchSelect/);
  assert.match(registerComponent, /role=["']combobox["']/);
  assert.match(registerComponent, /aria-autocomplete=["']list["']/);
  assert.match(registerComponent, /role=["']listbox["']/);
  assert.match(registerComponent, /name=["']workforceId["'][^>]+type=["']hidden["']/);
  assert.match(registerComponent, /Select a Workforce member from the search results\./);
  assert.match(registerComponent, /<span>Search advances<\/span>/);
  assert.match(registerComponent, /label=["']Deduction status["']/);
});

test("advance register filters are searchable multi-check controls with an inclusive paid-on range", () => {
  assert.match(registerComponent, /function\s+AdvanceMultiFilter/);
  assert.match(registerComponent, /aria-haspopup=["']dialog["']/);
  assert.match(registerComponent, /placeholder=\{`Search \$\{label\.toLowerCase\(\)\}`\}/);
  assert.match(registerComponent, /visibleOptions\.map[\s\S]*?type=["']checkbox["']/);
  for (const label of [
    "Current location",
    "Advance paid at",
    "Designation",
    "Payment mode",
    "Deduction status",
    "Registration status",
    "Source"
  ]) assert.match(registerComponent, new RegExp(`label=["']${label}["']`));
  assert.match(registerComponent, /<span>Paid from<\/span>[\s\S]*?type=["']date["']/);
  assert.match(registerComponent, /<span>Paid to<\/span>[\s\S]*?type=["']date["']/);
  assert.match(registerComponent, /Paid from date must be on or before paid to date\./);
  assert.match(registerComponent, /function\s+clearFilters\(\)[\s\S]*?setSearch\(["']["']\)[\s\S]*?setLocations\(\[\]\)[\s\S]*?setDateFrom\(["']["']\)[\s\S]*?setDateTo\(["']["']\)[\s\S]*?setPage\(1\)/);
});

test("filtered rows drive totals, table pagination and the view-scoped CSV export", () => {
  assert.match(registerComponent, /filterWorkforceAdvanceRows\(rows,\s*search,\s*filters\)/);
  assert.doesNotMatch(registerComponent, /useDeferredValue/);
  assert.match(registerComponent, /summarizeWorkforceAdvanceRows\(filtered\)/);
  assert.match(registerComponent, /money\(summary\.total\)/);
  assert.match(registerComponent, /money\(summary\.deducted\)/);
  assert.match(registerComponent, /money\(summary\.pending\)/);
  assert.match(registerComponent, /const visible\s*=\s*filtered\.slice/);
  assert.match(registerComponent, /buildWorkforceAdvanceCsv\(filtered\)/);
  assert.match(registerComponent, /Export filtered CSV/);
  assert.doesNotMatch(registerComponent, /fetch\([^)]*workforce-advances[^)]*export/i);
  assert.match(registerView, /return "\\uFEFF"/);
  assert.match(registerView, /numericIdentifierAtRisk/);
  assert.match(registerView, /startsLikeFormula/);
  assert.match(registerComponent, /Unassigned \/ unavailable/);
});

test("advance recovery requires edit access to both payout and advance pages", () => {
  assert.match(deductAdvancesRoute, /payoutPageCode\s*=\s*ops\s*\?\s*["']ops_workforce_payouts["']\s*:\s*["']workforce_payouts["']/);
  assert.match(deductAdvancesRoute, /advancePageCode\s*=\s*ops\s*\?\s*["']ops_workforce_advances["']\s*:\s*["']workforce_advances["']/);
  assert.match(
    deductAdvancesRoute,
    /!hasPermission\(authorization,\s*payoutPageCode,\s*["']edit["']\)\s*\|\|\s*!hasPermission\(authorization,\s*advancePageCode,\s*["']edit["']\)/
  );
  assert.match(deductAdvancesRoute, /Edit access to both Workforce Payouts and Workforce Advance Register is required/i);
  assert.match(payoutPage, /canDeductAdvances\s*=\s*audience\s*===\s*["']workforce["'][\s\S]*?canEdit[\s\S]*?hasPermission\(authorization,\s*advancePageCode,\s*["']edit["']\)/);
});

test("recovery hashes every payout dependency, respects scope, and caps ADVANCE at available net pay", () => {
  assert.match(
    deductAdvancesRoute,
    /rpc\(["']workforce_advance_recovery_snapshot_hash["'],\s*\{[\s\S]*?p_company_id:\s*companyId[\s\S]*?p_period_start:\s*periodStart[\s\S]*?p_period_end:\s*periodEnd/
  );
  assert.doesNotMatch(deductAdvancesRoute, /rpc\(["']workforce_payout_input_snapshot_hash["']/);
  assert.match(
    deductAdvancesRoute,
    /const snapshotBefore\s*=\s*await payoutSnapshotHash\(companyId,\s*periodStart,\s*periodEnd\)[\s\S]*?const loaded\s*=\s*await loadWorkforcePayoutRows\(companyId,\s*authorization,\s*periodStart,\s*periodEnd\)[\s\S]*?const snapshotAfter\s*=\s*await payoutSnapshotHash\(companyId,\s*periodStart,\s*periodEnd\)/
  );
  assert.match(deductAdvancesRoute, /MAX_CALCULATION_ATTEMPTS\s*=\s*2/);
  assert.match(deductAdvancesRoute, /snapshotAfter\s*!==\s*snapshotBefore\)\s*continue/);
  assert.match(deductAdvancesRoute, /if\s*\(changedDuringApply\)\s*continue/);
  assert.doesNotMatch(deductAdvancesRoute, /Payout inputs changed while the selected rows were being calculated/);
  assert.match(deductAdvancesRoute, /selected payout period is still updating/i);
  assert.match(deductAdvancesRoute, /row\.deductionBreakdown[\s\S]*?line\.code\.trim\(\)\.toUpperCase\(\)\s*===\s*["']ADVANCE["']/);
  assert.match(deductAdvancesRoute, /otherDeductions\s*=\s*Math\.max\(0,\s*row\.deductions\s*-\s*currentAdvance\)/);
  assert.match(deductAdvancesRoute, /maxAmount\s*=\s*Math\.max\(0,[\s\S]*?row\.grossPayment\s*-\s*otherDeductions/);
  assert.match(deductAdvancesRoute, /max_amount:\s*maxAmount/);
  assert.match(deductAdvancesRoute, /snapshot_hash:\s*snapshotAfter/);
  assert.match(
    deductAdvancesRoute,
    /p_allowed_location_ids:\s*authorization\.hasAllLocationAccess\s*\?\s*null\s*:\s*authorization\.locationScopeIds/
  );
  assert.match(deductAdvancesRoute, /later advance deductions|recalculating this earlier period/i);
});

test("advance deductions revise already-published payout snapshots without fake import provenance", () => {
  assert.match(dependencyRefreshMigration, /add column refresh_source text not null default 'input_batch'/i);
  assert.match(dependencyRefreshMigration, /add column refresh_request_id uuid/i);
  assert.match(
    dependencyRefreshMigration,
    /refresh_source = 'payout_dependency'[\s\S]*?input_batch_id is null/i
  );
  assert.match(
    dependencyRefreshMigration,
    /create trigger workforce_payout_deduction_values_90_queue_publication_refresh[\s\S]*?after insert or update or delete on public\.workforce_payout_deduction_values/i
  );
  assert.match(
    dependencyRefreshMigration,
    /old\.source_type in \('advance_register', 'payment_recovery'\)[\s\S]*?new\.source_type in \('advance_register', 'payment_recovery'\)/i
  );
  assert.match(dependencyRefreshMigration, /old\.amount is not distinct from new\.amount/i);
  assert.match(
    dependencyRefreshMigration,
    /revision_source in \([\s\S]*?'initial'[\s\S]*?'input_batch_refresh'[\s\S]*?'mapping_relock'[\s\S]*?'dependency_refresh'/i
  );
  assert.match(dependencyRefreshMigration, /case when v_revision_source = ''input_batch''[\s\S]*?''dependency_refresh''/i);
  assert.match(
    dependencyRefreshMigration,
    /new\.revision_source in \('input_batch_refresh', 'dependency_refresh'\)[\s\S]*?previous\.mapping_relock_id/i
  );
  assert.match(
    dependencyRefreshMigration,
    /public\.workforce_advance_recoveries recovery[\s\S]*?recovery\.created_at > latest\.published_at[\s\S]*?recovery\.reversed_at/i
  );
  assert.doesNotMatch(dependencyRefreshMigration, /insert into public\.workforce_payout_import_batches/i);

  assert.match(deductAdvancesRoute, /refreshWorkforcePayoutPublicationJobs/);
  assert.match(
    deductAdvancesRoute,
    /workforceIds:\s*\[\.\.\.new Set\(selected\.map\([\s\S]*?periodStart,[\s\S]*?periodEnd,[\s\S]*?limit:\s*Math\.min\(100, selected\.length\)/
  );
  assert.match(deductAdvancesRoute, /publicationRefresh\s*\n?\s*}/);
});

test("high-frequency attendance and shipment revisions are scoped to the payout month", () => {
  assert.match(periodDependencyMigration, /create table public\.workforce_payout_period_dependency_revisions/i);
  assert.match(
    periodDependencyMigration,
    /primary key \(company_id, period_month\)[\s\S]*?period_month = date_trunc\('month', period_month\)::date/i
  );
  assert.match(
    periodDependencyMigration,
    /foreach v_table in array array\['attendance_daily', 'cps_shipment_daily'\][\s\S]*?drop trigger if exists workforce_payout_dependency_revision_insert[\s\S]*?create trigger workforce_payout_period_dependency_revision_insert/i
  );
  assert.match(periodDependencyMigration, /punch_date[\s\S]*?work_date/);
  assert.match(periodDependencyMigration, /payout_period_old_rows[\s\S]*?union[\s\S]*?payout_period_new_rows/i);
  assert.match(
    periodDependencyMigration,
    /perform public\.lock_workforce_payment_allocation_company\(p_company_id\)[\s\S]*?on conflict \(company_id, period_month\) do update/i
  );
  assert.match(
    periodDependencyMigration,
    /generate_series\([\s\S]*?p_period_start[\s\S]*?p_period_end[\s\S]*?workforce_payout_period_dependency_revisions/i
  );
  assert.match(
    periodDependencyMigration,
    /coalesce\(company_revision\.revision, 0\)[\s\S]*?period_material\.value/i
  );
  assert.match(
    periodDependencyMigration,
    /create policy workforce_payout_period_dependency_revisions_service_role_select[\s\S]*?to service_role using \(true\)/i
  );
  assert.match(periodDependencyMigration, /grant execute on function public\.workforce_advance_recovery_snapshot_hash[\s\S]*?to service_role/i);
});

test("recovery hardening versions all loader inputs and preserves FIFO audit history", () => {
  const loaderTables = new Set([...payoutLoader.matchAll(/\.from\(["']([^"']+)["']\)/g)].map((match) => match[1]));
  for (const table of loaderTables) {
    assert.match(
      recoveryHardeningMigration,
      new RegExp(`['\"]${table}['\"]`),
      `the dependency revision must include payout-loader table ${table}`
    );
  }
  for (const table of [
    "stations",
    "location_models",
    "field_executive_provider_mappings",
    "workforce_payment_allocations",
    "payment_field_provider_metrics",
    "provider_production_metrics",
    "workforce_deduction_heads",
    "workforce_payment_settings",
    "workforce_attendance_capture_settings",
    "workforce",
    "cps_shipment_daily",
    "contractors",
    "employees",
    "connect_profile_verifications",
    "payment_method_components",
    "payment_methods",
    "payment_fields",
    "workforce_payout_attendance_overrides",
    "workforce_payout_attendance_values",
    "workforce_payment_field_overrides",
    "workforce_custom_production_inputs",
    "attendance_daily",
    "workforce_additional_payment_fields",
    "workforce_additional_payment_values",
    "workforce_payout_deduction_values",
    "providers",
    "designations"
  ]) assert.match(recoveryHardeningMigration, new RegExp(`['\"]${table}['\"]`));

  assert.match(recoveryHardeningMigration, /create table public\.workforce_payout_dependency_revisions/i);
  assert.match(recoveryHardeningMigration, /create policy workforce_payout_dependency_revisions_service_role_select[\s\S]*?to service_role using \(true\)/i);
  assert.match(recoveryHardeningMigration, /information_schema\.columns[\s\S]*?column_info\.column_name = 'company_id'[\s\S]*?column_info\.udt_name = 'uuid'/i);
  assert.match(recoveryHardeningMigration, /statement_timestamp\(\) at time zone 'Asia\/Kolkata'/i);
  assert.match(recoveryHardeningMigration, /perform public\.lock_workforce_payment_allocation_company\(p_company_id\)[\s\S]*?workforce_advance_recovery_snapshot_hash/i);
  assert.ok(
    (recoveryHardeningMigration.match(/v_current_snapshot_hash\s*:=\s*public\.workforce_advance_recovery_snapshot_hash/gi) ?? []).length >= 2,
    "the RPC must validate the dependency revision both before mutation and before return"
  );
  assert.match(recoveryHardeningMigration, /if v_plan_is_identical then[\s\S]*?continue;/i);
  assert.match(recoveryHardeningMigration, /Later ADVANCE deductions already exist[\s\S]*?before recalculating this earlier period/i);
  assert.match(recoveryHardeningMigration, /recovery\.period_end < p_period_start/i);
});

test("final recovery safety rejects period overlap and keeps import lock order deterministic", () => {
  assert.match(
    finalSafetyMigration,
    /create or replace function public\.workforce_apply_advance_import[\s\S]*?order by workforce\.id[\s\S]*?for update;[\s\S]*?perform public\.lock_workforce_payment_allocation_company\(p_company_id\)/i
  );
  assert.match(
    finalSafetyMigration,
    /daterange\(recovery\.period_start, recovery\.period_end, '\[\]'\)[\s\S]*?&& daterange\(p_period_start, p_period_end, '\[\]'\)[\s\S]*?<> \(p_period_start, p_period_end\)/i
  );
  assert.match(
    finalSafetyMigration,
    /recovery\.recovery_type = 'opening_balance'[\s\S]*?recovery\.recovery_type = 'payout'[\s\S]*?recovery\.period_end < p_period_start/i
  );
  assert.match(
    finalSafetyMigration,
    /if v_plan_is_identical then[\s\S]*?continue;[\s\S]*?recovery\.period_start > p_period_end/i
  );
});

test("advance recovery includes every linked pending advance without a payment-date cutoff", () => {
  assert.match(allPendingRecoveryMigration, /create or replace function public\.workforce_apply_advance_recoveries/i);
  assert.doesNotMatch(allPendingRecoveryMigration, /advance\.advance_date\s*<=\s*p_period_end/i);
  assert.ok(
    (allPendingRecoveryMigration.match(/advance\.workforce_id\s*=\s*v_workforce_id/gi) ?? []).length >= 2,
    "only advances linked to the selected canonical Workforce identity may enter locking and FIFO planning"
  );
  assert.match(
    allPendingRecoveryMigration,
    /from public\.workforce_advances advance[\s\S]*?advance\.workforce_id = v_workforce_id[\s\S]*?order by advance\.advance_date, advance\.created_at, advance\.id[\s\S]*?for update/i
  );
  assert.match(
    allPendingRecoveryMigration,
    /with fifo as \([\s\S]*?where advance\.company_id = p_company_id[\s\S]*?advance\.workforce_id = v_workforce_id[\s\S]*?order by fifo\.advance_date, fifo\.created_at, fifo\.id/i
  );
  assert.match(
    allPendingRecoveryMigration,
    /recovery\.recovery_type = 'payout'[\s\S]*?\(recovery\.period_start, recovery\.period_end\)[\s\S]*?<> \(p_period_start, p_period_end\)/i
  );
  assert.doesNotMatch(allPendingRecoveryMigration, /onboarding_status|lifecycle_status|advance\.link_status\s*=\s*['"]pending['"]/i);
  assert.match(allPendingRecoveryMigration, /workforce_additional_payment_location_is_authorized/);
  assert.match(allPendingRecoveryMigration, /if v_plan_is_identical then[\s\S]*?continue;/i);
  assert.match(allPendingRecoveryMigration, /idempotency_key[\s\S]*?p_period_start::text[\s\S]*?p_period_end::text/i);
  assert.ok(
    (allPendingRecoveryMigration.match(/v_current_snapshot_hash\s*:=\s*public\.workforce_advance_recovery_snapshot_hash/gi) ?? []).length >= 2,
    "snapshot validation must remain before and after recovery mutation"
  );
  assert.match(allPendingRecoveryMigration, /revoke all on function public\.workforce_apply_advance_recoveries/i);
  assert.match(allPendingRecoveryMigration, /grant execute on function public\.workforce_apply_advance_recoveries[\s\S]*?to service_role/i);
});

test("the payout table exposes a confirmed ADVANCE deduction action for selected payouts", () => {
  assert.match(payoutTable, /async function deductPendingAdvances\(\)/);
  assert.match(payoutTable, /window\.confirm\([\s\S]*?oldest pending advances first[\s\S]*?never reduce net pay below zero/i);
  assert.match(payoutTable, /fetch\(["']\/api\/payments\/workforce-payouts\/deduct-advances["']/);
  assert.match(payoutTable, /periodStart,[\s\S]*?periodEnd,[\s\S]*?workforceId:\s*row\.reviewSubjectId[\s\S]*?stationId:\s*row\.locationId/);
  assert.match(payoutTable, /canDeductAdvances\s*\?\s*<button[^>]+onClick=\{deductPendingAdvances\}/);
  assert.match(payoutTable, /Deduct pending advances/);
  assert.match(payoutTable, /under ADVANCE/);
});

test("advance deduction and review submission use separate row eligibility", () => {
  assert.match(payoutTable, /ADVANCE_DEDUCTION_LOCKED_STATUSES\s*=\s*new Set\(\[[^\]]*["']approved["'][^\]]*["']paid["'][^\]]*["']finalized["']/);
  assert.match(payoutTable, /function\s+canDeductAdvanceFromPayout\(row:[^)]+\)[\s\S]*?row\.reviewSubjectId[\s\S]*?row\.locationId[\s\S]*?row\.paymentDetailsAvailable[\s\S]*?!ADVANCE_DEDUCTION_LOCKED_STATUSES\.has/);
  assert.match(payoutTable, /canDeductAdvances\s*&&\s*canDeductAdvanceFromPayout\(row\)/);
  assert.match(payoutTable, /reviewSelectedRows\s*=\s*useMemo\(\(\)\s*=>\s*selectedRows\.filter\(\(row\)\s*=>\s*canSendPayoutForReview\(row,\s*audience\)\)/);
  assert.match(payoutTable, /advanceSelectedRows\s*=\s*useMemo\(\(\)\s*=>\s*selectedRows\.filter\(canDeductAdvanceFromPayout\)/);
  assert.match(payoutTable, /skippedReviewSelectionCount\s*=\s*selectedRows\.length\s*-\s*reviewSelectedRows\.length/);
  assert.match(payoutTable, /reviewSelectedRows\.length\} of \{selectedRows\.length\} selected eligible for/);
  assert.match(payoutTable, /chunkPayoutRowsBySubject\(reviewSelectedRows,[\s\S]*?items:\s*chunk\.map/);
  assert.match(payoutTable, /disabled=\{\(audience === "workforce" && !canPublish\)\s*\|\|\s*!reviewSelectedRows\.length/);
  assert.match(payoutTable, /chunkedValues\(advanceSelectedRows,[\s\S]*?items:\s*chunk\.map/);
  assert.match(payoutTable, /Available for advance deduction only\./);
});
