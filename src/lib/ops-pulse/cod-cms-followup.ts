import { classifyRemittance, codStatusChecks, type CodStatusSnapshot } from './cod-status.ts';
import type { PickupPolicy } from './cod-pickup';

export type CodCmsContact = {
  agency: string | null;
  name: string | null;
  phone: string | null;
  escalationContact: string | null;
  escalationEmails: string[];
};

/** Project only operational contacts, never portal credentials, to the client. */
export function codCmsContact(row?: {
  cms_agency?: string | null; agent_name?: string | null; agent_mobile?: string | null;
  escalation_contact?: string | null; escalation_email?: string | null;
}): CodCmsContact {
  const clean = (value?: string | null) => value?.trim() || null;
  return {
    agency: clean(row?.cms_agency), name: clean(row?.agent_name), phone: clean(row?.agent_mobile),
    escalationContact: clean(row?.escalation_contact),
    escalationEmails: [...new Set((row?.escalation_email || '').split(/[,;]+/).map(email=>email.trim()).filter(Boolean))],
  };
}

/** Only verified overdue pickups need CMS follow-up. Other timing alerts (such
 * as early next-day preparation) are operational review, not missed pickups. */
export function overdueCodRemittances(snapshot: CodStatusSnapshot | undefined, policy: PickupPolicy | null, now: Date, failed: boolean, maxAgeMinutes: number | null) {
  if (codStatusChecks(snapshot, policy, now, failed, '', null, maxAgeMinutes).remittances.tone !== 'attention') return [];
  const data = snapshot?.remittances.data;
  return (data?.rows || []).map(row=>classifyRemittance(row, data?.latestSubmitted || null, policy, now))
    .filter(check=>check.tone === 'attention' && check.dueAt !== undefined && now.getTime() > check.dueAt);
}
