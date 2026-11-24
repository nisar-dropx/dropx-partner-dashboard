import assert from "node:assert/strict";
import test from "node:test";

/** Mirrors associate / order mapping helpers used by site-summary-monitor.mjs */
function normalizeAssociateLabel(label) {
  return String(label ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseAssociateBanner(payload) {
  const out = {
    waiting_for_orders: 0,
    on_break: 0,
    offered_associates: 0,
    picking_associates: 0,
    packing_racking: 0,
    other_activities: 0,
    total_associates: 0,
    source: "none"
  };
  const buckets = payload.associateStatusCounts ?? payload;
  const set = (key, value) => {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) out[key] = Math.round(n);
  };
  if (Array.isArray(buckets)) {
    for (const row of buckets) {
      const label = normalizeAssociateLabel(row.label ?? row.name ?? row.status);
      const count = row.count ?? row.value;
      if (label.includes("waiting")) set("waiting_for_orders", count);
      else if (label.includes("break")) set("on_break", count);
      else if (label.includes("offered")) set("offered_associates", count);
      else if (label.includes("picking") && !label.includes("pack")) set("picking_associates", count);
      else if (label.includes("pack") || label.includes("rack")) set("packing_racking", count);
      else if (label.includes("other")) set("other_activities", count);
      else if (label.includes("total")) set("total_associates", count);
    }
  }
  if (Object.values(out).some((v) => typeof v === "number" && v > 0)) out.source = "api";
  return out;
}

function parseAssociateBannerFromHtml(html) {
  const out = {
    waiting_for_orders: 0,
    on_break: 0,
    offered_associates: 0,
    picking_associates: 0,
    packing_racking: 0,
    other_activities: 0,
    total_associates: 0,
    source: "none"
  };
  const patterns = [
    ["waiting_for_orders", /Waiting\s+for\s+Orders[^0-9]{0,40}(\d+)/i],
    ["on_break", /On\s+Break[^0-9]{0,40}(\d+)/i],
    ["offered_associates", /Offered[^0-9]{0,40}(\d+)/i],
    ["picking_associates", /Picking[^0-9A-Za-z]{0,40}(\d+)/i],
    ["packing_racking", /Packing\s*(?:&|and)?\s*Racking[^0-9]{0,40}(\d+)/i],
    ["other_activities", /Other\s+Activities[^0-9]{0,40}(\d+)/i],
    ["total_associates", /Total\s+Associates[^0-9]{0,40}(\d+)/i]
  ];
  for (const [key, re] of patterns) {
    const m = html.match(re);
    if (m) out[key] = Number(m[1]);
  }
  if (Object.values(out).some((v) => typeof v === "number" && v > 0)) out.source = "html";
  return out;
}

test("associate banner parses API status array", () => {
  const parsed = parseAssociateBanner({
    associateStatusCounts: [
      { label: "Waiting for Orders", count: 2 },
      { label: "On Break", count: 0 },
      { label: "Offered", count: 0 },
      { label: "Picking", count: 5 },
      { label: "Packing & Racking", count: 0 },
      { label: "Other Activities", count: 8 },
      { label: "Total Associates", count: 15 }
    ]
  });
  assert.equal(parsed.source, "api");
  assert.equal(parsed.waiting_for_orders, 2);
  assert.equal(parsed.picking_associates, 5);
  assert.equal(parsed.other_activities, 8);
  assert.equal(parsed.total_associates, 15);
});

test("associate banner parses Site Summary HTML tiles", () => {
  const html = `
    Waiting for Orders</div><div>2</div>
    On Break</div><div>0</div>
    Offered</div><div>0</div>
    Picking</div><div>5</div>
    Packing & Racking</div><div>0</div>
    Other Activities</div><div>8</div>
    Total Associates</div><div>15</div>`;
  const parsed = parseAssociateBannerFromHtml(html);
  assert.equal(parsed.source, "html");
  assert.equal(parsed.waiting_for_orders, 2);
  assert.equal(parsed.total_associates, 15);
});
