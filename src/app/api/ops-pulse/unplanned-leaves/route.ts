import { getAuthorization, hasPermission } from '@/lib/authorization';
import { loadOpsUnplannedLeaves } from '@/lib/ops-pulse/unplanned-leaves-data';
import { leaveExportRows, leaveReport, unplannedFilters } from '@/lib/ops-pulse/unplanned-leaves';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request) {
  const auth = await getAuthorization();
  if (!auth || !hasPermission(auth, 'ops_unplanned_leaves', 'access')) return Response.json({ error: 'Unplanned Leaves access is required.' }, { status: 403, headers });
  const params = new URL(request.url).searchParams;
  let filters: ReturnType<typeof unplannedFilters>;
  try { filters = unplannedFilters(params); }
  catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Choose valid dates and filters.' }, { status: 400, headers }); }
  try {
    const data = await loadOpsUnplannedLeaves(auth, filters);
    const report = leaveReport(data, filters);
    if (params.get('format') === 'xlsx') {
      const XLSX = await import('xlsx');
      const columns = ['Date','Name','People ID','Type','Role','Department','Location','Location name','Cluster','Region','Contact','Employment','Last working day','Shift','Attendance status','First punch (IST)','Latest punch (IST)','Check-out (IST)','Follow-up','Reason'];
      const sheet = XLSX.utils.json_to_sheet(leaveExportRows(report.rows), { header: columns });
      sheet['!cols'] = columns.map(() => ({ wch: 22 }));
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, 'Unplanned Leaves');
      return new Response(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { headers: { ...headers,
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="unplanned-leaves-${filters.from}-${filters.to}-${filters.view}.xlsx"` } });
    }
    return Response.json({ rows: report.pageRows, summary: report.summary, page: report.page, pageCount: report.pageCount, total: report.rows.length, checkedAt: data.checkedAt }, { headers });
  } catch { return Response.json({ error: 'Attendance could not be loaded. Please retry.' }, { status: 503, headers }); }
}
