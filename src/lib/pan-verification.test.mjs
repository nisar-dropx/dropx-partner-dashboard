import assert from "node:assert/strict";
import test from "node:test";

import {
  PAN_FALLBACK_ENDPOINT,
  PAN_PRIMARY_ENDPOINT,
  fallbackPanName,
  isUsableFallbackPanResult,
  primaryPanFallbackReason,
  primaryPanName,
  projectFallbackPanResponse,
  verifyPanWithFallback
} from "./pan-verification.ts";

const PAN_NUMBER = "ABCDE1234F";
const CREDENTIALS = {
  api_id: "api-id",
  api_key: "api-key",
  token_id: "token-id"
};
const AUDIT_CONTEXT = {
  accountId: "account-id",
  baseUrl: "https://javabackend.idspay.in/api/v1/prod",
  companyId: "company-id",
  profileType: "employee",
  providerCode: "idspay",
  source: "test",
  verificationKind: "pan"
};

function response(status = 200) {
  return new Response(null, { status });
}

function primaryBody(overrides = {}) {
  return {
    status: {
      code: 200,
      type: "success",
      message: "Request processed successfully."
    },
    message: "Request processed successfully.",
    data: {
      data: {
        pan_number: PAN_NUMBER,
        full_name: "PRIMARY HOLDER",
        status: "Active",
        ...overrides
      },
      status_code: 200,
      success: true,
      message: null,
      message_code: "success"
    }
  };
}

function fallbackBody(overrides = {}) {
  return {
    status: {
      code: 200,
      type: "success",
      message: "Request processed successfully."
    },
    message: "Request processed successfully.",
    data: {
      pan: PAN_NUMBER,
      pan_type: "Individual",
      fullname: "FALLBACK HOLDER",
      first_name: "FALLBACK",
      middle_name: "",
      last_name: "HOLDER",
      father_name: "PARENT NAME",
      gender: "male",
      aadhaar_number: "XXXXXXXX1234",
      aadhaar_linked: true,
      dob: "01/01/1990",
      address: {
        building_name: "Building",
        locality: "Locality",
        street_name: "Street",
        pincode: "100001",
        city: "City",
        state: "State",
        country: "India"
      },
      mobile: "9999999999",
      email: "holder@example.com",
      ...overrides
    }
  };
}

test("uses the exact IDSPAY primary and fallback endpoints", () => {
  assert.equal(PAN_PRIMARY_ENDPOINT, "/pan/verification");
  assert.equal(PAN_FALLBACK_ENDPOINT, "/srv2/validation/pan/father-details");
});

test("extracts holder names only from each provider's documented location", () => {
  assert.equal(primaryPanName(primaryBody()), "PRIMARY HOLDER");
  assert.equal(fallbackPanName(fallbackBody()), "FALLBACK HOLDER");
  assert.equal(primaryPanName({ data: { fullname: "WRONG LOCATION" } }), "");
  assert.equal(fallbackPanName({ data: { full_name: "WRONG LOCATION" } }), "");
});

test("keeps a usable primary result and does not fallback for a holder-name mismatch", async () => {
  const calls = [];
  const body = primaryBody({ full_name: "A DIFFERENT PERSON" });
  const callProvider = async (input) => {
    calls.push(input);
    return { response: response(), body };
  };

  const result = await verifyPanWithFallback({
    callProvider,
    auditContext: AUDIT_CONTEXT,
    credentials: CREDENTIALS,
    panNumber: PAN_NUMBER
  });

  assert.equal(result.source, "primary");
  assert.equal(result.name, "A DIFFERENT PERSON");
  assert.equal(result.body, body);
  assert.equal(result.fallbackReason, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, PAN_PRIMARY_ENDPOINT);
  assert.deepEqual(calls[0].payload, {
    ...CREDENTIALS,
    pan_number: PAN_NUMBER
  });
});

test("falls back when the primary provider succeeds without a holder name", async () => {
  const calls = [];
  const blankPrimary = primaryBody({ full_name: "   " });
  const fallback = fallbackBody();
  const callProvider = async (input) => {
    calls.push(input);
    return calls.length === 1
      ? { response: response(), body: blankPrimary }
      : { response: response(), body: fallback };
  };

  const expectedReason = primaryPanFallbackReason({
    response: response(),
    body: blankPrimary
  });
  assert.ok(expectedReason);

  const result = await verifyPanWithFallback({
    callProvider,
    auditContext: AUDIT_CONTEXT,
    credentials: CREDENTIALS,
    panNumber: PAN_NUMBER
  });

  assert.equal(result.source, "fallback");
  assert.equal(result.name, "FALLBACK HOLDER");
  assert.equal(result.fallbackReason, expectedReason);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].endpoint, PAN_FALLBACK_ENDPOINT);
  assert.deepEqual(calls[1].payload, {
    ...CREDENTIALS,
    pan: PAN_NUMBER
  });
  assert.equal("pan_number" in calls[1].payload, false);
});

test("recognizes HTTP and provider-envelope failures as fallback cases", () => {
  assert.equal(primaryPanFallbackReason({
    response: response(503),
    body: primaryBody()
  }), "http_error");

  assert.equal(primaryPanFallbackReason({
    response: response(),
    body: {
      status: { code: 500, type: "error", message: "Provider unavailable" },
      data: { success: false }
    }
  }), "api_failure");

  assert.equal(primaryPanFallbackReason({
    response: response(),
    body: {
      status: { code: 200, type: "success" },
      data: { success: false, data: { full_name: "NONBLANK BUT FAILED" } }
    }
  }), "api_failure");

  assert.equal(primaryPanFallbackReason({
    response: response(),
    body: primaryBody()
  }), null);
});

test("supplies audit classification that agrees with fallback selection", async () => {
  const calls = [];
  const primaryFailure = {
    status: { code: 200, type: "success" },
    data: {
      success: false,
      status_code: 422,
      data: { full_name: "NONBLANK BUT FAILED" }
    }
  };
  const fallback = fallbackBody();
  const callProvider = async (input) => {
    calls.push(input);
    return calls.length === 1
      ? { response: response(), body: primaryFailure }
      : { response: response(), body: fallback };
  };

  const result = await verifyPanWithFallback({
    callProvider,
    auditContext: AUDIT_CONTEXT,
    credentials: CREDENTIALS,
    panNumber: PAN_NUMBER
  });

  assert.equal(result.source, "fallback");
  assert.equal(calls[0].isSuccessfulResponse(response(), primaryFailure), false);
  assert.equal(calls[1].isSuccessfulResponse(response(), fallback), true);
});

test("falls back after an HTTP-level primary failure", async () => {
  const calls = [];
  const callProvider = async (input) => {
    calls.push(input);
    return calls.length === 1
      ? {
          response: response(502),
          body: { status: { code: 502, type: "error" }, message: "Bad gateway" }
        }
      : { response: response(), body: fallbackBody() };
  };

  const result = await verifyPanWithFallback({
    callProvider,
    auditContext: AUDIT_CONTEXT,
    credentials: CREDENTIALS,
    panNumber: PAN_NUMBER
  });

  assert.equal(result.source, "fallback");
  assert.ok(result.fallbackReason);
  assert.equal(calls.length, 2);
});

test("falls back when the primary request rejects", async () => {
  const calls = [];
  const callProvider = async (input) => {
    calls.push(input);
    if (calls.length === 1) {
      const error = new Error("network unavailable");
      error.name = "VerificationProviderTransportError";
      throw error;
    }
    return { response: response(), body: fallbackBody() };
  };

  const result = await verifyPanWithFallback({
    callProvider,
    auditContext: AUDIT_CONTEXT,
    credentials: CREDENTIALS,
    panNumber: PAN_NUMBER
  });

  assert.equal(result.source, "fallback");
  assert.equal(result.name, "FALLBACK HOLDER");
  assert.ok(result.fallbackReason);
  assert.equal(calls.length, 2);
});

test("does not accept a fallback result returned for a different PAN", async () => {
  const mismatched = fallbackBody({ pan: "ZZZZZ9999Z" });
  assert.equal(isUsableFallbackPanResult({
    response: response(),
    body: mismatched,
    panNumber: PAN_NUMBER
  }), false);

  let callNumber = 0;
  const result = await verifyPanWithFallback({
    callProvider: async () => {
      callNumber += 1;
      return callNumber === 1
        ? { response: response(), body: primaryBody({ full_name: "" }) }
        : { response: response(), body: mismatched };
    },
    auditContext: AUDIT_CONTEXT,
    credentials: CREDENTIALS,
    panNumber: PAN_NUMBER
  });

  assert.equal(result.source, "fallback");
  assert.equal(result.name, "");
});

test("projects the fallback response without unnecessary identity and contact data", () => {
  const projected = projectFallbackPanResponse(fallbackBody());
  const serialized = JSON.stringify(projected);

  assert.equal(fallbackPanName(projected), "FALLBACK HOLDER");
  assert.equal(projected.data.pan, PAN_NUMBER);
  assert.doesNotMatch(serialized, /"dob"/i);
  assert.doesNotMatch(serialized, /"aadhaar_number"/i);
  assert.doesNotMatch(serialized, /"aadhaar_linked"/i);
  assert.doesNotMatch(serialized, /"address"/i);
  assert.doesNotMatch(serialized, /"mobile"/i);
  assert.doesNotMatch(serialized, /"email"/i);
  assert.doesNotMatch(serialized, /holder@example\.com/i);
  assert.doesNotMatch(serialized, /9999999999/);
});
