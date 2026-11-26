import test from "node:test";
import assert from "node:assert/strict";
import { clientRefForAlert } from "./client-ref.mjs";

const REF_RE = /^[A-Za-z0-9_-]{8,64}$/;

test("client_ref is stable and Report-Bot valid for colon-heavy dedupe keys", async () => {
  const key = "e2:2026-11-25T09:34:00.000Z:Door Open L2 Alert";
  const raw = `datoms_${key}`.slice(0, 120);
  assert.equal(REF_RE.test(raw), false, "raw dedupe key must fail validation");

  const ref = await clientRefForAlert(key);
  assert.match(ref, REF_RE);
  assert.equal(ref.length, 55);
  assert.equal(await clientRefForAlert(key), ref);
});
