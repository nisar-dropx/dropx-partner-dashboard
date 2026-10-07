'use client';
import { useState } from 'react';
import { Store, Truck, Loader2 } from 'lucide-react';
import { switchOperatingContext } from '@/app/ops-pulse/actions';
import type { OperatingMode } from '@/lib/ops-pulse/operating-context';
import styles from './ops-workspace-switcher.module.css';

type Props = { modes: { code: OperatingMode; label: string }[]; mode: OperatingMode };
export function OpsWorkspaceSwitcher({ modes, mode }: Props) {
  const [switchingTo, setSwitchingTo] = useState<OperatingMode | null>(null);
  const pending = switchingTo !== null;
  async function submit(formData: FormData) {
    setSwitchingTo(formData.get('mode') as OperatingMode);
    try { await switchOperatingContext(formData); }
    finally { setSwitchingTo(null); }
  }
  const lm = modes.find(m => m.code === mode && m.code !== 'amazon_now') || modes.find(m => m.code !== 'amazon_now');
  const ds = modes.find(m => m.code === 'amazon_now');
  const entries = [{ entry: lm, short: 'LM', label: 'Last Mile', Icon: Truck }, { entry: ds, short: 'DS', label: 'Dark Store', Icon: Store }].filter(item => item.entry);
  if (entries.length === 1) {
    const item = entries[0];
    return <div className={styles.single}><item.Icon size={18} /><div><small>WORKSPACE</small><strong>{item.label}</strong></div><span>{item.short}</span></div>;
  }
  return <div className={styles.form}><div className={styles.switcher} aria-label="Business workspace" aria-busy={pending}>{entries.map(({ entry, short, label, Icon }) => {
    const active = (mode === 'amazon_now') === (entry!.code === 'amazon_now');
    const switching = switchingTo === entry!.code;
    // Persist the choice as a form field: a disabled submitter is not a reliable payload.
    return <form action={submit} key={short}><input type="hidden" name="mode" value={entry!.code} /><button type="submit" aria-pressed={active} disabled={pending || active} title={label} className={active ? styles.active : ''}>{switching ? <Loader2 className={styles.spinner} size={17} /> : <Icon size={17} />}<span><b>{short}</b><small>{label}</small></span></button></form>;
  })}</div><span className={styles.status} role="status">{pending ? `Opening ${switchingTo === 'amazon_now' ? 'Dark Store' : 'Last Mile'}…` : ''}</span></div>;
}
