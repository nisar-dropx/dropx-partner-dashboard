import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("workforce advances use one operational step followed by Finance", () => {
  const routing = read("src/lib/payment-advance-approval.ts");
  const migration = read("supabase/migrations/20261027233000_workforce_pay_advance_flow.sql");
  assert.match(routing, /reportingManagerApprover/);
  assert.match(routing, /resolvedVia: "reporting_manager"/);
  assert.match(routing, /stationManagerApprover/);
  assert.match(routing, /step_type: "manager"[\s\S]*step_type: "finance"/);
  assert.match(routing, /remapPendingPayAdvanceManagerSteps/);
  assert.match(migration, /jsonb_array_length\(p_steps\) <> 2/);
  assert.match(migration, /p_external_reference uuid/);
  assert.match(migration, /'payment_advance_requests',p_external_reference::text/);
});

test("the database enforces the 25 percent cap and reviewer amount boundaries", () => {
  const migration = read("supabase/migrations/20261027233000_workforce_pay_advance_flow.sql");
  assert.match(migration, /p_eligibility_percent <> 25/);
  assert.match(migration, /v_amount>coalesce\(request_row\.max_eligible_amount_snapshot,request_row\.requested_amount\)/);
  assert.match(migration, /current_step\.step_type<>'finance' and v_amount>request_row\.requested_amount/);
  assert.match(migration, /p_decision not in \('approved','rejected','returned'\)/);
});

test("workforce disbursement feeds the existing payout advance recovery register", () => {
  const migration = read("supabase/migrations/20261027233000_workforce_pay_advance_flow.sql");
  assert.match(migration, /if request_row\.worker_type='workforce' then[\s\S]*insert into public\.workforce_advances/);
  assert.match(migration, /'PAY_ADVANCE:'\|\|request_row\.id::text/);
  assert.match(migration, /on conflict \(company_id,lower\(btrim\(external_reference\)\)\)/);
});

test("employee history keeps comments while masking Finance identities", () => {
  const route = read("apps/connect/app/api/connect/advances/route.ts");
  const dispute = read("apps/connect/src/lib/payout-dispute.ts");
  assert.match(route, /label\.toLowerCase\(\)\.includes\("finance"\)[\s\S]*`Finance · \$\{step\.label\}`/);
  assert.match(route, /note: step\.note/);
  assert.match(dispute, /comment = comment\.replaceAll\(actorName, "Finance"\)/);
});
