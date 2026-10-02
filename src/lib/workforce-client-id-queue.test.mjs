import assert from "node:assert/strict";
import test from "node:test";
import { allClientIdRows, clientIdQueues, needsClientId, providerMappingFor } from "./workforce-client-id-queue.ts";

const today = "2026-10-02";
const worker = (overrides = {}) => ({
  id: "worker-1", source_profile_type: "canonical", source_profile_id: "worker-1",
  location_id: "station-1", onboarding_status: "active", lifecycle_status: "onboarding",
  migration_state: "canonical", stations: { provider_id: "amazon" },
  designations: { provider_mapping_required: true }, ...overrides
});
const mapping = (overrides = {}) => ({
  id: "map-1", workforce_id: "worker-1", field_executive_id: null, employee_id: null, contractor_id: null,
  provider_id: "amazon", station_id: "station-1", provider_member_id: "20000123",
  effective_from: "2026-08-01", effective_to: null, status: "active", ...overrides
});
const invite = (overrides = {}) => ({
  id: "invite-1", workforce_id: "worker-1", station_id: "station-1", status: "sent",
  requested_at: "2026-10-01T10:00:00Z", completed_at: null, external_reference: null,
  error_code: null, error_message: null, ...overrides
});

test("Dashboard mapping excludes an associate from every client queue even with a stale invitation", () => {
  for (const status of ["queued", "processing", "sent", "failed"]) {
    const result = clientIdQueues([worker()], [mapping()], [invite({ status })], today);
    assert.deepEqual([result.ready.length, result.progress.length, result.failed.length], [0, 0, 0]);
  }
  assert.equal(clientIdQueues([worker({ onboarding_status: "under_review" })], [mapping()], [], today).ready.length, 0);
});

test("unmapped registration-complete associates are ready, without requiring activation", () => {
  for (const onboarding_status of ["under_review", "approved", "active"]) {
    assert.equal(clientIdQueues([worker({ onboarding_status })], [], [], today).ready.length, 1);
  }
  assert.equal(needsClientId(worker({ onboarding_status: "pending" })), false);
});

test("validity follows the current client, station, nonblank ID and inclusive effective dates", () => {
  assert.ok(providerMappingFor(worker(), [mapping({ effective_from: today, effective_to: today, status: "closed" })], today).current);
  for (const invalid of [
    { effective_from: "2026-10-03" }, { effective_to: "2026-10-01" },
    { provider_member_id: "  " }, { status: "cancelled" },
    { station_id: "other-station" }, { provider_id: "flipkart" }, { workforce_id: "other-worker" }
  ]) assert.equal(providerMappingFor(worker(), [mapping(invalid)], today).current, undefined);
});

test("legacy links are type-specific and cannot override a canonical workforce link", () => {
  for (const type of ["contractor", "employee", "field_executive"]) {
    const legacy = worker({ source_profile_type: type, source_profile_id: "legacy-id" });
    const record = mapping({ workforce_id: null, [`${type}_id`]: "legacy-id" });
    assert.ok(providerMappingFor(legacy, [record], today).current);
    assert.equal(providerMappingFor(legacy, [{ ...record, workforce_id: "someone-else" }], today).current, undefined);
  }
  assert.equal(providerMappingFor(worker({ source_profile_type: "contractor" }), [mapping({ workforce_id: null, employee_id: "worker-1" })], today).current, undefined);
});

test("existing expired, future or moved mappings remain available to direct users to mapping review", () => {
  for (const change of [{ effective_to: "2026-09-30" }, { effective_from: "2026-11-01" }, { station_id: "old-station" }]) {
    const result = providerMappingFor(worker(), [mapping(change)], today);
    assert.equal(result.current, undefined);
    assert.equal(result.known?.provider_member_id, "20000123");
  }
});

test("a current mapping wins even when a future period is first in the result", () => {
  const result = providerMappingFor(worker(), [mapping({ id: "future", effective_from: "2026-11-01" }), mapping()], today);
  assert.equal(result.current.id, "map-1");
});

test("latest invitation wins and each associate has exactly one pending queue", () => {
  const result = clientIdQueues([worker()], [], [invite({ status: "failed" }), invite({ id: "new", requested_at: "2026-10-02T10:00:00Z" }), invite()], today);
  assert.deepEqual([result.ready.length, result.progress.length, result.failed.length], [0, 1, 0]);
  const failed = clientIdQueues([worker()], [], [invite(), invite({ id: "new", status: "failed", requested_at: "2026-10-02T10:00:00Z" })], today);
  assert.deepEqual([failed.ready.length, failed.progress.length, failed.failed.length], [0, 0, 1]);
});

test("designation master and lifecycle remove records that do not need provider IDs", () => {
  assert.equal(needsClientId(worker({ designations: [{ provider_mapping_required: false }] })), false);
  assert.equal(needsClientId(worker({ lifecycle_status: "offboarded" })), false);
  assert.equal(needsClientId(worker({ migration_state: "reclassified" })), false);
  assert.equal(needsClientId(worker({ designations: null })), true);
});

test("classification happens before the old 120-row UI limit and counts match records", () => {
  const workers = Array.from({ length: 175 }, (_, i) => worker({ id: `worker-${i}` }));
  const mappings = workers.slice(0, 137).map((w) => mapping({ workforce_id: w.id }));
  const result = clientIdQueues(workers, mappings, [], today);
  assert.equal(result.ready.length, 38);
  assert.ok(result.ready.some((w) => w.id === "worker-174"));
});

test("all data pages are read and mapping read failures cannot silently mean unmapped", async () => {
  const calls = [];
  const rows = await allClientIdRows(async (from, to) => {
    calls.push([from, to]);
    return { data: Array.from({ length: from === 0 ? 500 : 3 }, (_, i) => ({ id: from + i })), error: null };
  });
  assert.equal(rows.length, 503);
  assert.deepEqual(calls, [[0, 499], [500, 999]]);
  await assert.rejects(allClientIdRows(async () => ({ data: null, error: { message: "mapping lookup failed" } })), /mapping lookup failed/);
});
