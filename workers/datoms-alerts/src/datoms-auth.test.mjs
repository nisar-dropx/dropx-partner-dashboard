import test from "node:test";
import assert from "node:assert/strict";
import { datomsAuthInternals } from "./datoms.mjs";

const { isRateLimited, isAuthFailure, pickToken } = datomsAuthInternals;

test("isRateLimited detects 429 and Datoms copy", () => {
  assert.equal(isRateLimited(new Error("Datoms POST …: 429 TOO_MANY_REQUESTS")), true);
  assert.equal(isRateLimited(new Error("too many requests")), true);
  assert.equal(isRateLimited(new Error("401 unauthorized")), false);
});

test("isAuthFailure ignores rate limits", () => {
  assert.equal(isAuthFailure(new Error("Datoms GET …: 401 unauthorized")), true);
  assert.equal(isAuthFailure(new Error("429 too many requests")), false);
});

test("pickToken reads nested auth_token", () => {
  assert.equal(pickToken({ data: { auth_token: "abc" } }), "abc");
  assert.equal(pickToken({ session_id: "sid" }), "sid");
});
