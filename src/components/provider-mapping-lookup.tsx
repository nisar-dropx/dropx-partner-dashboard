"use client";
import { useDeferredValue, useMemo, useState } from 'react';
import { PaymentAllocationHistoryButton } from '@/components/payment-allocation-history-button';
import { paymentAllocationDisplayStatus } from '@/lib/payment-allocation-history';
import { mappingLookupToday, filterProviderMappingLookup, type ProviderMappingLookupEntry } from '@/lib/provider-mapping-lookup';

export function ProviderMappingLookup({ entries, onShowMapping }: { entries: ProviderMappingLookupEntry[]; onShowMapping: (stationId: string, providerId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [station, setStation] = useState('');
  const [history, setHistory] = useState(false);
  const deferred = useDeferredValue(query);
  const locations = useMemo(() => [...new Map(entries.filter(item => item.stationId).map(item => [item.stationId, item.stationLabel])).entries()].sort((a,b) => a[1].localeCompare(b[1])), [entries]);
  const results = useMemo(() => filterProviderMappingLookup(entries, deferred, station, history), [entries, deferred, station, history]);
  return <section className="panel provider-mapping-lookup">
    <div className="panel-head"><div><h2>Find an existing mapping</h2><p className="subtle">Search an employee, DropX ID or provider ID across all months in your permitted locations.</p></div><button className="button secondary compact" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Close lookup' : 'Find mapping'}</button></div>
    {open ? <div className="panel-body">
      <div className="mapping-lookup-controls"><label>Employee / provider ID or name<input type="search" placeholder="Search employee, DropX ID or provider ID" value={query} onChange={event => setQuery(event.target.value)} /></label><label>Mapping location<select value={station} onChange={event => setStation(event.target.value)}><option value="">All permitted locations</option>{locations.map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label><label className="mapping-lookup-history"><input type="checkbox" checked={history} onChange={event => setHistory(event.target.checked)} />Include ended / cancelled mappings</label></div>
      {!query.trim() ? <p className="subtle">Already mapped people are searchable here even when they are hidden from the assignment dropdown.</p> : <><p role="status" className="subtle">{results.length} results{results.length > 100 ? ' · Showing first 100; narrow your search' : ''}</p><div className="mapping-lookup-results">{results.slice(0,100).map(entry => <article key={entry.key} className="mapping-lookup-result">
        <div><strong>{entry.dropxId || 'No associate assigned'}{entry.fullName ? ` · ${entry.fullName}` : ''}</strong><div className="subtle">Workforce location: {entry.profileLocationLabel || 'Not recorded'}</div></div>
        <div><strong>{entry.providerMemberId ? `Provider ID ${entry.providerMemberId}` : entry.restrictedMapping ? 'Mapped outside your permitted locations' : 'Not currently mapped'}</strong><div>{entry.providerMemberName}</div><div className="subtle">{entry.stationLabel}</div></div>
        <div>{entry.history.map(item => <div key={item.id}><span className={`status-pill ${item.storedStatus === 'active' && !item.effectiveTo ? 'good' : ''}`}>{paymentAllocationDisplayStatus(item,mappingLookupToday())}</span><div className="subtle">{item.effectiveFrom} → {item.effectiveTo || 'Ongoing'}</div></div>)}</div>
        <div className="mapping-lookup-actions">{entry.history.length ? <PaymentAllocationHistoryButton loadMappingAudit entries={entry.history} subjectLabel={`${entry.dropxId} · ${entry.providerMemberId}`} /> : null}{entry.providerMemberId ? <button type="button" className="button secondary compact" onClick={() => onShowMapping(entry.stationId, entry.providerMemberId)}>Show in worksheet</button> : null}</div>
      </article>)}</div>{!results.length ? <p>No matching mapping in your permitted locations. Try including history or contact an administrator to check other locations.</p> : null}</>}
    </div> : null}
  </section>;
}
