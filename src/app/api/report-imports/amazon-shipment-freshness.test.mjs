import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const importRoute = fs.readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const autoRoute = fs.readFileSync(new URL("./auto-run/route.ts", import.meta.url), "utf8");
const importPage = fs.readFileSync(
  new URL("../../../components/report-upload-page-content.tsx", import.meta.url),
  "utf8"
);

test("automated Amazon shipment imports reject a file that does not cover expected D-1", () => {
  assert.match(importRoute, /sourceType === "amazon_shipments" && isServiceImport/);
  assert.match(importRoute, /latestSourceDate < requestedReportDate/);
  assert.match(importRoute, /Amazon shipment file is stale/);
});

test("workforce auto-run sends the expected report date to the worker", () => {
  assert.match(autoRoute, /expectedReportDate: reportDate/);
  assert.match(autoRoute, /if \(ready\.alreadyUploaded\)/);
  assert.match(autoRoute, /if \(!ready\.ready\)/);
});

test("daily import status does not label a stale successful batch as completed", () => {
  assert.match(importPage, /&& !successfulBatch\(candidate\)/);
  assert.doesNotMatch(
    importPage,
    /batchMatchesDate\(candidate, reportDate\) \|\| createdDateInIndia\(candidate\.created_at\) === date/
  );
});
