import test from "node:test";
import assert from "node:assert/strict";
import {workforcePaymentMonth,workforcePaymentPeriod,workforcePaymentReadPeriod} from "./workforce-payment-period.ts";
test("December rolls into January without an invalid month 13",()=>assert.deepEqual(workforcePaymentMonth(new Date("2026-12-10T00:00:00Z")),{from:"2026-12-01",to:"2027-01-01",label:"December 2026"}));
test("pay month switches at midnight India time, not server time",()=>assert.equal(workforcePaymentMonth(new Date("2026-09-30T19:00:00Z")).from,"2026-10-01"));
test("an explicitly selected month returns its exact calendar window",()=>assert.deepEqual(workforcePaymentPeriod("2026-08"),{from:"2026-08-01",to:"2026-09-01",label:"August 2026"}));
test("invalid explicit months fail instead of silently using the current month",()=>assert.throws(()=>workforcePaymentPeriod("2026-13"),/valid month/));
test("current-month reads include today and exclude tomorrow",()=>assert.deepEqual(workforcePaymentReadPeriod("2026-09","2026-09-28"),{from:"2026-09-01",to:"2026-09-29",label:"September 2026"}));
test("historical reads retain the complete calendar month",()=>assert.deepEqual(workforcePaymentReadPeriod("2026-08","2026-09-28"),{from:"2026-08-01",to:"2026-09-01",label:"August 2026"}));
