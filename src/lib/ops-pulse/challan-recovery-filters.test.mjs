import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  challanRecoveryFacetOptions,
  challanRecoveryFacts,
  emptyChallanRecoveryFilters,
  filterChallanRecoveryCases
} from "./challan-recovery-filters.ts";

const caseOf = (partial) => ({
  id: partial.id || "1",
  challanId: "c1",
  challanNumber: partial.challanNumber || "KL1",
  vehicleNo: partial.vehicleNo || "KL01AB1234",
  stationCode: partial.stationCode || "TCC3",
  month: partial.month || "2026-11",
  amount: partial.amount || 500,
  status: partial.status || "open",
  offenseDescription: partial.offenseDescription || "Speeding",
  evidenceUrl: "",
  issuingAuthority: "mvd",
  approvedByName: "Ops",
  approvedAt: "",
  createdAt: "",
  splitMode: "custom",
  allocations: partial.allocations || [],
  allocated: 0
});

describe("challan recovery filters", () => {
  const rows = [
    caseOf({ id: "a", stationCode: "TCC3", status: "open", month: "2026-11", challanNumber: "KL111" }),
    caseOf({ id: "b", stationCode: "TCC3", status: "assigned", month: "2026-10", challanNumber: "KL222" }),
    caseOf({ id: "c", stationCode: "BLR1", status: "open", month: "2026-11", challanNumber: "KA333", vehicleNo: "KA01CD9999" })
  ];

  it("filters with AND across dimensions and OR within one", () => {
    const shown = filterChallanRecoveryCases(
      rows,
      { ...emptyChallanRecoveryFilters(), station: ["TCC3"], status: ["open", "assigned"] },
      ""
    );
    assert.deepEqual(
      shown.map((r) => r.id),
      ["a", "b"]
    );
  });

  it("search runs before facet narrowing", () => {
    const shown = filterChallanRecoveryCases(rows, emptyChallanRecoveryFilters(), "KA01CD");
    assert.deepEqual(
      shown.map((r) => r.id),
      ["c"]
    );
  });

  it("keeps selected zero-match values in facet options", () => {
    const facts = rows.map(challanRecoveryFacts);
    const filters = { ...emptyChallanRecoveryFilters(), station: ["TCC3", "GONE"], status: ["open"] };
    const stations = challanRecoveryFacetOptions(facts, filters, "station");
    assert.ok(stations.includes("GONE"));
    assert.ok(stations.includes("TCC3"));
    // Except station: status=open still applies, so BLR1 remains an available station choice.
    assert.ok(stations.includes("BLR1"));
  });

  it("preserves selected filter when other dimensions change", () => {
    const facts = rows.map(challanRecoveryFacts);
    const filters = { ...emptyChallanRecoveryFilters(), status: ["assigned"], month: ["2026-12"] };
    const months = challanRecoveryFacetOptions(facts, filters, "month");
    assert.ok(months.includes("2026-12"));
  });
});
