import assert from "node:assert/strict";
import test from "node:test";

import {
  isPureElectricFuel,
  normalizeVehicleRegistration,
  trustedVehicleFuelFromAudits
} from "./vehicle-fuel.ts";

test("recognizes only pure-electric fuel descriptions", () => {
  for (const fuel of ["EV", "Pure Ev", "pure_ev", "Electric(Bov)", "BEV", "Battery Electric Vehicle"]) {
    assert.equal(isPureElectricFuel(fuel), true, fuel);
  }
  for (const fuel of ["", "Diesel", "Petrol", "CNG", "Petrol/Hybrid", "Hybrid Electric Vehicle", "PHEV", "HEV", "electricity"]) {
    assert.equal(isPureElectricFuel(fuel), false, fuel);
  }
});

test("normalizes vehicle registration numbers for exact audit matching", () => {
  assert.equal(normalizeVehicleRegistration(" kl-14 af 6404 "), "KL14AF6404");
});

test("reads fuel only from a successful matching provider audit", () => {
  const audits = [{
    is_success: true,
    request_status: "completed",
    request_data: { reg_no: "KL14AF6404" },
    response_data: { status: { type: "success" }, data: { type: "Pure Ev" } }
  }];
  assert.equal(trustedVehicleFuelFromAudits(audits, "kl-14-af-6404"), "Pure Ev");
  assert.equal(trustedVehicleFuelFromAudits(audits, "KL14AF0000"), "");
});

test("accepts the alternate provider fuel field", () => {
  const audits = [{
    is_success: true,
    request_status: "completed",
    request_data: { reg_no: "KL14AF6404" },
    response_data: { success: true, data: { fuel_type: "Electric(Bov)" } }
  }];
  assert.equal(trustedVehicleFuelFromAudits(audits, "KL14AF6404"), "Electric(Bov)");
});

test("a newer failed matching audit cannot fall back to an older success", () => {
  const audits = [
    {
      is_success: false,
      request_status: "completed",
      request_data: { reg_no: "KL14AF6404" },
      response_data: { status: { type: "failed" }, data: { type: "Pure Ev" } }
    },
    {
      is_success: true,
      request_status: "completed",
      request_data: { reg_no: "KL14AF6404" },
      response_data: { status: { type: "success" }, data: { type: "Pure Ev" } }
    }
  ];
  assert.equal(trustedVehicleFuelFromAudits(audits, "KL14AF6404"), "");
});

test("incomplete, malformed, and provider-failed audits fail closed", () => {
  const registration = "KL14AF6404";
  const base = { request_data: { reg_no: registration } };
  assert.equal(trustedVehicleFuelFromAudits([{ ...base, is_success: true, request_status: "processing", response_data: { success: true, data: { type: "Pure Ev" } } }], registration), "");
  assert.equal(trustedVehicleFuelFromAudits([{ ...base, is_success: true, response_data: { success: true, data: { type: "Pure Ev" } } }], registration), "");
  assert.equal(trustedVehicleFuelFromAudits([{ ...base, is_success: false, request_status: "completed", response_data: { status: { type: "success" }, data: { type: "Pure Ev" } } }], registration), "");
  assert.equal(trustedVehicleFuelFromAudits([{ ...base, is_success: true, request_status: "completed", response_data: { status: { type: "failed" }, data: { type: "Pure Ev" } } }], registration), "");
  assert.equal(trustedVehicleFuelFromAudits([{ ...base, is_success: true, request_status: "completed", response_data: null }], registration), "");
});
