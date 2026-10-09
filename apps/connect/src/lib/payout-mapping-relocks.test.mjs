import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as mapping from "./payout-mapping-relocks.ts";
import * as paymentStatus from "./workforce-payment-status.ts";
import * as dispute from "./payout-dispute.ts";
import * as breakdown from "./published-payout-breakdown.ts";
import {
  loadPayoutMappingRevisionState,
  payoutMappingPeriodKey,
  payoutMappingPublicationState,
  payoutMappingRevisionState,
} from "./payout-mapping-relocks.ts";

const worker = "0d87be1e-b759-4e39-9e7f-b7dfbd2c1741";
const stationA = "fb63b3b3-5a9a-4482-97a0-e48b42ffba94";
const stationB = "8bf79e1e-3e9b-4867-9a93-cb326cd8dd9f";
const relock = "0b5ed6eb-fbf1-4707-8300-a07569fe87e2";

test("mapping revision state uses the exact-period RPC projection", () => {
  const state = payoutMappingRevisionState([
    {
      period_start: "2026-09-01",
      period_end: "2026-09-30",
      revision_pending: true,
      active_station_ids: [stationB, stationB],
      mapping_relock_id: relock,
    },
    {
      period_start: "2026-08-01",
      period_end: "2026-08-31",
      revision_pending: false,
      active_station_ids: null,
    },
  ]);

  assert.equal(payoutMappingPeriodKey("2026-09-01", "2026-09-30"), "2026-09-01|2026-09-30");
  assert.deepEqual([...state.openPeriodKeys], ["2026-09-01|2026-09-30"]);
  assert.deepEqual([...state.activeStationIdsByPeriod.get("2026-09-01|2026-09-30")], [stationB]);
  assert.equal(state.mappingRelockIdsByPeriod.get("2026-09-01|2026-09-30"), relock);
  assert.deepEqual(payoutMappingPublicationState(state, "2026-09-01", "2026-09-30", stationA, relock), {
    revisionPending: true,
    visible: false,
  });
  assert.deepEqual(payoutMappingPublicationState(state, "2026-09-01", "2026-09-30", stationB, relock), {
    revisionPending: true,
    visible: true,
  });
  assert.deepEqual(payoutMappingPublicationState(state, "2026-08-01", "2026-08-31", stationA, null), {
    revisionPending: false,
    visible: true,
  });
});

test("affected workers with no active location fail closed after relock", () => {
  const state = payoutMappingRevisionState([{
    period_start: "2026-09-01",
    period_end: "2026-09-30",
    revision_pending: false,
    active_station_ids: [],
    mapping_relock_id: relock,
  }]);

  assert.equal(payoutMappingPublicationState(state, "2026-09-01", "2026-09-30", stationA, relock).visible, false);
});

test("invalid periods never acquire revision or station restrictions", () => {
  const state = payoutMappingRevisionState([]);
  assert.equal(payoutMappingPeriodKey("2026-09-01", ""), "");
  assert.deepEqual(payoutMappingPublicationState(state, "2026-09-01", "", stationA, null), {
    revisionPending: false,
    visible: true,
  });
});

test("an existing new owner receives the source unlock's pending state from the RPC", async () => {
  const calls = [];
  const db = {
    rpc: async (name, args, options) => {
      calls.push({ name, args, options });
      return {
        error: null,
        data: [{
          period_start: "2026-09-01",
          period_end: "2026-09-30",
          revision_pending: true,
          active_station_ids: [stationB],
          mapping_relock_id: relock,
        }],
      };
    },
  };

  const state = await loadPayoutMappingRevisionState(db, "company-a", worker);
  assert.deepEqual(calls, [{
    name: "workforce_payout_mapping_revision_state",
    args: { p_company_id: "company-a", p_workforce_id: worker },
    options: { get: true },
  }]);
  assert.deepEqual(payoutMappingPublicationState(state, "2026-09-01", "2026-09-30", stationB, relock), {
    revisionPending: true,
    visible: true,
  });
  assert.equal(payoutMappingPublicationState(state, "2026-09-01", "2026-09-30", stationA, relock).visible, false);
});

test("a same-station publication read before relock commit is hidden by lineage", () => {
  const state = payoutMappingRevisionState([{
    period_start: "2026-09-01",
    period_end: "2026-09-30",
    revision_pending: false,
    active_station_ids: [stationA],
    mapping_relock_id: relock,
  }]);

  assert.equal(
    payoutMappingPublicationState(state, "2026-09-01", "2026-09-30", stationA, null).visible,
    false,
    "the pre-relock publication must not survive a same-station relock race",
  );
  assert.equal(
    payoutMappingPublicationState(state, "2026-09-01", "2026-09-30", stationA, relock).visible,
    true,
    "the relock publication and later refreshes inheriting its lineage remain visible",
  );
  assert.equal(
    payoutMappingPublicationState(
      state,
      "2026-09-01",
      "2026-09-30",
      stationA,
      "33e355b8-c2f0-4707-921c-ec40612a8e18",
    ).visible,
    false,
  );
});

test("DropX One loader and dispute endpoint enforce the same mapping revision state", () => {
  const helper = readFileSync(new URL("./payout-mapping-relocks.ts", import.meta.url), "utf8");
  const loader = readFileSync(new URL("./associate-payouts.ts", import.meta.url), "utf8");
  const disputeRoute = readFileSync(new URL("../../app/api/connect/payout-review/route.ts", import.meta.url), "utf8");

  assert.match(helper, /rpc\("workforce_payout_mapping_revision_state", \{[\s\S]+p_company_id: companyId,[\s\S]+p_workforce_id: workforceId/);
  assert.doesNotMatch(helper, /from\("workforce_payout_mapping_unlocks"\)|from\("workforce_payout_mapping_relocks"\)/);
  assert.match(loader, /if \(!mappingRevision\.visible\) continue;/);
  assert.match(loader, /revisionPending: mappingRevision\.revisionPending/);
  assert.match(loader, /publication\.mapping_relock_id/);
  assert.match(loader, /publication\?\.mapping_relock_id/);
  assert.match(disputeRoute, /revision,mapping_relock_id/);
  assert.match(disputeRoute, /publication\.data\.mapping_relock_id/);
  assert.match(disputeRoute, /if\(mappingRevision\.revisionPending\)throw new Error/);
  assert.match(disputeRoute, /if\(!mappingRevision\.visible\)throw new Error/);
  assert.ok(disputeRoute.indexOf("mappingRevision.revisionPending") < disputeRoute.indexOf("workforce_raise_payout_dispute"));
});

function payoutLoaderFixture({ publications = [], items = [], runs = [], revisionRows = [], rpcError = null, publicationError = null } = {}) {
  const tables = {
    workforce_payout_publications: publications,
    workforce_payroll_items: items,
    workforce_payroll_runs: runs,
    workforce_payout_disputes: [],
    workforce_payroll_lines: [],
    payment_requests: [],
  };
  const calls = [];
  const db = {
    rpc: async (name, args, options) => {
      assert.equal(name, "workforce_payout_mapping_revision_state");
      assert.deepEqual(args, { p_company_id: "company-a", p_workforce_id: worker });
      assert.deepEqual(options, { get: true });
      return { data: revisionRows, error: rpcError };
    },
    from(table) {
      assert.ok(table in tables, `Unexpected table: ${table}`);
      const filters = [];
      calls.push({ table, filters });
      let values = [...tables[table]];
      let single = false;
      const query = {
        select() { return query; },
        eq(key, value) { filters.push([key, value]); values = values.filter(row => row[key] === value); return query; },
        in(key, options) { values = values.filter(row => options.includes(row[key])); return query; },
        order() { return query; },
        range(from, to) { values = values.slice(from, to + 1); return query; },
        maybeSingle() { single = true; return query; },
        then(resolve, reject) {
          return Promise.resolve({ data: single ? values[0] ?? null : values, error: table === "workforce_payout_publications" ? publicationError : null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  const mocks = {
    "@/lib/supabase-admin": { supabaseAdmin: db },
    "@/lib/connect-auth": {},
    "./workforce-payment-status": paymentStatus,
    "./payout-dispute": dispute,
    "./published-payout-breakdown": breakdown,
    "./payout-mapping-relocks": mapping,
  };
  const mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL("./associate-payouts.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", code)(name => {
    assert.ok(name in mocks, `Unmocked import ${name}`);
    return mocks[name];
  }, mod, mod.exports);
  return { load: () => mod.exports.loadAssociatePayouts("company-a", worker), calls };
}

const publishedItem = {
  id: "item-sep", company_id: "company-a", workforce_id: worker,
  worker_name: "Test associate", dropx_id: "TEST-1", station_id: stationA,
  station_code: "TEST", work_days: 26, net_amount: 12345.67, gross_amount: 12345.67,
  base_amount: 12345.67, incentive_amount: 0, adjustment_amount: 0, deduction_amount: 0,
};
const septemberPublication = {
  id: "published-sep", company_id: "company-a", workforce_id: worker,
  publication_kind: "worksheet", station_id: stationA,
  period_start: "2026-09-01", period_end: "2026-09-30", revision: 1,
  published_at: "2026-10-08T10:00:00Z", review_until: "2026-10-11T10:00:00Z",
  mapping_relock_id: null, snapshot: { schema_version: 2, item: publishedItem, lines: [] },
};

test("published September is visible but unpublished October and another worker's publication are not", async () => {
  const fixture = payoutLoaderFixture({
    publications: [septemberPublication, { ...septemberPublication, id: "someone-else", workforce_id: "different-worker" }],
    items: [{ ...publishedItem, payroll_run_id: "october-draft", net_amount: 99999 }],
    runs: [{ id: "october-draft", company_id: "company-a", status: "draft", period_start: "2026-10-01", period_end: "2026-10-31" }],
  });
  const payouts = await fixture.load();
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].publicationId, "published-sep");
  assert.equal(payouts[0].net, 12345.67);
  assert.equal(payouts[0].paymentDate, null, "published net payable is not a bank payment");
  assert.equal(payouts.filter(row => dispute.payoutMonthForPeriod(row.from, row.to) === "2026-10").length, 0);
  for (const call of fixture.calls) assert.ok(call.filters.some(([key, value]) => key === "company_id" && value === "company-a"));
});

test("no publication returns a valid empty list without consulting revisions or exposing approved runs", async () => {
  const fixture = payoutLoaderFixture({
    items: [{ ...publishedItem, payroll_run_id: "approved-run" }],
    runs: [{ id: "approved-run", company_id: "company-a", status: "approved" }],
    rpcError: { message: "Must not be called before any publication exists" },
  });
  assert.deepEqual(await fixture.load(), []);
  assert.deepEqual(fixture.calls.map(call => call.table), ["workforce_payout_publications"]);
});

test("published paid runs retain their reconciled payment information", async () => {
  const run = { id: "paid-run", company_id: "company-a", status: "paid", period_start: "2026-09-01", period_end: "2026-09-30", payment_date: "2026-10-08", payment_reference: "TEST-REFERENCE" };
  const item = { ...publishedItem, status: "paid", payroll_run_id: run.id };
  const publication = { ...septemberPublication, publication_kind: "payroll", payroll_run_id: run.id, snapshot: { item, lines: [] } };
  const payouts = await payoutLoaderFixture({ publications: [publication], items: [item], runs: [run] }).load();
  assert.equal(payouts.length, 1);
  assert.equal(payouts[0].status, "Paid");
  assert.equal(payouts[0].paymentReference, "TEST-REFERENCE");
  assert.equal(payouts[0].payoutSlipAvailable, true);
});

test("revision lookup failure stays an error and never masquerades as unpublished or exposes stale amounts", async () => {
  await assert.rejects(payoutLoaderFixture({ publications: [septemberPublication], rpcError: { message: "Unavailable" } }).load(), /mapping revision details could not be loaded/);
  await assert.rejects(payoutLoaderFixture({ publicationError: { message: "Unavailable" } }).load(), /Payout details could not be loaded/);
});

test("a superseded publication remains hidden after relock", async () => {
  const payouts = await payoutLoaderFixture({
    publications: [septemberPublication],
    revisionRows: [{ period_start: "2026-09-01", period_end: "2026-09-30", revision_pending: false, mapping_relock_id: relock, active_station_ids: [stationA] }],
  }).load();
  assert.deepEqual(payouts, []);
});
