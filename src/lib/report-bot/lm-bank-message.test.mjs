import test from "node:test";
import assert from "node:assert/strict";
import {bankReminderText} from "./lm-bank-message.ts";

test("TL is addressed first, CT and station manager are FYI only",()=>{
  const text=bankReminderText("TEST · Bank remittance",[["CMS usually reports","10:30–11:00 IST"],["Due remittances","1 · ₹500"],["Action","Call the CMS person."]],{tl:["910000000001"],ct:["910000000002"],cluster:["910000000003"],aom:[]});
  assert.ok(text.startsWith("@910000000001, your CMS person"));
  assert.ok(text.endsWith("FYI: CT @910000000002 · Cluster Manager @910000000003"));
  assert.equal((text.match(/@910000000002/g)||[]).length,1);
  assert.doesNotMatch(text,/seven|previous|undefined/);
});
