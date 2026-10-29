import * as XLSX from 'xlsx';
import { getAuthorization, hasPermission } from '@/lib/authorization';
import { loadRecoveryWorkspace } from '@/lib/ops-pulse/loss-recovery-workspace';
import { recoveryUpdates, filterRecoveryUpdates, recoveryUpdateExportRows } from '@/lib/ops-pulse/loss-recovery-updates';
import { indiaMonth } from '@/lib/ops-pulse/loss-recovery-queue-policy';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const auth = await getAuthorization();
    if (!auth || !hasPermission(auth, 'ops_losses', 'access')) return new Response('Access denied', {status:403});
    // Same permission and station scope as the recovery screen.
    const view = await loadRecoveryWorkspace(auth), q = new URL(request.url).searchParams, currentMonth = indiaMonth();
    const rows = filterRecoveryUpdates(recoveryUpdates(view.rows, view.lines, view.settings?.recoverable_statuses || [], currentMonth), {
      station:q.get('station') || '', month:q.get('month') || '', status:q.get('status') || '', query:q.get('query') || '', salaryScope:q.get('salaryScope') || '', currentMonth,
    });
    const book = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet(recoveryUpdateExportRows(rows));
    sheet['!cols'] = [14,18,30,24,22,15,26,20,18,24,30,26].map(wch=>({wch}));
    if (sheet['!ref']) sheet['!autofilter'] = {ref:sheet['!ref']};
    XLSX.utils.book_append_sheet(book,sheet,'Saved recovery assignments');
    return new Response(XLSX.write(book,{type:'buffer',bookType:'xlsx'}), {headers:{
      'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition':'attachment; filename="OpsPulse-Recovery-Salary-Months.xlsx"', 'Cache-Control':'private, no-store',
    }});
  } catch (error) {
    return Response.json({error:error instanceof Error ? error.message : 'Export failed'}, {status:403});
  }
}
