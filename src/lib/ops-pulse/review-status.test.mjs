import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewStatusRows, reviewStatusDateRange, reviewStatusDates } from "./review-status.ts";

const location = {
  id: "station-1",
  station_code: "TEST",
  station_name: "Test Station",
  region: "KL",
  cluster_manager: "Current Cluster",
  aom: "Current AOM",
  reporting_authorities: [{ name: "National", role: "National Head" }]
};

test("review status range is previous-day bounded and limited to 31 days", () => {
  assert.deepEqual(reviewStatusDateRange({ from: "2026-01-01", to: "2026-09-05", latestDate: "2026-09-04" }), { from: "2026-08-05", to: "2026-09-04", days: 31 });
  assert.deepEqual(reviewStatusDates("2026-09-02", "2026-09-04"), ["2026-09-04", "2026-09-03", "2026-09-02"]);
});

test("matrix keeps not-started days and historical saved reviewers", () => {
  const review = { id: "review-1", source_date: "2026-09-04", station_id: "station-1", station_code: "TEST", source_type: "hawkeye", status: "in_review", current_step_order: 2, review_summary: "Watch DSR", started_at: "2026-09-05T04:00:00Z", closed_at: null, updated_at: "2026-09-05T05:00:00Z" };
  const steps = [
    { id: "s1", review_id: "review-1", step_order: 1, reviewer_name: "Historical Cluster", reviewer_role: "Cluster Manager", status: "completed", feedback: null, completed_at: "2026-09-05T04:30:00Z", bypass_reason: null, bypassed_at: null, bypassed_by_name: null, proxy_reviewer_name: null, proxy_reason: null, proxy_started_at: null },
    { id: "s2", review_id: "review-1", step_order: 2, reviewer_name: "Historical AOM", reviewer_role: "Area Operations Manager", status: "pending", feedback: null, completed_at: null, bypass_reason: null, bypassed_at: null, bypassed_by_name: null, proxy_reviewer_name: null, proxy_reason: null, proxy_started_at: null }
  ];
  const rows = buildReviewStatusRows({ dates: ["2026-09-04", "2026-09-03"], locations: [location], reviews: [review], steps, items: [], updates: [], followups: [] });
  assert.equal(rows[0].status, "in_progress");
  assert.equal(rows[0].clusterManager, "Historical Cluster");
  assert.equal(rows[0].aom, "Historical AOM");
  assert.equal(rows[0].currentDependency, "Area Operations Manager · Historical AOM");
  assert.equal(rows[1].status, "not_started");
  assert.equal(rows[1].clusterManager, "Current Cluster");
  assert.equal(rows[1].currentDependency, "Start review");
});

test("Dark Store register columns use City Manager and Regional Manager from the People route", () => {
  const rows = buildReviewStatusRows({
    darkStore: true,
    dates: ["2026-10-21"],
    locations: [location],
    reviews: [],
    steps: [],
    items: [],
    updates: [],
    followups: [],
    routes: {
      "station-1": {
        error: null,
        chain: [
          { reviewerName: "Chitra", reviewerRole: "City Manager", reviewerUserId: "u3", personId: "p3", assignmentId: "a3", designationId: "CTM", routingSource: "people" },
          { reviewerName: "Ramesh", reviewerRole: "Regional Manager", reviewerUserId: "u4", personId: "p4", assignmentId: "a4", designationId: "RM", routingSource: "people" }
        ]
      }
    }
  });
  assert.equal(rows[0].clusterManager, "Chitra");
  assert.equal(rows[0].aom, "Ramesh");
  // DS route stops at RM; NH label may still come from People hierarchy metadata.
  assert.equal(rows[0].nationalHead, "National");
  assert.equal(rows[0].currentDependency, "Start review");
});

test("closed reviews show resolved progress including an evidenced skip", () => {
  const review = { id: "review-2", source_date: "2026-09-04", station_id: "station-1", station_code: "TEST", source_type: "hawkeye", status: "closed", current_step_order: 2, review_summary: null, started_at: "2026-09-05T04:00:00Z", closed_at: "2026-09-05T05:00:00Z", updated_at: "2026-09-05T05:00:00Z" };
  const base = { review_id: "review-2", feedback: null, proxy_reviewer_name: null, proxy_reason: null, proxy_started_at: null };
  const steps = [
    { ...base, id: "s1", step_order: 1, reviewer_name: "Cluster", reviewer_role: "Cluster Manager", status: "completed", completed_at: "2026-09-05T04:30:00Z", bypass_reason: null, bypassed_at: null, bypassed_by_name: null },
    { ...base, id: "s2", step_order: 2, reviewer_name: "AOM", reviewer_role: "Area Operations Manager", status: "skipped", completed_at: null, bypass_reason: "Manager absent", bypassed_at: "2026-09-05T04:45:00Z", bypassed_by_name: "Program Manager" }
  ];
  const [row] = buildReviewStatusRows({ dates: ["2026-09-04"], locations: [location], reviews: [review], steps, items: [], updates: [], followups: [] });
  assert.equal(row.status, "completed");
  assert.equal(row.completedSteps, 1);
  assert.equal(row.skippedSteps, 1);
  assert.equal(row.currentDependency, "Completed");
});

test("DS current store leader is display-only and does not create reviewer steps", () => {
  const leader = { personId: "sm1", name: "Local manager", role: "Senior Store Manager" };
  const input = { dates: ["2026-10-24"], locations: [{...location, station_name: null}], reviews: [], steps: [], items: [], updates: [], followups: [], storeLeaders: {"station-1": [leader]} };
  const [ds] = buildReviewStatusRows({...input, darkStore:true});
  assert.deepEqual(ds.storeLeaders, [leader]);
  assert.equal(ds.stationName,"Store");
  assert.equal(ds.totalSteps,0);
  assert.equal(ds.clusterManager,"");
  assert.deepEqual(buildReviewStatusRows(input)[0].storeLeaders,[]);
});
