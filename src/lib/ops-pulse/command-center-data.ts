import 'server-only';
import { hasPermission, type AuthorizationContext } from '@/lib/authorization';
import { requireCompanyId } from '@/lib/company-scope';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { readAllRows } from '@/lib/supabase-pagination';
import { cpsScope, loadCpsSnapshot } from './cps-data';
import type { CodLocationRow } from './cod';
import { loadPerformanceTargets, resolvePerformanceTargets } from './performance-targets';
import { ACTIVE_DAILY_PERFORMANCE_SOURCE } from './performance-source-policy';
import { buildCommandCenter, type CommandPeriod, type CommandPerformanceFact, type CommandReview } from './command-center';

export async function loadCommandCenter(a: AuthorizationContext, locations: CodLocationRow[], period: CommandPeriod, amazon: boolean, today: string) {
  const company = requireCompanyId(a);
  const codes = locations.map(l => l.station_code);
  const canCost = hasPermission(a, 'cps_overview', 'access');
  const canReview = amazon && hasPermission(a, 'performance_review', 'access');
  const canPerformance = amazon && (hasPermission(a, 'performance', 'access') || canReview);
  const performanceDate = period.to === today ? new Date(Date.parse(today + 'T00:00:00Z') - 86400000).toISOString().slice(0,10) : period.to;
  const errors: string[] = [];
  async function attempt<T>(label: string, work: () => Promise<T>): Promise<T | null> {
    try { return await work(); } catch (error) { console.error('Command center', label, error instanceof Error ? error.message : 'unavailable'); errors.push(label); return null; }
  }
  const [cost, perf, reviews] = await Promise.all([
    canCost && codes.length ? attempt('CPS cost source', async () => {
      // Reuse CPS topology, but intersect with the selected workspace scope.
      const scope = await cpsScope(a, {period:'custom', ...period}, true);
      const selected = scope.all.filter(l => codes.includes(l.station_code));
      const snapshot = await loadCpsSnapshot(company, period.from, period.to, selected);
      return { snapshot, places:selected.map(l => ({code:l.station_code,name:l.station_name || l.station_code,
        parent:l.parent_station_code,isXpt:l.is_xpt,owner:l.cluster_manager_names?.join(', ') || l.cluster_manager || ''})) };
    }) : null,
    canPerformance && codes.length ? attempt('Hawkeye performance', async () => {
      if (!supabaseAdmin) throw Error('Database unavailable');
      const [facts, targets] = await Promise.all([
        readAllRows(supabaseAdmin.from('report_metric_facts').select('id,batch_id,source_type,report_date,station_code,created_at,values_json')
          .eq('company_id', company).in('station_code', codes).eq('source_type', ACTIVE_DAILY_PERFORMANCE_SOURCE)
          .eq('report_date', performanceDate).order('id')),
        loadPerformanceTargets(company, {readOnly:true})
      ]);
      if (facts.error || targets.error) throw Error('Performance source unavailable');
      return { facts: facts.data as CommandPerformanceFact[], targets:resolvePerformanceTargets(targets.rows,'daily') };
    }) : null,
    canReview && codes.length ? attempt('Open operational reviews', async () => {
      if (!supabaseAdmin) throw Error('Database unavailable');
      const r = await readAllRows(supabaseAdmin.from('ops_performance_reviews').select('id,station_code,source_date,status')
        .eq('company_id',company).in('station_code',codes).eq('review_type','daily_operations')
        .in('status',['open','in_review']).lte('source_date',period.to).order('id'));
      if (r.error) throw Error('Reviews unavailable');
      return r.data as CommandReview[];
    }) : null
  ]);
  const places = cost?.places ?? locations.map(l => ({code:l.station_code,name:l.station_name || l.station_code,owner:l.cluster_manager_names?.join(', ') || l.cluster_manager || ''}));
  return { model:buildCommandCenter({snapshot:cost?.snapshot ?? null, places, period, performance:perf?.facts ?? null,
    targets:perf?.targets ?? null,reviews,performanceDate}),errors,canCost,canCostAttention:hasPermission(a,'cps_unmapped','access'),canPerformance,canReview,performanceDate };
}
