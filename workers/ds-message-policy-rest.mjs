/** Supabase REST + pure DS message policy helpers for Node workers (no TypeScript build). */

export function istMinuteOfDay(atMs = Date.now()) {
  const ist = new Date(atMs + 5.5 * 3600 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function inQuietHours(policy, minute) {
  const start = policy?.quietStartMinute;
  const end = policy?.quietEndMinute;
  if (start == null || end == null) return false;
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

export function fallbackDsMessagePolicy(messageType) {
  const table = {
    site_summary_acceptance: {
      urgency: "high", frequency: "cooldown", cooldownMinutes: 5,
      quietStartMinute: null, quietEndMinute: null, thresholdSeconds: 15, enabled: true
    },
    datoms_l2: {
      urgency: "high", frequency: "immediate", cooldownMinutes: 0,
      quietStartMinute: null, quietEndMinute: null, thresholdSeconds: null, enabled: true
    },
    datoms_l3: {
      urgency: "critical", frequency: "immediate", cooldownMinutes: 0,
      quietStartMinute: null, quietEndMinute: null, thresholdSeconds: null, enabled: true
    },
    shift_noshow: {
      urgency: "high", frequency: "cooldown", cooldownMinutes: 15,
      quietStartMinute: null, quietEndMinute: null, thresholdSeconds: null, enabled: true
    },
    shift_no_roster: {
      urgency: "normal", frequency: "cooldown", cooldownMinutes: 120,
      quietStartMinute: null, quietEndMinute: null, thresholdSeconds: null, enabled: true
    },
    shift_not_started: {
      urgency: "high", frequency: "cooldown", cooldownMinutes: 60,
      quietStartMinute: null, quietEndMinute: null, thresholdSeconds: null, enabled: true
    },
    ops_incomplete: {
      urgency: "normal", frequency: "digest", cooldownMinutes: 1440,
      quietStartMinute: null, quietEndMinute: null, thresholdSeconds: null, enabled: true
    }
  };
  const row = table[messageType] ?? {
    urgency: "normal", frequency: "cooldown", cooldownMinutes: 15,
    quietStartMinute: null, quietEndMinute: null, thresholdSeconds: null, enabled: true
  };
  return { messageType, version: 0, ...row };
}

export function mapPolicyRow(row) {
  if (!row) return null;
  return {
    messageType: row.message_type,
    urgency: row.urgency,
    frequency: row.frequency,
    cooldownMinutes: Number(row.cooldown_minutes ?? 0),
    quietStartMinute: row.quiet_start_minute,
    quietEndMinute: row.quiet_end_minute,
    thresholdSeconds: row.threshold_seconds != null ? Number(row.threshold_seconds) : null,
    enabled: row.enabled !== false,
    version: Number(row.version ?? 1)
  };
}

export function decideDsMessageSend({ policy, lastSentAtMs = null, nowMs = Date.now() }) {
  if (!policy) {
    return {
      allowSend: false,
      reason: "No policy configured",
      urgency: "normal",
      frequency: "mute",
      policyVersion: 0,
      cooldownMinutes: 0,
      thresholdSeconds: null
    };
  }
  if (!policy.enabled || policy.frequency === "mute") {
    return {
      allowSend: false,
      reason: policy.enabled ? "Muted by policy" : "Policy disabled",
      urgency: policy.urgency,
      frequency: policy.frequency,
      policyVersion: policy.version,
      cooldownMinutes: policy.cooldownMinutes,
      thresholdSeconds: policy.thresholdSeconds
    };
  }
  if (policy.urgency !== "critical" && inQuietHours(policy, istMinuteOfDay(nowMs))) {
    return {
      allowSend: false,
      reason: "Quiet hours",
      urgency: policy.urgency,
      frequency: policy.frequency,
      policyVersion: policy.version,
      cooldownMinutes: policy.cooldownMinutes,
      thresholdSeconds: policy.thresholdSeconds
    };
  }
  if (
    (policy.frequency === "cooldown" || policy.frequency === "digest") &&
    policy.cooldownMinutes > 0 &&
    lastSentAtMs != null
  ) {
    const elapsedMin = (nowMs - lastSentAtMs) / 60000;
    if (elapsedMin < policy.cooldownMinutes) {
      return {
        allowSend: false,
        reason: `Cooldown ${policy.cooldownMinutes}m`,
        urgency: policy.urgency,
        frequency: policy.frequency,
        policyVersion: policy.version,
        cooldownMinutes: policy.cooldownMinutes,
        thresholdSeconds: policy.thresholdSeconds
      };
    }
  }
  return {
    allowSend: true,
    reason:
      policy.frequency === "immediate"
        ? "Immediate"
        : policy.frequency === "digest"
          ? "Digest window open"
          : "Cooldown cleared",
    urgency: policy.urgency,
    frequency: policy.frequency,
    policyVersion: policy.version,
    cooldownMinutes: policy.cooldownMinutes,
    thresholdSeconds: policy.thresholdSeconds
  };
}

function sbHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal"
  };
}

export async function fetchDsMessagePolicy({ url, key, companyId, messageType }) {
  if (!url || !key || !companyId) return null;
  try {
    const qs = new URLSearchParams({
      company_id: `eq.${companyId}`,
      message_type: `eq.${messageType}`,
      select: "message_type,urgency,frequency,cooldown_minutes,quiet_start_minute,quiet_end_minute,threshold_seconds,enabled,version",
      limit: "1"
    });
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/ds_message_policies?${qs}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    return mapPolicyRow(Array.isArray(rows) ? rows[0] : null);
  } catch {
    return null;
  }
}

export async function fetchLastDsMessageSentAt({ url, key, companyId, messageType, stationCode }) {
  if (!url || !key || !companyId) return null;
  try {
    const qs = new URLSearchParams({
      company_id: `eq.${companyId}`,
      message_type: `eq.${messageType}`,
      select: "sent_at",
      order: "sent_at.desc",
      limit: "1"
    });
    if (stationCode) qs.set("station_code", `eq.${String(stationCode).trim().toUpperCase()}`);
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/ds_message_send_log?${qs}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    const sentAt = Array.isArray(rows) && rows[0]?.sent_at ? rows[0].sent_at : null;
    if (!sentAt) return null;
    const ms = new Date(sentAt).getTime();
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

export async function recordDsMessageSendRest({
  url,
  key,
  companyId,
  messageType,
  stationCode,
  policyVersion,
  dedupeKey,
  meta
}) {
  if (!url || !key || !companyId) return;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/ds_message_send_log`, {
      method: "POST",
      headers: sbHeaders(key),
      body: JSON.stringify({
        company_id: companyId,
        message_type: messageType,
        station_code: stationCode ? String(stationCode).trim().toUpperCase() : null,
        policy_version: policyVersion,
        dedupe_key: dedupeKey ?? null,
        meta_json: meta ?? {}
      })
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[ds-message-policy] send_log insert failed: ${res.status} ${body.slice(0, 120)}`);
    }
  } catch (error) {
    console.warn("[ds-message-policy] send_log insert error:", error?.message || error);
  }
}

export function datomsLevelMessageType(level) {
  const raw = String(level ?? "").trim().toUpperCase();
  if (raw === "L2" || raw === "2") return "datoms_l2";
  if (raw === "L3" || raw === "3") return "datoms_l3";
  return null;
}