import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { renderAlertCardPng, renderAlertCardSvg } from "./card.mjs";

const sample = {
  title: "Door Open L3 Alert",
  generatedAt: "2026-11-25T09:43:00.000Z",
  station: "TTA5",
  siteName: "TTA5",
  asset: "TTA5 Freezer room w/DS",
  roomType: "Freezer Room",
  alertText: "Door open for more than 30 Minutes",
  level: "L3"
};

function nonWhitePixelCount(pngBytes) {
  const png = PNG.sync.read(pngBytes);
  let count = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] < 250 || png.data[i + 1] < 250 || png.data[i + 2] < 250) count += 1;
  }
  return count;
}

test("alert SVG uses the detail card layout, not the pixel banner", () => {
  const svg = renderAlertCardSvg(sample);
  assert.match(svg, /Door Open L3 Alert/);
  assert.match(svg, /font-family="Inter"/);
  assert.match(svg, /Site :/);
  assert.match(svg, /Asset :/);
  assert.match(svg, /Room Type :/);
  assert.match(svg, /Alert :/);
  assert.match(svg, /TTA5 Freezer room w\/DS/);
  assert.doesNotMatch(svg, /DATOMS/);
  assert.doesNotMatch(svg, /#ea580c/);
});

test("alert PNG rasterizes visible text, not only the divider", async () => {
  const png = await renderAlertCardPng(sample);
  assert.ok(Buffer.isBuffer(png));
  assert.ok(png.length > 2000);
  assert.equal(png[0], 0x89);
  assert.equal(png[1], 0x50); // P
  assert.equal(png[2], 0x4e); // N
  assert.equal(png[3], 0x47); // G
  // Divider alone is ~1–2k non-white pixels; full card text is far denser.
  assert.ok(nonWhitePixelCount(png) > 8000, "expected Inter-rendered text pixels");
});
