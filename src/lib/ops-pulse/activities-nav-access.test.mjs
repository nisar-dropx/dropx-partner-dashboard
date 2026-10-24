import assert from "node:assert/strict";
import test from "node:test";
import {
  activitiesNavFlags,
  filterActivitiesNavChildren,
} from "./activities-nav-access-logic.ts";

test("Shift Incharge with store_ops page access still only sees Shift operations", () => {
  const flags = activitiesNavFlags({
    hasSi: true,
    hasStore: true,
    siManager: false,
    explicitStoreFiller: false,
    explicitStoreManager: false,
    storeRolesConfigured: true,
  });
  assert.deepEqual(flags, {
    showShiftOps: true,
    showStoreOps: false,
    showShiftReport: false,
    showStoreReport: false,
  });
});

test("Store filler sees Store operations but not report", () => {
  const flags = activitiesNavFlags({
    hasSi: false,
    hasStore: true,
    siManager: false,
    explicitStoreFiller: true,
    explicitStoreManager: false,
    storeRolesConfigured: true,
  });
  assert.equal(flags.showStoreOps, true);
  assert.equal(flags.showStoreReport, false);
});

test("Store manager sees Store ops and Store report", () => {
  const flags = activitiesNavFlags({
    hasSi: true,
    hasStore: true,
    siManager: true,
    explicitStoreFiller: true,
    explicitStoreManager: true,
    storeRolesConfigured: true,
  });
  assert.deepEqual(flags, {
    showShiftOps: true,
    showStoreOps: true,
    showShiftReport: true,
    showStoreReport: true,
  });
});

test("filters Activities children by href for SI worker", () => {
  const children = [
    { code: "si_handover", label: "Shift operations", href: "/si-handover?view=start" },
    { code: "store_ops", label: "Store operations", href: "/store-ops?view=start" },
    { code: "si_handover", label: "Shift report", href: "/si-handover/report?tab=shift" },
    { code: "store_ops", label: "Store report", href: "/si-handover/report?tab=store" },
  ];
  const visible = filterActivitiesNavChildren(children, {
    showShiftOps: true,
    showStoreOps: false,
    showShiftReport: false,
    showStoreReport: false,
  });
  assert.deepEqual(
    visible.map((c) => c.label),
    ["Shift operations"],
  );
});
