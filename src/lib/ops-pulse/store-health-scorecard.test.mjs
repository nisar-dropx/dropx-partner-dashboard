import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  findStoreHealthMetricValue,
  parseStoreHealthScorecardPdf,
  storeHealthMetricDefinitions
} from "./store-health-scorecard.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/fixtures");
const fixture20 = join(fixtures, "qc-store-health-scorecard-20Oct2026.pdf");
const fixture28 = join(fixtures, "qc-store-health-scorecard-28Oct2026.pdf");

function definition(key) {
  const metric = storeHealthMetricDefinitions.find((entry) => entry.key === key);
  assert.ok(metric, `missing metric definition ${key}`);
  return metric;
}

function bufferOf(path) {
  const bytes = readFileSync(path);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test("parses 20 Oct 2026 Store Health scorecard stores and scores", async () => {
  const parsed = await parseStoreHealthScorecardPdf(bufferOf(fixture20));

  assert.equal(parsed.performanceDate, "2026-10-20");
  assert.equal(parsed.stores.length, 5);

  const byCode = Object.fromEntries(parsed.stores.map((store) => [store.stationCode, store]));
  assert.equal(byCode.TCC3.scorePct, 25);
  assert.equal(byCode.TCC3.band, "Critical");
  assert.equal(byCode.TCC3.pointsEarned, 20);
  assert.equal(byCode.TCC3.pointsAvailable, 79);

  assert.equal(byCode.TCD4.scorePct, 51);
  assert.equal(byCode.TCD4.band, "Watch");

  assert.equal(byCode.TTA5.scorePct, 37);
  assert.equal(byCode.TTB3.scorePct, 27);
  assert.equal(byCode.TZC4.scorePct, 81);
  assert.equal(byCode.TZC4.band, "Healthy");

  const drop = byCode.TCC3.metrics.order_drop_to_picker_acceptance;
  assert.ok(drop);
  assert.equal(drop.status, "Red");
  assert.equal(drop.weight, 15);
  assert.equal(drop.points, 0);
  assert.match(drop.actual_text, /68\s*s/i);

  const stow = byCode.TCD4.metrics.stowed_within_sla;
  assert.ok(stow);
  assert.equal(stow.status, "Green");
  assert.equal(stow.points, 10);

  const clear = byCode.TZC4.metrics.clear_audit;
  assert.ok(clear);
  assert.equal(clear.status, "Green");
  assert.match(clear.actual_text, /Pass/i);

  const unscored = byCode.TZC4.metrics.stowed_within_sla;
  assert.ok(unscored);
  assert.equal(unscored.status, "Not scored");
  assert.equal(unscored.scored, false);
});

test("parses 28 Oct 2026 PPI for every store despite network insight wrap starting with PPI", async () => {
  const parsed = await parseStoreHealthScorecardPdf(bufferOf(fixture28));

  assert.equal(parsed.performanceDate, "2026-10-28");
  assert.equal(parsed.stores.length, 5);

  const expected = {
    TCC3: { actual: /26\.5\s*s/i, status: "Red", points: 0 },
    TCD4: { actual: /38\.2\s*s/i, status: "Red", points: 0 },
    TTA5: { actual: /24\.7\s*s/i, status: "Amber", points: 5 },
    TTB3: { actual: /28\.0\s*s/i, status: "Red", points: 0 },
    TZC4: { actual: /22\.6\s*s/i, status: "Amber", points: 5 }
  };

  for (const store of parsed.stores) {
    const want = expected[store.stationCode];
    assert.ok(want, `unexpected store ${store.stationCode}`);
    const ppi = store.metrics.ppi;
    assert.ok(ppi, `${store.stationCode} PPI missing`);
    assert.equal(ppi.status, want.status, `${store.stationCode} PPI status`);
    assert.equal(ppi.weight, 10);
    assert.equal(ppi.points, want.points);
    assert.match(ppi.actual_text, want.actual);
    assert.notEqual(ppi.actual_number, null);
  }

  const tcc3 = parsed.stores.find((store) => store.stationCode === "TCC3");
  assert.ok(tcc3);
  assert.equal(tcc3.scorePct, 19);
  assert.equal(tcc3.band, "Critical");
  const drop = tcc3.metrics.order_drop_to_picker_acceptance;
  assert.ok(drop);
  assert.match(drop.actual_text, /106\s*s/i);
  assert.equal(drop.status, "Red");
});

test("skips wrapped network insight lines that start with short metric labels", () => {
  const ppi = definition("ppi");
  const yms = definition("yms");
  const loss = definition("loss_rate");

  const wrappedPpi = findStoreHealthMetricValue([
    "Partner health 90/100. But drop to picker acceptance 1:00 &",
    "PPI 29.2 s (network), 90 shorts, Slack 34 of 171.",
    "This store",
    "Order drop to picker acceptance 30 s 106 s Red 15 0",
    "PPI 20/30 s 26.5 s Red 10 0",
    "YMS 100% No data Not scored 3 -"
  ], ppi);
  assert.ok(wrappedPpi);
  assert.equal(wrappedPpi.actual_text, "26.5 s");
  assert.equal(wrappedPpi.status, "Red");
  assert.equal(wrappedPpi.points, 0);

  assert.equal(
    findStoreHealthMetricValue(["PPI 29.2 s (network), 90 shorts, Slack 34 of 171."], ppi),
    null
  );

  // Narrative that coincidentally ends with status/weight/points must still be rejected
  // without a known target + plausible actual after the label.
  assert.equal(
    findStoreHealthMetricValue(["PPI worsened to Red 10 0"], ppi),
    null
  );
  assert.equal(
    findStoreHealthMetricValue(["YMS checks lagged Red 3 0 across the network"], yms),
    null
  );

  const realYms = findStoreHealthMetricValue([
    "YMS checks lagged across the network.",
    "YMS 100% 1 of 2 Amber 3 0"
  ], yms);
  assert.ok(realYms);
  assert.equal(realYms.actual_text, "1 of 2");
  assert.equal(realYms.status, "Amber");

  const realLoss = findStoreHealthMetricValue([
    "Loss rate notes from network wrap",
    "Loss rate <1.5% 1.01% Green 5 5"
  ], loss);
  assert.ok(realLoss);
  assert.equal(realLoss.actual_text, "1.01%");
  assert.equal(realLoss.status, "Green");
});

test("keeps Not scored No data rows and Pass/Fail CLEAR rows", () => {
  const stow = definition("stowed_within_sla");
  const clear = definition("clear_audit");
  const slack = definition("slack_response");
  const picker = definition("picker_hc_vs_approved");

  const unscored = findStoreHealthMetricValue([
    "Stowed within SLA 95% No data Not scored 10 -"
  ], stow);
  assert.ok(unscored);
  assert.equal(unscored.status, "Not scored");
  assert.equal(unscored.scored, false);
  assert.equal(unscored.actual_number, null);
  assert.equal(unscored.points, null);

  const failed = findStoreHealthMetricValue([
    "CLEAR audit Pass FAILED (28 Oct: vehicle photo out of focus) Red 3 0"
  ], clear);
  assert.ok(failed);
  assert.equal(failed.status, "Red");
  assert.match(failed.actual_text, /FAILED/i);

  const slackRow = findStoreHealthMetricValue([
    "Slack response 100% 34 of 171 Red 3 0"
  ], slack);
  assert.ok(slackRow);
  assert.equal(slackRow.actual_text, "34 of 171");

  const hc = findStoreHealthMetricValue([
    "Picker HC vs approved 100% 15 / 15 Green 3 3"
  ], picker);
  assert.ok(hc);
  assert.equal(hc.actual_text, "15 / 15");
  assert.equal(hc.points, 3);
});

test("prefers catalog-weight table row when an earlier false candidate somehow parses", () => {
  const ppi = definition("ppi");
  // First line has wrong weight (would only appear via a bad PDF); table row weight 10 wins.
  const value = findStoreHealthMetricValue([
    "PPI 20/30 s 99.0 s Red 99 0",
    "PPI 20/30 s 26.5 s Red 10 0"
  ], ppi);
  assert.ok(value);
  assert.equal(value.actual_text, "26.5 s");
  assert.equal(value.weight, 10);
});
