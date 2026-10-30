import { LOSS_EXCEPTION_LABELS, type LossExceptionKind } from './loss-exceptions';
import { hasFinalLossOutcome } from './loss-recovery-controls';
import { isRecoverable, type NlCase } from './nl-loss-policy';

export type ExceptionUpdate = { month: string; case_key: string; station: string; kind: LossExceptionKind; enabled: boolean; version: number; reason: string };
export const exceptionKey = (r: {month: string; case_key: string}, kind?: string) => `${r.month}|${r.case_key}${kind ? `|${kind}` : ''}`;
export function canEnableException(r: NlCase, statuses: string[]) {
  return r.source_present && (r.report === 'slp' ? !!r.final_seen_at : r.report === 'station' ? r.source_status === 'Approved' :
    isRecoverable(r.source_status, statuses) && hasFinalLossOutcome(true, r.source_status, r.details?.case_status, r.details?.extra?.current_sla_stage));
}
/** Keep IDs as text. Never guess or silently repair an uploaded shipment identifier. */
export function parseExceptionBatch(input: Record<string, string>[], rows: NlCase[], statuses: string[], current: (r: NlCase, k: LossExceptionKind) => {version: number; enabled: boolean} | undefined): ExceptionUpdate[] {
  if (!input.length || input.length > 100) throw Error('Provide 1–100 exception updates.');
  const seen = new Set<string>();
  return input.map((v, i) => {
    const month = String(v['Loss month'] || '').trim(), id = String(v['Shipment ID'] || '').trim(), station = String(v.Station || '').trim().toUpperCase();
    const kind = (Object.keys(LOSS_EXCEPTION_LABELS) as LossExceptionKind[]).find(k => LOSS_EXCEPTION_LABELS[k].toLowerCase() === String(v.Exception || '').trim().toLowerCase());
    const action = String(v.Action || '').trim().toLowerCase(), reason = String(v.Reason || '').trim();
    if (!kind || !['enable', 'disable'].includes(action) || reason.length > 2000) throw Error(`Row ${i + 2}: use a listed exception, Enable/Disable and a note of up to 2,000 characters.`);
    const matches = rows.filter(r => r.month === month && (r.case_key === id || r.details?.tid === id) && r.station_code.toUpperCase() === station);
    if (matches.length !== 1) throw Error(`Row ${i + 2}: Shipment ID, station and loss month must match one case in your access.`);
    const r = matches[0], key = exceptionKey(r, kind), state = current(r, kind), enabled = action === 'enable';
    if (enabled && !canEnableException(r, statuses)) throw Error(`Row ${i + 2}: only final recoverable shipments can be enabled.`);
    if (seen.has(key)) throw Error(`Row ${i + 2}: duplicate shipment and exception.`);
    seen.add(key);
    return {month, case_key: r.case_key, station, kind, enabled, version: state?.version || 0, reason};
  });
}
