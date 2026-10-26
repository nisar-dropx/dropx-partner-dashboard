import type { DigestControl } from '../portal-digest-delivery';

/** PostgREST bulk upserts require identical keys on every row. */
export function insightControlUpdates(controls: DigestControl[], legacy: DigestControl[], userId: string, updatedAt: string) {
  const updates = controls.every(control => control.state === 'enabled')
    ? [...controls, ...legacy.map(control => ({ ...control, state: 'disabled' }))]
    : controls;
  return updates.map(control => ({
    company_id: control.company_id,
    portal: control.portal,
    event_key: control.event_key,
    state: control.state,
    paused_until: control.paused_until ?? null,
    subject_template: control.subject_template ?? null,
    config: control.config,
    updated_by: userId,
    updated_at: updatedAt,
  }));
}
