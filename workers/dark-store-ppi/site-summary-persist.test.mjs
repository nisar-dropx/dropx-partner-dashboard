import assert from "node:assert/strict";
import test from "node:test";
import { mapActiveOrders, parseLaborAssociates, pickSlaSeconds } from "./site-summary-map.mjs";

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

test("pick SLA tiers match Amazon QUICK_COMMERCE capabilities / UI", () => {
  assert.equal(pickSlaSeconds(2), 150, "2 items → 02:30");
  assert.equal(pickSlaSeconds(7), 210, "7 items → 03:30");
  assert.equal(pickSlaSeconds(13), 300, "13 items → 05:00");
  assert.equal(pickSlaSeconds(23), 630, "23 items → 10:30");
});

test("acceptance is create→assign; picking starts at assignment", () => {
  const nowS = 1795241312;
  const [row] = mapActiveOrders([{
    fulfillmentId: "403-1861924-9999999",
    associateInfo: { associateId: "athirisg" },
    itemsPicked: 9,
    totalItems: 13,
    procurementListAssignmentTime: 1795241258,
    procurementListCreatedTime: 1795241252,
    pickingFinishedTime: null,
    latestPackageStowedTime: null,
    status: "PICKING",
    timeSinceFirstPick: { firstItemPickTime: 1795241270, completionTime: null }
  }], { nowS });

  assert.equal(row.acceptanceS, 6, "Amazon acceptance = assign - create");
  assert.equal(row.pickingS, nowS - 1795241258, "picking runs from assignment, not first scan");
  assert.equal(row.pctComplete, 69);
  assert.equal(row.pickingTarget, 300);
  assert.equal(row.totalTarget, 15 + 300 + 30);
  assert.equal(row.pendingAcceptance, false);
});

test("unassigned dropped order keeps acceptance running and no picking", () => {
  const nowS = 1795241343 + 45;
  const [row] = mapActiveOrders([{
    fulfillmentId: "404-7864671-1240301",
    associateInfo: { associateId: null },
    itemsPicked: 0,
    totalItems: 1,
    procurementListAssignmentTime: null,
    procurementListCreatedTime: 1795241337,
    status: "DROPPED",
    timeSinceFirstPick: { firstItemPickTime: null, completionTime: null }
  }], { nowS });
  assert.equal(row.pendingAcceptance, true);
  assert.equal(row.acceptanceS, nowS - 1795241337);
  assert.equal(row.pickingS, null);
  assert.equal(row.picker, "Unassigned");
});

test("labor findpeople maps functions onto Site Summary tiles", () => {
  const parsed = parseLaborAssociates({
    associates: [
      { associateId: "a", function: "Wait" },
      { associateId: "b", function: "Wait" },
      { associateId: "c", function: "Offered" },
      { associateId: "d", function: "Pack" },
      { associateId: "e", function: "BagScan" },
      { associateId: "f", function: "CompletePackage" },
      { associateId: "g", function: "Stow" }
    ]
  });
  assert.equal(parsed.source, "labor");
  assert.equal(parsed.waiting_for_orders, 2);
  assert.equal(parsed.offered_associates, 1);
  assert.equal(parsed.picking_associates, 1);
  assert.equal(parsed.packing_racking, 0);
  assert.equal(parsed.other_activities, 3);
  assert.equal(parsed.total_associates, 7);
});
