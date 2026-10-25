import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20261025130000_sync_open_station_approvals_from_people.sql",
  import.meta.url,
);
const source = await readFile(migrationUrl, "utf8");

test("People station changes reconcile open roster-swap approval snapshots", () => {
  assert.match(source, /create or replace function public\.reconcile_open_station_manager_approvals/);
  assert.match(source, /update hr_roster_swap_approval_steps/);
  assert.match(source, /update hr_roster_swap_requests/);
  assert.match(source, /approval_step\.status = 'pending'/);
  assert.match(source, /request\.status in \('pending_partner', 'pending_manager'\)/);
});

test("Only current active People-backed station owners are selected", () => {
  assert.match(source, /station_responsibility_assignments responsibility/);
  assert.match(source, /responsibility_role\.code in \('station_manager', 'cluster_manager'\)/);
  assert.match(source, /manager_profile\.is_active = true/);
  assert.match(source, /responsibility\.is_primary = true/);
  assert.match(source, /responsibility\.effective_to is null/);
});

test("The reconciliation is automatic and preserves audit history", () => {
  assert.match(source, /create trigger trg_sync_open_station_manager_approvals/);
  assert.match(source, /after insert or update of assignee_user_id, assignment_id, is_primary, effective_from, effective_to or delete/);
  assert.match(source, /original_approver_person_id = coalesce/);
  assert.match(source, /resolved_via = 'fallback'/);
  assert.doesNotMatch(source, /status\s*=\s*'approved'/i);
});
