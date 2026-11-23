import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("supabase/migrations/20261123120000_hbsc_manual_workforce_delivery_identity.sql");
const route = read("src/app/api/payments/adhoc-das/route.ts");
const component = read("src/components/adhoc-delivery-fields.tsx");

assert.match(migration, /upper\(btrim\(station\.station_code\)\) = 'HBSC'/);
assert.match(migration, /w\.location_id = new\.location_id/);
assert.match(migration, /upper\(btrim\(w\.dropx_id\)\) = upper\(btrim\(new\.delivery_provider_employee_id\)\)/);
assert.match(migration, /resolved_worker/);
assert.match(route, /station\.data\.station_code\.trim\(\)\.toUpperCase\(\) === "HBSC"/);
assert.match(route, /manualWorkforce/);
assert.match(component, /HBSC Workforce person/);
assert.match(component, /Search name or DropX ID/);
console.log("PASS HBSC-only manual Workforce identity path is station-scoped, Workforce-owned and UI-wired.");
