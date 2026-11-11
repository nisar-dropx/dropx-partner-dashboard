import test from "node:test";
import assert from "node:assert/strict";
import { orderEodCReturnRows, orderEodDotRows, orderEodDsrRows } from "./lm-eod-order.ts";
import { eodDsrMentionStations, eodDsrPerformanceCaption } from "./lm-eod-caption.ts";

test("EOD DSR is ordered by DSR percentage descending", () => {
  const rows = orderEodDsrRows([
    { Station: "BEST", "DSR %": "99.0%" },
    { Station: "WORST", "DSR %": "70.0%" },
    { Station: "MID", "DSR %": "80.0%" },
  ]);
  assert.deepEqual(rows.map(row => row.Station), ["BEST", "MID", "WORST"]);
});

test("EOD DOT is ordered by DOT percentage descending", () => {
  const rows = orderEodDotRows([
    { Station: "LOW", "Overall DOT %": "45.0%" },
    { Station: "HIGH", "Overall DOT %": "90.0%" },
  ]);
  assert.deepEqual(rows.map(row => row.Station), ["HIGH", "LOW"]);
});

test("EOD C-return is ordered by pickup percentage descending", () => {
  const rows = orderEodCReturnRows([
    { Station: "CLEAR", "Pickup %": "100.0%" },
    { Station: "PENDING", "Pickup %": "40.0%" },
  ]);
  assert.deepEqual(rows.map(row => row.Station), ["CLEAR", "PENDING"]);
});

test("missing percentages sort last", () => {
  const rows = orderEodDsrRows([
    { Station: "NO DATA", "DSR %": "—" },
    { Station: "ACTIVE", "DSR %": "0.0%" },
  ]);
  assert.deepEqual(rows.map(row => row.Station), ["ACTIVE", "NO DATA"]);
});

test("EOD DSR caption follows the configured performance bands", () => {
  const rows = [
    { Station: "OUT", "DSR %": "96.0%" },
    { Station: "GREAT", "DSR %": "94.0%" },
    { Station: "WATCH", "DSR %": "90.0%" },
    { Station: "FOCUS", "DSR %": "85.0%" },
    { Station: "URGENT", "DSR %": "82.0%" },
  ];
  assert.deepEqual(eodDsrMentionStations(rows), {
    recognition: ["OUT", "GREAT"],
    focus: ["FOCUS", "URGENT"],
  });
  const caption = eodDsrPerformanceCaption("EOD DSR Report · 8 Nov 2026 · KL Region", rows, ["919111111111"], ["919222222222"]);
  assert.match(caption, /Outstanding \(>95%\).*OUT 96\.0%/);
  assert.match(caption, /Great \(>93–95%\).*GREAT 94\.0%/);
  assert.match(caption, /Good \/ watch \(88–93%\).*WATCH 90\.0%/);
  assert.match(caption, /Needs focus \(83–<88%\).*FOCUS 85\.0%/);
  assert.match(caption, /Immediate focus \(<83%\).*URGENT 82\.0%/);
  assert.match(caption, /Great performance — Team Leaders.*@919111111111/);
  assert.match(caption, /Needs focus — TL & Cluster\/AOM.*@919222222222/);
});
