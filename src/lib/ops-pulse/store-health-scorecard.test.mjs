import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseStoreHealthScorecardPdf } from "./store-health-scorecard.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/fixtures/qc-store-health-scorecard-20Oct2026.pdf");

test("parses 20 Oct 2026 Store Health scorecard stores and scores", async () => {
  const bytes = readFileSync(fixture);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const parsed = await parseStoreHealthScorecardPdf(arrayBuffer);

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
