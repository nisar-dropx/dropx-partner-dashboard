/**
 * Dark Store outbound message urgency × frequency policy (pure + resolver helpers).
 * Policies live in ds_message_policies — callers must not hardcode thresholds.
 */

export type DsMessageUrgency = "critical" | "high" | "normal" | "info";
export type DsMessageFrequency = "immediate" | "cooldown" | "digest" | "mute";

export type DsMessagePolicy = {
  messageType: string;
  urgency: DsMessageUrgency;
  frequency: DsMessageFrequency;
  cooldownMinutes: number;
  quietStartMinute: number | null;
  quietEndMinute: number | null;
  thresholdSeconds: number | null;
  enabled: boolean;
  version: number;
};

export type DsMessageDecision = {
  allowSend: boolean;
  reason: string;
  urgency: DsMessageUrgency;
  frequency: DsMessageFrequency;
  policyVersion: number;
  cooldownMinutes: number;
  thresholdSeconds: number | null;
};

/** Map Report Bot categories to DS message type codes. */
export function reportBotCategoryMessageType(category: string | null | undefined): string | null {
  const key = String(category ?? "").trim().toLowerCase();
  if (key === "cold_chain") return "report_bot_cold_chain";
  if (key === "infrastructure") return "report_bot_infrastructure";
  if (key === "workforce") return "report_bot_workforce";
  return null;
}

export function datomsLevelMessageType(level: string | number | null | undefined): string | null {
  const raw = String(level ?? "").trim().toUpperCase();
  if (raw === "L2" || raw === "2") return "datoms_l2";
  if (raw === "L3" || raw === "3") return "datoms_l3";
  return null;
}

/** Minutes since midnight IST for an absolute instant. */
export function istMinuteOfDay(atMs: number = Date.now()): number {
  const ist = new Date(atMs + 5.5 * 3600 * 1000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function inQuietHours(policy: DsMessagePolicy, minute: number): boolean {
  const start = policy.quietStartMinute;
  const end = policy.quietEndMinute;
  if (start == null || end == null) return false;
  if (start === end) return false;
  if (start < end) return minute >= start && minute < end;
  return minute >= start || minute < end;
}

export function decideDsMessageSend(input: {
  policy: DsMessagePolicy | null;
  lastSentAtMs?: number | null;
  nowMs?: number;
}): DsMessageDecision {
  const nowMs = input.nowMs ?? Date.now();
  if (!input.policy) {
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
  const policy = input.policy;
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
  // Critical always pierces quiet hours (Datoms L3 / cold chain).
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
  // digest = paced send (cron is the digester); same cadence gate as cooldown.
  if (
    (policy.frequency === "cooldown" || policy.frequency === "digest") &&
    policy.cooldownMinutes > 0 &&
    input.lastSentAtMs != null
  ) {
    const elapsedMin = (nowMs - input.lastSentAtMs) / 60000;
    if (elapsedMin < policy.cooldownMinutes) {
      return {
        allowSend: false,
        reason: `Cooldown ${policy.cooldownMinutes}m (${Math.ceil(policy.cooldownMinutes - elapsedMin)}m left)`,
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

/** Behaviour-neutral fallbacks matching pre-policy env defaults. */
export function fallbackDsMessagePolicy(messageType: string): DsMessagePolicy {
  const table: Record<string, Omit<DsMessagePolicy, "messageType" | "version">> = {
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
    },
    report_bot_cold_chain: {
      urgency: "critical", frequency: "immediate", cooldownMinutes: 0,
      quietStartMinute: null, quietEndMinute: null, thresholdSeconds: null, enabled: true
    },
    report_bot_infrastructure: {
      urgency: "high", frequency: "immediate", cooldownMinutes: 0,
      quietStartMinute: null, quietEndMinute: null, thresholdSeconds: null, enabled: true
    },
    report_bot_workforce: {
      urgency: "high", frequency: "immediate", cooldownMinutes: 0,
      quietStartMinute: null, quietEndMinute: null, thresholdSeconds: null, enabled: true
    }
  };
  const row = table[messageType] ?? {
    urgency: "normal" as const,
    frequency: "cooldown" as const,
    cooldownMinutes: 15,
    quietStartMinute: null,
    quietEndMinute: null,
    thresholdSeconds: null,
    enabled: true
  };
  return { messageType, version: 0, ...row };
}

/** Whether Report Bot should treat a category as high-risk (needs approval) from policy. */
export function reportBotCategoryNeedsApproval(
  category: string | null | undefined,
  policies: DsMessagePolicy[]
): boolean {
  const type = reportBotCategoryMessageType(category);
  if (!type) return false;
  const policy = policies.find((p) => p.messageType === type) ?? fallbackDsMessagePolicy(type);
  if (!policy.enabled) return false;
  return policy.urgency === "critical" || policy.urgency === "high";
}
