export type DeliverySeverity = "good" | "watch" | "critical";

/** Thresholds a manager scanning the network would actually use: below 70% needs attention now, 70-85% is worth watching, 85%+ is on track. */
export function deliverySeverity(deliveredPct: number): DeliverySeverity {
  if (deliveredPct < 70) return "critical";
  if (deliveredPct < 85) return "watch";
  return "good";
}

export function deliverySeverityLabel(severity: DeliverySeverity): string {
  switch (severity) {
    case "critical": return "Critical";
    case "watch": return "Watch";
    case "good": return "On track";
  }
}
