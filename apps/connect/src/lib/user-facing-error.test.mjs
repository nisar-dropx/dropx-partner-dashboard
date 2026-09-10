import assert from "node:assert/strict";
import test from "node:test";
import { GENERIC_TECHNICAL_ERROR, userFacingError } from "./user-facing-error.ts";

test("keeps clear business guidance", () => {
  assert.equal(userFacingError("Select a regularization reason."), "Select a regularization reason.");
  assert.equal(userFacingError(new Error("Login expired.")), "Login expired.");
});

test("hides database, JSON and stack details", () => {
  assert.equal(userFacingError("Unexpected token '<', <!doctype html> is not valid JSON"), GENERIC_TECHNICAL_ERROR);
  assert.equal(userFacingError("PostgREST schema cache: column status does not exist"), GENERIC_TECHNICAL_ERROR);
  assert.equal(userFacingError('{"code":"PGRST204","details":"bad column"}'), GENERIC_TECHNICAL_ERROR);
});

test("hides raw WebAuthn/DOMException messages", () => {
  const fallback = "Unable to enable biometric login. Please try again.";
  const domError = new DOMException(
    "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.",
    "NotAllowedError"
  );
  assert.equal(userFacingError(domError, fallback), fallback);
});
