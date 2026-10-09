/** Fetch complete scoped queues, including pending requests older than 1,000 rows.
 * Callers provide a freshly built, deterministic (created_at + id) query each page. */
export async function readPaymentPages<T>(load: (from: number, to: number) => PromiseLike<{
  data: T[] | null; error: { message: string } | null;
}>, pageSize = 500): Promise<{ data: T[]; error: null }> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const result = await load(from, from + pageSize - 1);
    if (result.error) throw new Error(`Payment data could not be loaded: ${result.error.message}`);
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return { data: rows, error: null };
  }
}

/** Narrow the DB scan; the existing assignment/status policy is still applied afterwards.
 * Null legacy approval_status rows remain eligible for the JS fallback to status. */
export function approvalQueueCondition(status: string) {
  if (status === "pending") return "approval_status.is.null,approval_status.not.in.(RE_APPROVED,REJECTED,RETURNED,CANCELLED,PROCESSING,PROCESSED)";
  if (status === "returned") return "approval_status.eq.RETURNED,status.eq.returned";
  if (status === "rejected") return "approval_status.eq.REJECTED,status.eq.rejected";
  return null;
}
