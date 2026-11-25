/** Pure Amazon Site Summary → DropX row / associate mapping (unit-testable). */

/** Default QUICK_COMMERCE capability SLAs from /api/v1/sitecapabilities. */
export const DEFAULT_PICK_SLA = {
  acceptance: 15,
  packRack: 30,
  upToFive: 150,
  upToTen: 210,
  upToFifteen: 300,
  upToTwenty: 360,
  overTwentyRate: 90
};

export function assignmentEpochSeconds(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? n / 1000 : n;
}

export function orderOid(summary) {
  const raw = String(summary.fulfillmentId ?? summary.procurementListId ?? summary.orderId ?? "").trim();
  if (!raw) return null;
  const stripped = raw.replace(/^.+-/, "");
  return (stripped || raw).slice(-12);
}

export function emptyAssociates() {
  return {
    waiting_for_orders: 0,
    on_break: 0,
    offered_associates: 0,
    picking_associates: 0,
    packing_racking: 0,
    other_activities: 0,
    total_associates: 0,
    source: "none"
  };
}

/**
 * Amazon pick-time SLA tiers (capability PickSLAInSeconds*).
 * Over-20 matches the Site Summary UI: upToTwenty + (items-20)*rate
 * (23 items → 10:30), not OverTwentyItems+rate which overshoots.
 */
export function pickSlaSeconds(items, caps = DEFAULT_PICK_SLA) {
  const n = Math.max(0, Math.floor(Number(items) || 0));
  if (n <= 0) return caps.upToFive;
  if (n <= 5) return caps.upToFive;
  if (n <= 10) return caps.upToTen;
  if (n <= 15) return caps.upToFifteen;
  if (n <= 20) return caps.upToTwenty;
  return caps.upToTwenty + (n - 20) * caps.overTwentyRate;
}

/**
 * Amazon Site Summary API does not send mm:ss clocks or percentComplete.
 *
 * Clocks (matches Amazon UI):
 *   Acceptance = created → assigned (frozen once assigned; else created → now)
 *   Picking    = assigned → finish/now  (starts at assignment, not first item scan)
 *   Pack/Rack  = pickingFinished → stow/now
 *   Total      = created → now
 *   %          = itemsPicked ÷ totalItems
 */
export function mapActiveOrders(summaries, {
  nowS = Date.now() / 1000,
  sla = DEFAULT_PICK_SLA
} = {}) {
  const acceptanceTarget = sla.acceptance ?? 15;
  const packTarget = sla.packRack ?? 30;
  const rows = [];
  for (const s of summaries) {
    const oid = orderOid(s);
    if (!oid) continue;
    const createdAt = assignmentEpochSeconds(s.procurementListCreatedTime);
    // Do not fall back to created — unassigned rows must stay unassigned.
    const assignedAt = assignmentEpochSeconds(s.procurementListAssignmentTime ?? s.assignmentTime);
    const firstPickAt = assignmentEpochSeconds(s.timeSinceFirstPick?.firstItemPickTime);
    const pickingFinishedAt = assignmentEpochSeconds(s.pickingFinishedTime ?? s.timeSinceFirstPick?.completionTime);
    const stowedAt = assignmentEpochSeconds(s.latestPackageStowedTime);
    const status = String(s.status ?? "").toUpperCase();

    let acceptanceS = null;
    if (createdAt != null) {
      acceptanceS = assignedAt != null
        ? Math.max(0, assignedAt - createdAt)
        : Math.max(0, nowS - createdAt);
    }

    const pickingS = assignedAt != null
      ? Math.max(0, (pickingFinishedAt ?? nowS) - assignedAt)
      : null;

    const packS = pickingFinishedAt != null
      ? Math.max(0, (stowedAt ?? nowS) - pickingFinishedAt)
      : assignedAt != null ? 0 : null;

    const totalS = createdAt != null ? Math.max(0, nowS - createdAt) : null;

    const items = Number(s.totalItems ?? 0) || Number(s.itemsToPick ?? 0) || 0;
    const picked = Number(s.itemsPicked ?? 0);
    const pctFromItems = items > 0 && Number.isFinite(picked) ? Math.round((picked / items) * 100) : NaN;
    const pct = Number(s.percentComplete ?? s.pctComplete ?? s.completionPercentage ?? pctFromItems);

    const pickingTarget = pickSlaSeconds(items, sla);
    const totalTarget = acceptanceTarget + pickingTarget + packTarget;

    const picker = s.associateInfo?.associateId ?? s.associateInfo?.login ?? s.associateId ?? "Unassigned";
    const pendingAcceptance = assignedAt == null
      && createdAt != null
      && !["SLAMMED", "STAGED", "PACKED", "COMPLETED", "CANCELLED", "PICKING"].includes(status);

    rows.push({
      oid,
      picker: String(picker || "Unassigned"),
      elapsedS: acceptanceS ?? 0,
      acceptanceS,
      pickingS,
      packS,
      totalS,
      acceptanceTarget,
      pickingTarget,
      packTarget,
      totalTarget,
      items,
      pctComplete: Number.isFinite(pct) ? pct : null,
      status,
      pendingAcceptance,
      firstPickAt,
      assignedAt,
      createdAt
    });
  }
  rows.sort((a, b) => (b.acceptanceS ?? b.elapsedS) - (a.acceptanceS ?? a.elapsedS));
  return rows;
}

export function laborFunctionBucket(fn) {
  const f = String(fn ?? "").toLowerCase();
  if (!f) return "other_activities";
  if (f === "wait" || f.includes("waiting")) return "waiting_for_orders";
  if (f.includes("break")) return "on_break";
  if (f === "offered") return "offered_associates";
  // Assigned = accepted an offer, still counts toward offered/idle-accept in Amazon tiles.
  if (f === "assigned") return "offered_associates";
  if (f === "pack" || f.includes("pick") || f === "startpick") return "picking_associates";
  if (f.includes("rack") || f.includes("slam") || f === "packandstage") return "packing_racking";
  // BagScan / CompletePackage are brief outbound events — Amazon parks them in Other.
  return "other_activities";
}

export function parseLaborAssociates(payload) {
  const out = emptyAssociates();
  const list = Array.isArray(payload?.associates) ? payload.associates : [];
  if (!list.length) return out;
  for (const row of list) {
    const key = laborFunctionBucket(row.function ?? row.status ?? row.activity);
    out[key] += 1;
  }
  out.total_associates = list.length;
  out.source = "labor";
  return out;
}
