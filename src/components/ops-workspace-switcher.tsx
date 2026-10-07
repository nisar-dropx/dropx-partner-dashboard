'use client';
import { useState, type FormEvent } from 'react';
import { Store, Truck, Loader2 } from 'lucide-react';
import type { OperatingMode } from '@/lib/ops-pulse/operating-context';
import styles from './ops-workspace-switcher.module.css';

type Props = { modes: { code: OperatingMode; label: string }[]; mode: OperatingMode };
export function OpsWorkspaceSwitcher({ modes, mode }: Props) {
  const [switchingTo, setSwitchingTo] = useState<OperatingMode | null>(null);
  const [error, setError] = useState('');
  const pending = switchingTo !== null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const formData = new FormData(event.currentTarget);
    setError('');
    setSwitchingTo(formData.get('mode') as OperatingMode);
    try {
      const response = await fetch('/api/ops-pulse/workspace', { method: 'POST', body: formData });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not open workspace.');
      window.location.assign('/');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not open workspace. Please try again.');
      setSwitchingTo(null);
    }
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
    return <form onSubmit={submit} key={short}><input type="hidden" name="mode" value={entry!.code} /><button type="submit" aria-pressed={active} disabled={pending || active} title={label} className={active ? styles.active : ''}>{switching ? <Loader2 className={styles.spinner} size={17} /> : <Icon size={17} />}<span><b>{short}</b><small>{label}</small></span></button></form>;
  })}</div><span className={styles.status} role="status">{pending ? `Opening ${switchingTo === 'amazon_now' ? 'Dark Store' : 'Last Mile'}…` : error}</span></div>;
}
