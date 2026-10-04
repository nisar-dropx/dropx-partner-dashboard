/** Shared by the form and server: never trust a client-supplied pass/fail value. */
export type AuditOption = { value: string; label: string; issue: boolean; severity: string; photos: number; remarks: boolean; followUp: 'none' | 'planned' | 'immediate'; days: number };
export type AuditConfig = { kind: 'choice' | 'text' | 'number' | 'date'; options: AuditOption[]; fuels: string[]; documentType: string; unit: string };
export function normalizeAuditConfig(value: unknown): AuditConfig | null {
  if (!value || typeof value !== 'object' || !('kind' in value)) return null;
  const raw = value as Record<string, any>;
  if (!['choice','text','number','date'].includes(raw.kind)) throw new Error('Choose a supported response format.');
  const options: AuditOption[] = (Array.isArray(raw.options) ? raw.options : []).map((o: any) => ({ value: String(o.value ?? '').trim(), label: String(o.label ?? '').trim(), issue: Boolean(o.issue) || ['planned','immediate'].includes(o.followUp), severity: ['low','medium','high','critical'].includes(o.severity) ? o.severity : 'medium', photos: Math.max(0, Math.min(6, Math.floor(Number(o.photos) || 0))), remarks: Boolean(o.remarks), followUp: ['planned','immediate'].includes(o.followUp) ? o.followUp : 'none', days: Math.max(1, Math.min(365, Math.floor(Number(o.days) || 7))) }));
  if (raw.kind === 'choice' && (options.length < 2 || options.length > 15 || options.some(o => !o.value || !o.label) || new Set(options.map(o=>o.value)).size !== options.length)) throw new Error('Add 2–15 response options with unique values and labels.');
  return { kind: raw.kind, options, fuels: Array.isArray(raw.fuels) ? raw.fuels.map(String) : [], documentType: String(raw.documentType || ''), unit: String(raw.unit || '') };
}
export function auditApplies(config: AuditConfig | null | undefined, fuel: string) { return !config?.fuels.length || config.fuels.some(f => f.toLowerCase() === fuel.toLowerCase()); }
export function auditDueDate(today: string, days: number) { const date = new Date(`${today}T00:00:00Z`); date.setUTCDate(date.getUTCDate()+days); return date.toISOString().slice(0,10); }
export function evaluateAuditResponse(config: AuditConfig, value: string, comment: string, days: unknown, today: string, complete = true) {
  if (!value) return { passed: null, option: undefined, due: null };
  const option = config.options.find(o => o.value === value);
  if (config.kind === 'choice' && !option) throw new Error('Select one of the configured responses.');
  if (config.kind === 'number' && (!Number.isFinite(Number(value)) || Number(value) < 0)) throw new Error('Enter a valid non-negative number.');
  if (config.kind === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) !== value)) throw new Error('Enter a valid date.');
  if (complete && option?.remarks && !comment.trim()) throw new Error('Add a remark for this response.');
  let due: string | null = null;
  if (option?.followUp === 'immediate') due = today;
  if (option?.followUp === 'planned') {
    const n = Number(days);
    if (complete && (!Number.isInteger(n) || n < 1 || n > 365)) throw new Error('Enter follow-up days between 1 and 365.');
    if (Number.isInteger(n) && n >= 1 && n <= 365) due = auditDueDate(today, n);
  }
  return { passed: option ? !option.issue : null, option, due };
}
const choice = (label: string, issue = false, severity = 'medium', followUp: AuditOption['followUp'] = 'none', photos = 0): AuditOption => ({ value: label.toLowerCase().replace(/[^a-z0-9]+/g,'_'), label, issue, severity, followUp, photos, remarks: issue, days: 7 });
export const auditPresets: Record<string, AuditConfig> = {
  condition: { kind: 'choice', fuels: [], documentType: '', unit: '', options: [choice('Good'), choice('Average',false), choice('Poor',true,'high','planned',1), choice('Needs immediate replacement',true,'critical','immediate',1), choice('Unable to inspect',true,'medium','planned')] },
  working: { kind: 'choice', fuels: [], documentType: '', unit: '', options: [choice('Working'),choice('Partly working',true,'medium','planned',1),choice('Not working',true,'high','immediate',1),choice('Not tested',true,'medium','planned')] },
  safety: { kind: 'choice', fuels: [], documentType: '', unit: '', options: [choice('Normal'),choice('Concern noticed',true,'high','planned'),choice('Unsafe — inspection required',true,'critical','immediate'),choice('Not tested',true,'high','planned')] },
  documents: { kind: 'choice', fuels: [], documentType: '', unit: '', options: [choice('Available and valid'),choice('Expired',true,'high','immediate'),choice('Missing',true,'high','planned'),choice('Unable to verify',true,'medium','planned')] },
  driving: { kind: 'choice', fuels: [], documentType: '', unit: '', options: [choice('Satisfactory'),choice('Coaching needed',true,'medium','planned'),choice('Unsafe behaviour observed',true,'critical','immediate'),choice('Not observed',true,'medium','planned')] },
  readiness: { kind: 'choice', fuels: [], documentType: '', unit: '', options: [choice('Ready'),choice('Ready with follow-up',true,'medium','planned'),choice('Not ready for delivery',true,'critical','immediate')] }
};
