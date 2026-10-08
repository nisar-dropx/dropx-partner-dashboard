/** The scheduled time opens delivery for the IST day; later cron runs recover failed sends. */
export function fleetDailyStatusDue(now: string, configured: string) {
  const minutes = (value: string) => {
    const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
    if (!match) return null;
    const hour = Number(match[1]), minute = Number(match[2]);
    return hour < 24 && minute < 60 ? hour * 60 + minute : null;
  };
  const current = minutes(now), scheduled = minutes(configured || "20:00");
  return current !== null && scheduled !== null && current >= scheduled;
}

/** Bound SMTP concurrency and leave unstarted work unclaimed for the next cron run. */
export async function deliverFleetStatusBatch<T, R>(
  items: T[], deliver: (item: T) => Promise<R>,
  options: { concurrency?: number; deadline?: number; now?: () => number } = {}
) {
  const now = options.now ?? Date.now;
  const concurrency = Math.max(1, Math.min(2, options.concurrency ?? 2));
  const deadline = options.deadline ?? now() + 40_000;
  const results: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && now() < deadline) {
      const index = next++;
      results.push(await deliver(items[index]));
    }
  }));
  return { results, deferred: items.length - next };
}
