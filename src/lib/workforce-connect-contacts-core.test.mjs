import test from "node:test";
import assert from "node:assert/strict";
import {
  workforceContactEmail,
  workforceContactPhone,
  workforceContactValues,
} from "./workforce-connect-contacts-core.ts";

test("formats Indian contact numbers consistently", () => {
  assert.equal(workforceContactPhone({ mobile: "9876543210" }), "+91 98765 43210");
  assert.equal(workforceContactPhone({ mobile_country_code: "+91", mobile: "+91 98765 43210" }), "+91 98765 43210");
  assert.equal(workforceContactPhone({ mobile_country_code: "971", mobile: "501234567" }), "+971 501234567");
});

test("keeps only usable email addresses", () => {
  assert.equal(workforceContactEmail({ email: " Person@DropXLogistics.com " }), "person@dropxlogistics.com");
  assert.equal(workforceContactEmail({ email: "not-an-email" }), null);
  assert.equal(workforceContactEmail(null), null);
});

test("prefers current profile contacts and falls back to source records", () => {
  assert.deepEqual(workforceContactValues(
    "Team Lead",
    "TL",
    { mobile: "9999999999", email: "lead@dropxlogistics.com" },
    { mobile: "8888888888", email: "old@dropxlogistics.com" },
  ), {
    name: "Team Lead",
    role: "TL",
    phone: "+91 99999 99999",
    email: "lead@dropxlogistics.com",
  });
  assert.deepEqual(workforceContactValues(
    "Associate",
    null,
    {},
    { mobile: "7777777777", email: "associate@dropxlogistics.com" },
  ), {
    name: "Associate",
    role: null,
    phone: "+91 77777 77777",
    email: "associate@dropxlogistics.com",
  });
});
