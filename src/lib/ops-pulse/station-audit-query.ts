/** PostgREST caps individual responses; audit evidence and TID lists must never silently truncate. */
export async function allAuditRows<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const data: T[] = [];
  for (let from = 0; ; from += 500) {
    const result = await page(from, from + 499);
    if (result.error) return { data: null, error: result.error };
    data.push(...(result.data || []));
    if (!result.data || result.data.length < 500) return { data, error: null };
    if (data.length >= 100000)
      return {
        data: null,
        error: {
          message:
            "This audit selection is too large. Choose fewer stations or dates.",
        },
      };
  }
}

/** Bound IN filters so long date ranges do not exceed PostgREST URL limits. */
export async function auditRowsForIds<T>(
  ids: string[],
  page: (ids: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const data: T[] = [];
  for (let index = 0; index < ids.length; index += 100) {
    const result = await allAuditRows((from, to) => page(ids.slice(index, index + 100), from, to));
    if (result.error) return { data: null, error: result.error };
    data.push(...(result.data || []));
  }
  return { data, error: null };
}
