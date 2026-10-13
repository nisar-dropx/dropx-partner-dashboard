import { Mail, Phone } from 'lucide-react';
import type { CodCmsContact } from '@/lib/ops-pulse/cod-cms-followup';
import styles from './status.module.css';

export function CmsFollowUp({ station, contact }: { station: string; contact?: CodCmsContact }) {
  const dial = contact?.phone?.replace(/[^+\d]/g, '');
  return <aside className={styles.cmsFollowUp} aria-label={`${station} overdue pickup contacts`}>
    <strong>CMS follow-up</strong>
    <span>{contact?.agency || 'CMS agency not added'} · {contact?.name || 'Pickup person not added'}</span>
    {dial ? <a href={`tel:${dial}`} aria-label={`Call ${contact?.name || station+' CMS'} at ${contact?.phone}`}><Phone size={12} aria-hidden="true"/>{contact?.phone}</a> : <small>Pickup phone not added in COD Pickup Master.</small>}
    {contact?.escalationContact && <span><b>Escalation contact:</b> {contact.escalationContact}</span>}
    {!!contact?.escalationEmails.length && <div className={styles.cmsEmails}><small>Escalation email</small>{contact.escalationEmails.map(email=><a key={email} href={`mailto:${encodeURIComponent(email)}`}><Mail size={12} aria-hidden="true"/>{email}</a>)}</div>}
  </aside>;
}
