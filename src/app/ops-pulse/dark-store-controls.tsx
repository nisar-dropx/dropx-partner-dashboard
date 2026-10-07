'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowRight, Check, CheckCircle2, ChevronDown, Loader2, RefreshCw, Search, X } from 'lucide-react';
import styles from './dark-store-home.module.css';

type StoreOption = { code: string; name: string; city: string };

export function DarkStoreFilters({ stores, station, city, month, maxMonth }: {
  stores: StoreOption[]; station: string; city: string; month: string; maxMonth: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState(station);
  const [selectedCity, setCity] = useState(city);
  const [selectedMonth, setMonth] = useState(month);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const cities = Array.from(new Set(stores.map(s => s.city).filter(Boolean))).sort();
  const cityStores = stores.filter(s => !selectedCity || s.city === selectedCity);
  const filtered = cityStores.filter(s => `${s.code} ${s.name} ${s.city}`.toLowerCase().includes(query.trim().toLowerCase()));
  const options = [{ code: '', name: selectedCity ? `All stores in ${selectedCity}` : 'All my dark stores', city: `${cityStores.length} authorized stores` }, ...filtered];
  const selectedStore = stores.find(s => s.code === selected);

  function choose(code: string) {
    setSelected(code); setOpen(false); setQuery(''); trigger.current?.focus();
  }
  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted(i => (i + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault(); choose(options[Math.min(highlighted, options.length - 1)].code);
    } else if (event.key === 'Escape') {
      event.preventDefault(); setOpen(false); trigger.current?.focus();
    }
  }
  function apply(event: FormEvent) {
    event.preventDefault(); setOpen(false);
    const params = new URLSearchParams({ month: selectedMonth });
    if (selected) params.set('station', selected);
    if (selectedCity) params.set('city', selectedCity);
    startTransition(() => router.push(`/ops-pulse?${params}`));
  }
  function reset() {
    setSelected(''); setCity(''); setMonth(maxMonth); setQuery(''); setOpen(false);
    startTransition(() => router.push('/ops-pulse'));
  }

  return <form className={styles.filters} onSubmit={apply} aria-label="Filter dark stores" aria-busy={pending}>
    <div className={styles.storePicker} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
      <span id={`${listId}-label`} className={styles.fieldLabel}>Find a store</span>
      <button ref={trigger} className={styles.storeTrigger} type="button" aria-labelledby={`${listId}-label ${listId}-value`} disabled={pending} aria-expanded={open} aria-controls={listId} aria-haspopup="listbox" onClick={() => { setOpen(!open); setQuery(''); setHighlighted(0); }}>
        <Search size={17} aria-hidden="true" /><span id={`${listId}-value`}>{selectedStore ? `${selectedStore.code} · ${selectedStore.name}` : selectedCity ? `All stores in ${selectedCity}` : 'All my dark stores'}</span><ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && <div className={styles.storeMenu}>
        <div className={styles.searchField}><Search size={16} aria-hidden="true" /><input autoFocus role="combobox" aria-label="Search stores by code, name or city" aria-autocomplete="list" aria-expanded="true" aria-controls={listId} aria-activedescendant={`${listId}-${Math.min(highlighted, options.length - 1)}`} value={query} placeholder="Code, store name or city…" onChange={e => { setQuery(e.target.value); setHighlighted(0); }} onKeyDown={onSearchKey} />{query && <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); setHighlighted(0); }}><X size={14} /></button>}</div>
        <div id={listId} role="listbox" aria-label="Authorized dark stores" className={styles.storeOptions}>
          {options.map((s, i) => <button key={s.code} id={`${listId}-${i}`} type="button" role="option" aria-selected={selected === s.code} tabIndex={-1} data-highlighted={i === highlighted} onMouseDown={e => e.preventDefault()} onClick={() => choose(s.code)}><span><b>{s.code || s.name}</b>{s.code && <span>{s.name}</span>}<small>{s.city}</small></span>{selected === s.code && <Check size={16} aria-hidden="true" />}</button>)}
          {query && !filtered.length && <p className={styles.noResults}>No matching stores. Try a code, name or city.</p>}
        </div>
      </div>}
    </div>
    <label className={styles.cityField}>City<select disabled={pending} value={selectedCity} onChange={e => { setCity(e.target.value); if (selectedStore && e.target.value && selectedStore.city !== e.target.value) setSelected(''); }}><option value="">All cities</option>{cities.map(c => <option key={c}>{c}</option>)}</select></label>
    <label className={styles.monthField}>Unit reporting month<input disabled={pending} type="month" required value={selectedMonth} max={maxMonth} onChange={e => setMonth(e.target.value)} /></label>
    <button className={styles.apply} type="submit" disabled={pending}>{pending ? <Loader2 size={15} className={styles.spinning} /> : null}{pending ? 'Updating…' : 'Apply filters'}</button>
    {(station || city || month !== maxMonth) && <button className={styles.reset} type="button" disabled={pending} onClick={reset}>Reset</button>}
    <span className={styles.filterStatus} role="status">{pending ? 'Updating your store view' : ''}</span>
  </form>;
}

export function DarkStoreRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <button className={styles.refresh} type="button" onClick={() => startTransition(() => router.refresh())} disabled={pending} aria-label="Refresh command center"><RefreshCw size={16} className={pending ? styles.spinning : ''} />{pending ? 'Refreshing…' : 'Refresh'}</button>;
}

export type StoreAction = { key: string; category: 'units' | 'attendance' | 'roster'; title: string; detail: string; label: string; href: string };
const actionTabs = [{ key: 'all', label: 'All actions' }, { key: 'units', label: 'Unit reports' }, { key: 'attendance', label: 'Attendance' }, { key: 'roster', label: 'Rostering' }] as const;

export function DarkStoreActions({ actions, unavailable }: { actions: StoreAction[]; unavailable: boolean }) {
  const [category, setCategory] = useState<string>('all');
  const [showAll, setShowAll] = useState(false);
  const matching = actions.filter(a => category === 'all' || a.category === category);
  const visible = showAll ? matching : matching.slice(0, 4);
  return <section className={styles.panel} aria-label="Store action items">
    <header><div><p className={styles.eyebrow}>YOUR NEXT STEPS</p><h2>Needs attention <span className={styles.counter}>{actions.length}</span></h2></div><span className={styles.muted}>Across stores in view</span></header>
    {!!actions.length && <div className={styles.actionTabs} role="group" aria-label="Filter action items">{actionTabs.filter(t => t.key === 'all' || actions.some(a => a.category === t.key)).map(t => <button key={t.key} type="button" aria-pressed={category === t.key} onClick={() => { setCategory(t.key); setShowAll(false); }}>{t.label}<span>{t.key === 'all' ? actions.length : actions.filter(a => a.category === t.key).length}</span></button>)}</div>}
    <div className={styles.actionList}>{visible.length ? visible.map(action => <article key={action.key}><span className={styles.actionDot} /><div><h3>{action.title}</h3><p>{action.detail}</p><Link href={action.href}>{action.label} <ArrowRight size={14} /></Link></div></article>) : <div className={styles.empty}><CheckCircle2 size={28} /><h3>{unavailable ? 'Waiting for source data' : 'You’re up to date'}</h3><p>{unavailable ? 'Refresh to check the latest status.' : 'No open actions in the available store records.'}</p></div>}</div>
    {matching.length > 4 && <button type="button" className={styles.showMore} onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer actions' : `View all ${matching.length} actions`}<ChevronDown size={15} style={showAll ? { transform: 'rotate(180deg)' } : undefined} /></button>}
  </section>;
}
