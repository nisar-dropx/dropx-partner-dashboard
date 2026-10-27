import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync("supabase/migrations/20261028153000_private_people_loss_recovery_pay.sql", "utf8");

assert.match(sql, /before insert or update of allocations on public\.nl_loss_recoveries/i);
assert.match(sql, /when allocation->>'ref' like 'workforce:%' then allocation/i);
assert.match(sql, /- 'salary_payable'[\s\S]*- 'salary_gross'[\s\S]*- 'salary_source'/i);
assert.match(sql, /update public\.nl_loss_recovery_events/i);
assert.match(sql, /update public\.nl_loss_lifecycle_events/i);
assert.match(sql, /create trigger nl_loss_lifecycle_events_immutable/i);

console.log("PASS loss-recovery People pay privacy migration");
