/** Bounded reads only. Never retry a payment mutation after an ambiguous response. */
export async function paymentRead<T = any>(url: string, options: {signal?: AbortSignal; timeoutMs?: number} = {}): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, {once:true});
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 35_000);
  try {
    const response = await fetch(url, {method:'GET',cache:'no-store',signal:controller.signal});
    let body: any;
    try { body = await response.json(); }
    catch (error) {
      if (controller.signal.aborted) throw error;
      throw new Error('Payment details are temporarily unavailable. Please retry.');
    }
    if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Payment details could not be loaded. Please retry.');
    return body as T;
  } catch (error) {
    if (timedOut) throw new Error('Loading is taking longer than usual. Please retry.');
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort',cancel);
  }
}

/** Each screen owns one instance. Cancel obsolete reads on refresh, navigation or unmount. */
export function latestPaymentRead() {
  let active: AbortController | null = null;
  return {
    start() {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      return {signal:controller.signal,isCurrent:()=>active===controller&&!controller.signal.aborted};
    },
    cancel() { active?.abort(); active=null; }
  };
}
