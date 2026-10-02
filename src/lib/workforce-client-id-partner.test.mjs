import assert from "node:assert/strict";
import test from "node:test";
import { clientIdPartnerState } from "./workforce-client-id-partner-state.ts";
import { clientIdQueues } from "./workforce-client-id-queue.ts";

const link = { workforce_id: "worker", amazon_provider_id: "profile", transporter_id: "transporter", last_synced_at: "2026-09-30T12:00:00Z" };
const roster = { provider_id: "profile", transporter_id: "transporter", operational_status: "ACTIVE", synced_at: "2026-10-02T14:31:35Z" };
const worker = { id: "worker", source_profile_type: "canonical", source_profile_id: "worker", location_id: "station", onboarding_status: "active", lifecycle_status: "onboarding", migration_state: "canonical", stations: { provider_id: "amazon" }, designations: { provider_mapping_required: true } };
const oldLearning = { stage: "learning", can_trigger: false, label: "Learning pending", instruction: "Complete course", report_updated_at: "2026-09-05T12:00:00Z", transporter_id: "transporter" };

test("Jijy case: newer active LSC roster supersedes stale learning report and routes only to mapping", () => {
  const state = clientIdPartnerState(link, roster, undefined, oldLearning);
  assert.equal(state.queue, "mapping");
  assert.equal(state.label, "ID active · mapping pending");
  assert.equal(state.source, "LSC roster");
  const queues = clientIdQueues([worker], [], [], "2026-10-02", new Map([[worker.id, state]]));
  assert.deepEqual([queues.ready.length, queues.progress.length, queues.mappingPending.length, queues.failed.length], [0, 0, 1, 0]);
});

test("an LSC onboarding record stays in progress even after an already-account error", () => {
  const state = clientIdPartnerState(link, { ...roster, operational_status: "ONBOARDING" });
  const queues = clientIdQueues([worker], [], [{ id: "invite", workforce_id: "worker", status: "failed", requested_at: "2026-10-02", error_code: "EMAIL_ALREADY_HAS_AN_ACCOUNT" }], "2026-10-02", new Map([[worker.id, state]]));
  assert.deepEqual([queues.ready.length, queues.progress.length, queues.failed.length], [0, 1, 0]);
});

test("inactive and unknown existing IDs require review, never a replacement invitation", () => {
  for (const status of ["INACTIVE", "SUSPENDED", null]) assert.equal(clientIdPartnerState(link, { ...roster, operational_status: status }).queue, "attention");
  assert.equal(clientIdPartnerState(link).queue, "attention");
});

test("identity requires exact provider and transporter IDs; profile link alone cannot prove activation", () => {
  assert.equal(clientIdPartnerState(link, { ...roster, provider_id: "another-profile" }).queue, "attention");
  assert.equal(clientIdPartnerState(link, { ...roster, transporter_id: "another-transporter" }).queue, "attention");
  assert.equal(clientIdPartnerState(undefined, roster), undefined);
});

test("newer partner evidence takes precedence, with no substring inference of ACTIVE from INACTIVE", () => {
  const observation = { workforce_id: "worker", provider_profile_id: "profile", progress: "Background check", provider_status: "Insufficiency", observed_at: "2026-10-03T14:00:00Z" };
  assert.equal(clientIdPartnerState(link, roster, observation).queue, "attention");
  assert.equal(clientIdPartnerState(link, roster, { ...observation, provider_profile_id: "other" }).queue, "mapping");
  assert.equal(clientIdPartnerState(link, roster, undefined, { ...oldLearning, report_updated_at: "2026-10-03T14:00:00Z" }).queue, "progress");
});

test("current Dashboard mapping removes all onboarding queues, including stale partner evidence", () => {
  const mapping = { id: "mapping", workforce_id: "worker", provider_id: "amazon", station_id: "station", provider_member_id: "2000123", effective_from: "2026-09-01", effective_to: null, status: "active" };
  const queues = clientIdQueues([worker], [mapping], [], "2026-10-02", new Map([[worker.id, clientIdPartnerState(link, roster)]]));
  assert.deepEqual([queues.ready.length, queues.progress.length, queues.mappingPending.length, queues.failed.length], [0, 0, 0, 0]);
  const expired = clientIdQueues([worker], [{ ...mapping, effective_to: "2026-09-30" }], [], "2026-10-02");
  assert.deepEqual([expired.ready.length, expired.mappingPending.length], [0, 1]);
});

test("only a record with no existing partner evidence remains invitation eligible", () => {
  assert.equal(clientIdPartnerState(undefined, undefined, undefined, { ...oldLearning, stage: "id_creation_pending", can_trigger: true }), undefined);
  assert.equal(clientIdQueues([worker], [], [], "2026-10-02").ready.length, 1);
});
