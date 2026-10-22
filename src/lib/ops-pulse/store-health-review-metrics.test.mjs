import assert from "node:assert/strict";
import test from "node:test";
import {
  STORE_HEALTH_DAILY_SOURCE_LABEL,
  buildStoreHealthReviewMetrics,
  usableStoreHealthInsight
} from "./store-health-scorecard.ts";
import { STORE_HEALTH_DAILY_SOURCE_LABEL as policyLabel } from "./performance-source-policy.ts";

test("Store Health source labels stay aligned as D-2", () => {
  assert.equal(STORE_HEALTH_DAILY_SOURCE_LABEL, "Store Health D-2");
  assert.equal(policyLabel, "Store Health D-2");
});

test("drops PDF scrap insights that are not readable notes", () => {
  assert.equal(usableStoreHealthInsight("{from 635}."), undefined);
  assert.equal(usableStoreHealthInsight("worst day"), undefined);
  assert.equal(
    usableStoreHealthInsight("Stow 21.1% with 18 shorts on the worst day for this store."),
    "Stow 21.1% with 18 shorts on the worst day for this store."
  );
});

test("builds review metrics from imported fact JSON with evidence text for RCA", () => {
  const { metrics, hero } = buildStoreHealthReviewMetrics({
    format_version: 1,
    score_pct: 25,
    band: "Critical",
    points_earned: 20,
    points_available: 79,
    city: "Chennai",
    insights: {
      store: "{from 635}.",
      network: "Network loss 0.86% and reconciliation 99.2% across all stores today."
    },
    metrics: {
      order_drop_to_picker_acceptance: {
        actual_text: "68 s",
        actual_number: 68,
        target_text: "30 s",
        status: "Red",
        weight: 15,
        points: 0,
        scored: true
      },
      stowed_within_sla: {
        actual_text: "No data",
        actual_number: null,
        target_text: "95%",
        status: "Not scored",
        weight: 10,
        points: null,
        scored: false
      }
    }
  });

  assert.equal(hero.scorePct, 25);
  assert.equal(hero.band, "Critical");
  assert.equal(hero.storeInsight, undefined);
  assert.match(hero.networkInsight ?? "", /reconciliation 99\.2%/);
  const drop = metrics.find((metric) => metric.key === "order_drop_to_picker_acceptance");
  assert.ok(drop);
  assert.equal(drop.severity, "red");
  assert.equal(drop.evidence, "68 s");
  assert.equal(drop.actual, 68);
  const stow = metrics.find((metric) => metric.key === "stowed_within_sla");
  assert.ok(stow);
  assert.equal(stow.severity, "neutral");
  assert.equal(stow.evidence, "No data");
});
