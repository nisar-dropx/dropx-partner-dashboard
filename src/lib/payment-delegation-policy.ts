export function paymentRoutingDay(at = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

type CoverState = { name: string; canAct: boolean; unavailable: boolean; delegateUserId: string | null; conflictingCover?: boolean };
/** Follow explicit cover only. Cycles/invalid cover fail safely to the configured role fallback. */
export async function resolvePaymentCover(userId: string, lookup: (id: string) => Promise<CoverState>) {
  const visited = new Set<string>();
  const names: string[] = [];
  let current = userId;
  while (visited.size < 10) {
    if (visited.has(current)) return null;
    visited.add(current);
    const state = await lookup(current);
    names.push(state.name);
    if (state.conflictingCover) return null;
    if (state.delegateUserId) { current = state.delegateUserId; continue; }
    if (!state.canAct || state.unavailable) return null;
    return { userId: current, routingReason: names.length > 1 ? `Leave / acting cover: ${names.join(' → ')}` : null };
  }
  return null;
}
