import test from "node:test";
import assert from "node:assert/strict";
import {workforcePaymentMonth} from "./workforce-payment-period.ts";
test("December rolls into January without an invalid month 13",()=>assert.deepEqual(workforcePaymentMonth(new Date("2026-12-10T00:00:00Z")),{from:"2026-12-01",to:"2027-01-01",label:"December 2026"}));
test("pay month switches at midnight India time, not server time",()=>assert.equal(workforcePaymentMonth(new Date("2026-09-30T19:00:00Z")).from,"2026-10-01"));
