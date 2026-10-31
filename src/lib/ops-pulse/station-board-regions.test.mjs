import assert from "node:assert/strict";
import test from "node:test";
import {
  AMAZON_EDSP_STATION_CODES,
  isAmazonEdspBoardStation,
} from "./station-board-regions.ts";

test("Amazon EDSP board stations match Station Reports.xlsm operating codes", () => {
  for (const code of [
    "KTUB",
    "GDRD",
    "JGBA",
    "XAPL",
    "RPRN",
    "KANA",
  ]) {
    assert.equal(isAmazonEdspBoardStation(code), true);
  }
  assert.ok(AMAZON_EDSP_STATION_CODES.size >= 30);
});

test("AWEZ and ERSE are excluded from Cortex Amazon EDSP board stations", () => {
  assert.equal(isAmazonEdspBoardStation("AWEZ"), false);
  assert.equal(isAmazonEdspBoardStation("ERSE"), false);
  assert.equal(isAmazonEdspBoardStation("awez"), false);
  assert.equal(isAmazonEdspBoardStation(""), false);
});
