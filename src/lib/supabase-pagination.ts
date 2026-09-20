/** Read complete server-side ledgers. Callers must supply stable ordering and scope. */
// Supabase's inferred builder types vary with each selected relationship.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readAllRows(query: any): Promise<{ data: any[] | null; error: { code?: string; message: string } | null }> {
  const rows = [];
  const pageSize = 500;
  for (let start = 0; start < 100000; start += pageSize) {
    const result = await query.range(start, start + pageSize - 1);
    if (result.error) return { data: null, error: result.error };
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return { data: rows, error: null };
  }
  return { data: null, error: { message: "The result exceeds 100,000 records. Narrow the selection before continuing." } };
}
