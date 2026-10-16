import assert from "node:assert/strict";
import test from "node:test";
import { GENERIC_TECHNICAL_ERROR, readJsonResponse, userFacingError } from "./user-facing-error.ts";

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

test("JSON response reader preserves business errors and hides non-JSON server failures", async () => {
  await assert.rejects(
    readJsonResponse(
      Response.json({ error: "ESI number is required when ESI is selected." }, { status: 400 }),
      "Unable to save profile changes."
    ),
    { message: "ESI number is required when ESI is selected." }
  );

  await assert.rejects(
    readJsonResponse(
      new Response("<!doctype html><title>Internal Server Error</title>", {
        status: 500,
        headers: { "content-type": "text/html" }
      }),
      "Unable to save profile changes."
    ),
    { message: "Unable to save profile changes." }
  );
});
