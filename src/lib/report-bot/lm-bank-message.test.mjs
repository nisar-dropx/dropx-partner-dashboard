import test from "node:test";
import assert from "node:assert/strict";
import {bankMentionNumbers,bankReminderText} from "./lm-bank-message.ts";

test("TL is addressed first, CT and station manager are FYI only",()=>{
  const text=bankReminderText("TEST · Bank remittance",[["CMS usually reports","10:30–11:00 IST"],["Due remittances","1 · ₹500"],["Action","Call the CMS person."]],{tl:["910000000001"],ct:["910000000002"],cluster:["910000000003"],aom:[]});
  assert.ok(text.startsWith("@910000000001, your CMS person"));
  assert.ok(text.endsWith("FYI: CT @910000000002 · Cluster Manager @910000000003"));
  assert.equal((text.match(/@910000000002/g)||[]).length,1);
  assert.doesNotMatch(text,/seven|previous|undefined/);
});

test("CC uses the resolved manager email and never turns it into a WhatsApp tag",()=>{
  const groups={tl:["910000000001"],ct:["910000000002"],cluster:[],aom:["910000000004"],managerEmails:["aom@example.test"]};
  const rows=[["CMS usually reports","10:30–11:00 IST"],["Due remittances","1 · ₹500"],["Action","Email cod-recon@amazon.com."]];
  const text=bankReminderText("TEST",rows,groups);
  assert.match(text,/CC: aom@example\.test, ct@dropxlogistics\.com, varun@dropxlogistics\.com/);
  assert.doesNotMatch(text,/your Cluster Manager|Manager email is not available/);
  assert.match(text,/FYI: CT @910000000002 · AOM @910000000004/);
  assert.deepEqual(bankMentionNumbers(groups),["910000000001","910000000002","910000000004"]);
  assert.doesNotMatch(bankReminderText("TEST",[...rows,["Submitted today","10:45 AM"]],groups),/CC:/);
});
