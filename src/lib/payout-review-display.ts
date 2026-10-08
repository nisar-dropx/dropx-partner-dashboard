type DisputeEvent = { message?: unknown };

const AREA_PREFIX = "Dispute areas: ";

export function decodePayoutReviewReason(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text.startsWith(AREA_PREFIX)) return { areas: [] as string[], reason: text };
  const [heading, ...body] = text.split(/\r?\n/);
  return {
    areas: heading.slice(AREA_PREFIX.length).split(",").map((item) => item.trim()).filter(Boolean),
    reason: body.join("\n").trim()
  };
}

export function visiblePayoutDisputeEvents<T extends DisputeEvent>(events: T[], storedReason: unknown) {
  const initial = String(storedReason ?? "").trim();
  return events.filter((event) => String(event.message ?? "").trim() !== initial);
}

export function payoutNotificationStatusLabel(status: unknown) {
  switch (String(status ?? "")) {
    case "pending": return "Queued for WhatsApp";
    case "sending": return "Sending to WhatsApp";
    case "sent": return "Accepted by WhatsApp";
    case "failed": return "WhatsApp send failed";
    case "uncertain": return "WhatsApp outcome needs verification";
    case "disabled": return "WhatsApp disabled; App notification published";
    case "superseded": return "Included in the worker's combined notification";
    default: return "WhatsApp status unavailable";
  }
}
