/** Pure Amazon Site Summary → DropX row / associate mapping (unit-testable). */

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
 * Amazon Site Summary API does not send mm:ss clocks or percentComplete.
 * Clocks are derived from assignment / first-pick / finish / stow epochs;
 * percent from itemsPicked ÷ totalItems.
 */
export function mapActiveOrders(summaries, { nowS = Date.now() / 1000, acceptanceTarget = 15 } = {}) {
  const rows = [];
  for (const s of summaries) {
    const oid = orderOid(s);
    if (!oid) continue;
    const createdAt = assignmentEpochSeconds(s.procurementListCreatedTime);
    const assignedAt = assignmentEpochSeconds(
      s.procurementListAssignmentTime ?? s.assignmentTime ?? s.procurementListCreatedTime ?? 0
    );
    const firstPickAt = assignmentEpochSeconds(s.timeSinceFirstPick?.firstItemPickTime);
    const pickingFinishedAt = assignmentEpochSeconds(s.pickingFinishedTime ?? s.timeSinceFirstPick?.completionTime);
    const stowedAt = assignmentEpochSeconds(s.latestPackageStowedTime);

    const acceptanceEnd = firstPickAt ?? nowS;
    const acceptanceS = assignedAt != null ? Math.max(0, acceptanceEnd - assignedAt) : null;

    const pickingS = firstPickAt != null
      ? Math.max(0, (pickingFinishedAt ?? nowS) - firstPickAt)
      : null;

    const packS = pickingFinishedAt != null
      ? Math.max(0, (stowedAt ?? nowS) - pickingFinishedAt)
      : firstPickAt != null ? 0 : null;

    const totalAnchor = createdAt ?? assignedAt;
    const totalS = totalAnchor != null
      ? Math.max(0, nowS - totalAnchor)
      : [acceptanceS, pickingS, packS].filter((n) => n != null).reduce((a, b) => a + b, 0) || null;

    const items = Number(s.totalItems ?? 0) || Number(s.itemsToPick ?? 0) || 0;
    const picked = Number(s.itemsPicked ?? 0);
    const pctFromItems = items > 0 && Number.isFinite(picked) ? Math.round((picked / items) * 100) : NaN;
    const pct = Number(s.percentComplete ?? s.pctComplete ?? s.completionPercentage ?? pctFromItems);

    const packTarget = 30;
    const pickingTarget = items > 0 ? items * 30 : null;
    const totalTarget = pickingTarget != null ? acceptanceTarget + pickingTarget + packTarget : null;

    const picker = s.associateInfo?.associateId ?? s.associateInfo?.login ?? s.associateId ?? "Unassigned";
    const status = String(s.status ?? "").toUpperCase();
    const pendingAcceptance = firstPickAt == null
      && !["SLAMMED", "STAGED", "PACKED", "COMPLETED", "CANCELLED"].includes(status);

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
      pendingAcceptance
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
  if (f === "offered" || f === "assigned") return "offered_associates";
  if (f === "pack" || f.includes("pick") || f === "startpick") return "picking_associates";
  if (
    f.includes("bag")
    || f.includes("completepackage")
    || f.includes("rack")
    || f.includes("slam")
    || f === "packandstage"
  ) return "packing_racking";
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
