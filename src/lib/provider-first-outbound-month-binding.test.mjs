import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { providerFirstMappingForOutboundMonth } from "./provider-first-mapping-view.ts";

const period = (mappingId, effectiveFrom, effectiveTo, status = effectiveTo ? "closed" : "active") => ({
  mappingId,
  effectiveFrom,
  effectiveTo,
  status
});

test("binds a closed same-location mapping that overlapped the selected outbound month", () => {
  const september = period("september", "2026-09-01", "2026-09-30");
  const october = period("october", "2026-10-01", "2026-10-19");

  assert.equal(
    providerFirstMappingForOutboundMonth([october, september], "2026-10")?.mappingId,
    "october"
  );
  assert.equal(
    providerFirstMappingForOutboundMonth([october, september], "2026-09")?.mappingId,
    "september"
  );
});

test("chooses the latest period inside the month and keeps boundary dates inclusive", () => {
  const firstPeriod = period("october-first", "2026-10-01", "2026-10-19");
  const latestPeriod = period("october-latest", "2026-10-20", null);
  const endedBeforeMonth = period("august", "2026-08-01", "2026-09-30");
  const startsAfterMonth = period("november", "2026-11-01", null);

  assert.equal(
    providerFirstMappingForOutboundMonth(
      [firstPeriod, startsAfterMonth, endedBeforeMonth, latestPeriod],
      "2026-10"
    )?.mappingId,
    "october-latest"
  );
  assert.equal(
    providerFirstMappingForOutboundMonth([period("one-day", "2026-10-31", "2026-10-31")], "2026-10")?.mappingId,
    "one-day"
  );
});

test("rejects malformed, cancelled and non-overlapping mapping periods", () => {
  const candidates = [
    period("cancelled", "2026-10-01", null, "cancelled"),
    period("closed-without-end", "2026-10-01", null, "closed"),
    period("active-with-end", "2026-10-01", "2026-10-31", "active"),
    period("backwards", "2026-10-20", "2026-10-01"),
    period("invalid-date", "2026-10-40", "2026-10-41")
  ];

  assert.equal(providerFirstMappingForOutboundMonth(candidates, "2026-10"), undefined);
  assert.equal(providerFirstMappingForOutboundMonth([period("valid", "2026-10-01", null)], "all"), undefined);
  assert.equal(providerFirstMappingForOutboundMonth([period("valid", "2026-10-01", null)], "2026-13"), undefined);
});

test("provider mapping page month-binds rows without widening current ownership", async () => {
  const page = await readFile(new URL("../app/provider-id-mapping/page.tsx", import.meta.url), "utf8");

  assert.match(page, /const activeMappings = mappingHistory\.filter\(hasCurrentOrScheduledPeriod\)/);
  assert.match(page, /for \(const mapping of activeMappings\)[\s\S]*?appendMapValue\(currentMappingsByWorkforce/);
  assert.match(page, /const mappingHistoryByMember = new Map<string, Mapping\[\]>/);
  assert.match(page, /providerFirstMappingForOutboundMonth\(candidates\.map/);
  assert.match(page, /if \(entryFilters\.month\)[\s\S]*?worksheetMappingByMember\.clear\(\)/);
  assert.match(page, /providerFirstLocationMappingEntries\([\s\S]*?worksheetMappingByMember/);
  assert.match(page, /const currentMappings = activeWorkerMappings\.map\(mappingView\)/);
  assert.doesNotMatch(page, /appendMapValue\(currentMappingsByWorkforce[\s\S]{0,200}mappingHistoryByMember/);
});
