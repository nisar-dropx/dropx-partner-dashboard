import type { SupabaseClient } from '@supabase/supabase-js';
import type { ParsedLossTable } from '../types';

export type LossReportKind = 'nl' | 'slp_initial' | 'slp_final';

export interface LossRunSource {
  fileName: string | null;
  sourceWeek?: string | null;
  sourceCreatedAt?: string | null;
  periodLabel?: string | null;
  sourceTotalCount?: number | null;
  triggeredBy: string;
}

const ROW_CHUNK = 500;
const KEEP_RUNS = 10;

/**
 * loss_report_runs → loss_report_rows + loss_report_station_totals.
 * A run only becomes visible to the dashboard once status = 'completed',
 * so a half-written run never replaces the previous good one.
 */
export class LossReportStore {
  constructor(private readonly db: SupabaseClient) {}

  /** SLP files are immutable per (name, creation date) — skip re-ingesting. */
  async hasCompletedSource(report: LossReportKind, fileName: string, sourceCreatedAt: string | null): Promise<boolean> {
    let q = this.db
      .from('loss_report_runs')
      .select('id')
      .eq('report', report)
      .eq('status', 'completed')
      .eq('source_file', fileName)
      .limit(1);
    q = sourceCreatedAt ? q.eq('source_created_at', sourceCreatedAt) : q.is('source_created_at', null);
    const { data, error } = await q;
    if (error) throw new Error(`loss_report_runs lookup failed: ${error.message}`);
    return Boolean(data?.length);
  }

  async saveRun(report: LossReportKind, source: LossRunSource, table: ParsedLossTable): Promise<{ runId: string; rows: number; stations: number }> {
    const totalAmount = table.rows.reduce((s, r) => s + (r.amount ?? 0), 0);
    const { data: run, error } = await this.db
      .from('loss_report_runs')
      .insert({
        report,
        status: 'running',
        source_file: source.fileName,
        source_week: source.sourceWeek ?? null,
        source_created_at: source.sourceCreatedAt ?? null,
        period_label: source.periodLabel ?? null,
        source_total_count: source.sourceTotalCount ?? null,
        headers: table.headers,
        station_column: table.stationColumn,
        amount_column: table.amountColumn,
        reference_column: table.referenceColumn,
        total_rows: table.rows.length,
        total_amount: round2(totalAmount),
        triggered_by: source.triggeredBy,
      })
      .select('id')
      .single();
    if (error || !run) throw new Error(`loss_report_runs insert failed: ${error?.message ?? 'unknown'}`);
    const runId = run.id as string;

    try {
      for (let i = 0; i < table.rows.length; i += ROW_CHUNK) {
        const chunk = table.rows.slice(i, i + ROW_CHUNK).map((r) => ({
          run_id: runId,
          report,
          station_code: r.stationCode,
          amount: r.amount,
          reference: r.reference,
          raw: r.raw,
        }));
        const { error: rowError } = await this.db.from('loss_report_rows').insert(chunk);
        if (rowError) throw new Error(`loss_report_rows insert failed: ${rowError.message}`);
      }

      const byStation = new Map<string, { count: number; amount: number }>();
      for (const r of table.rows) {
        const key = r.stationCode ?? 'UNMAPPED';
        const agg = byStation.get(key) ?? { count: 0, amount: 0 };
        agg.count += 1;
        agg.amount += r.amount ?? 0;
        byStation.set(key, agg);
      }
      const totals = [...byStation.entries()].map(([station_code, agg]) => ({
        run_id: runId,
        report,
        station_code,
        row_count: agg.count,
        total_amount: round2(agg.amount),
      }));
      if (totals.length) {
        const { error: totalError } = await this.db.from('loss_report_station_totals').insert(totals);
        if (totalError) throw new Error(`loss_report_station_totals insert failed: ${totalError.message}`);
      }

      const { error: doneError } = await this.db
        .from('loss_report_runs')
        .update({ status: 'completed', finished_at: new Date().toISOString() })
        .eq('id', runId);
      if (doneError) throw new Error(`loss_report_runs complete failed: ${doneError.message}`);

      await this.prune(report);
      return { runId, rows: table.rows.length, stations: totals.length };
    } catch (err) {
      await this.db
        .from('loss_report_runs')
        .update({ status: 'failed', error: (err as Error).message.slice(0, 500), finished_at: new Date().toISOString() })
        .eq('id', runId);
      throw err;
    }
  }

  async recordFailure(report: LossReportKind, triggeredBy: string, error: string): Promise<void> {
    await this.db.from('loss_report_runs').insert({
      report,
      status: 'failed',
      error: error.slice(0, 500),
      triggered_by: triggeredBy,
      finished_at: new Date().toISOString(),
    });
  }

  async latest(report: LossReportKind) {
    const { data } = await this.db
      .from('loss_report_runs')
      .select('id,report,status,source_file,source_week,period_label,total_rows,total_amount,error,started_at,finished_at')
      .eq('report', report)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data;
  }

  /** Keep the newest KEEP_RUNS runs per report; rows/totals cascade. */
  private async prune(report: LossReportKind): Promise<void> {
    const { data } = await this.db
      .from('loss_report_runs')
      .select('id')
      .eq('report', report)
      .order('started_at', { ascending: false })
      .range(KEEP_RUNS, KEEP_RUNS + 200);
    const ids = (data ?? []).map((r) => r.id as string);
    if (ids.length) await this.db.from('loss_report_runs').delete().in('id', ids);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
