import assert from "node:assert/strict";
import test from "node:test";
import { hasConnectCompanyOwnerAccess } from "./connect-company-owner.ts";

function database(links, profiles, errorTable) {
  const calls = [];
  return {
    calls,
    from(table) {
      const filters = [];
      const query = {
        select() { return query; },
        eq(key, value) { filters.push(row => row[key] === value); calls.push([table,key,value]); return query; },
        in(key, values) { filters.push(row => values.includes(row[key])); return query; },
        limit() { return query; },
        then(resolve) { return Promise.resolve({ data: (table === "profiles" ? profiles : links).filter(row => filters.every(filter => filter(row))), error: table === errorTable ? { message:"offline" } : null }).then(resolve); }
      };
      return query;
    }
  };
}
const link = { company_id:"company", person_id:"person", user_id:"owner", status:"active" };
const owner = { id:"owner", company_id:"company", is_active:true, is_master_owner:true };

test("verified active owner is eligible independently of department", async () => {
  assert.equal(await hasConnectCompanyOwnerAccess(database([link], [owner]), "company", "person"), true);
});
test("all linked profiles are checked, not an arbitrary first profile", async () => {
  assert.equal(await hasConnectCompanyOwnerAccess(database([{...link,user_id:"ordinary"},link], [owner]), "company", "person"), true);
});
test("unlinked, inactive, wrong-company and non-owner accounts cannot gain access", async () => {
  for (const [links,profiles] of [[[],[owner]], [[{...link,status:"inactive"}],[owner]], [[link],[{...owner,is_active:false}]], [[link],[{...owner,company_id:"other"}]], [[link],[{...owner,is_master_owner:false}]], [[{...link,company_id:"other"}],[owner]]]) {
    assert.equal(await hasConnectCompanyOwnerAccess(database(links,profiles), "company", "person"), false);
  }
});
test("database failures fail closed", async () => {
  for (const table of ["profiles","hr_user_person_links"]) await assert.rejects(hasConnectCompanyOwnerAccess(database([link],[owner],table),"company","person"), /Unable to verify/);
});
