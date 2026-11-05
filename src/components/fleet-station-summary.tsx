'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, MapPin, Phone, RefreshCw, Users } from 'lucide-react';
import type { FleetVehicleStatusDefinition, FleetControlVehicle } from '@/lib/fleet-control';
import { ownedStationGroups, stationMapUrl, type StationContact, type StationContacts } from '@/lib/fleet/station-summary';
import { FleetMultiSelect } from './fleet-multi-select';
import styles from './fleet-station-summary.module.css';

function ContactPhone({ phone }: { phone: string }) {
  const number = phone.replace(/[^+\d]/g, '');
  return number.length >= 7 ? <a href={`tel:${number}`}><Phone size={13} />{phone}</a> : <span className={styles.muted}>Phone not recorded</span>;
}
function Contacts({ contacts }: { contacts: StationContact[] }) {
  return <div className={styles.contacts}>{contacts.map(contact => <div key={contact.id}><strong>{contact.name}</strong><small>{contact.role}</small><ContactPhone phone={contact.phone} /></div>)}</div>;
}

export function FleetStationSummary({ vehicles, statuses }: { vehicles: FleetControlVehicle[]; statuses: FleetVehicleStatusDefinition[] }) {
  const [stations, setStations] = useState<StationContacts[]>([]);
  const [error, setError] = useState('');
  const [contactsError, setContactsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [regions, setRegions] = useState<string[]>([]);
  const [selectedStations, setSelectedStations] = useState<string[]>([]);
  const [sort, setSort] = useState('station');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    fetch('/api/fleet/station-contacts', { cache: 'no-store', signal: controller.signal }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to load contacts.');
      setStations(result.stations); setContactsError(result.contactsError || '');
    }).catch(reason => { if (!controller.signal.aborted) setError(reason.message || 'Unable to load contacts.'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);
  const groups = useMemo(() => ownedStationGroups(vehicles, statuses), [vehicles, statuses]);
  const byCode = useMemo(() => new Map(stations.map(s => [s.code, s])), [stations]);
  const rows = groups.map(group => ({ ...group, station: byCode.get(group.code) }));
  const regionOptions = [...new Set(stations.map(s => s.region || 'Unassigned region'))].sort().map(value => ({ value, label: value }));
  const visible = rows.filter(row => {
    const station = row.station;
    if (regions.length && !regions.includes(station?.region || 'Unassigned region')) return false;
    if (selectedStations.length && !selectedStations.includes(row.code)) return false;
    return `${row.code} ${station?.name || ''} ${station?.address || ''} ${station?.cluster || ''} ${Object.keys(row.models).join(' ')} ${station?.team.map(c => `${c.name} ${c.phone}`).join(' ') || ''}`.toLowerCase().includes(query.trim().toLowerCase());
  }).sort((a,b) => sort === 'vehicles' ? b.total-a.total || a.code.localeCompare(b.code) : a.code.localeCompare(b.code));
  const toggle = (code: string) => setExpanded(current => { const next = new Set(current); if (next.has(code)) next.delete(code); else next.add(code); return next; });
  return <section className={styles.workspace} aria-label="Owned vehicle summary and contacts">
    <div className={styles.filters}>
      <label>Search<input type="search" placeholder="Station, model or contact" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <FleetMultiSelect label="Region" allLabel="All regions" alwaysSearch values={regions} onChange={setRegions} options={regionOptions} />
      <FleetMultiSelect label="Station" allLabel="All owned-vehicle stations" alwaysSearch values={selectedStations} onChange={setSelectedStations} options={rows.map(row => ({ value: row.code, label: `${row.code} · ${row.station?.name || row.code}` }))} />
      <label>Sort<select value={sort} onChange={e => setSort(e.target.value)}><option value="station">Station A–Z</option><option value="vehicles">Most vehicles</option></select></label>
    </div>
    <div className={styles.toolbar}><div><strong>{visible.length} stations · {visible.reduce((sum,row) => sum + row.total, 0)} owned vehicles</strong><small>Current assigned fleet, including non-operational vehicles. Contacts follow current People assignments.</small></div><div><button type="button" onClick={() => { setQuery(''); setRegions([]); setSelectedStations([]); }}>Clear filters</button><button type="button" disabled={loading} onClick={() => setRevision(r => r + 1)}><RefreshCw size={14} />{loading ? 'Loading contacts…' : 'Refresh contacts'}</button></div></div>
    {error || contactsError ? <div className={styles.error} role="alert">{error || contactsError} <button type="button" onClick={() => setRevision(r => r + 1)}>Retry</button></div> : null}
    <div className={styles.scroll}><table className={styles.table}><thead><tr><th>Location</th><th>Vehicles</th><th>Vehicle models</th><th>Team lead</th><th>Station location</th><th>Team</th></tr></thead><tbody>
      {visible.map(row => {
        const station = row.station;
        const team = station?.team || [];
        const leads = team.filter(c => c.isTeamLead);
        const map = station ? stationMapUrl(station.latitude, station.longitude) : null;
        const open = expanded.has(row.code);
        return <Fragment key={row.code}><tr className={styles.summaryRow}>
          <td data-label="Location"><strong>{row.code}</strong><small>{station?.name || (loading ? 'Loading…' : 'Station name not recorded')}</small><small>{station?.region}{station?.cluster ? ` · ${station.cluster}` : ''}</small></td>
          <td data-label="Vehicles"><span className={styles.count}>{row.total}</span></td>
          <td data-label="Models"><div className={styles.models}>{Object.entries(row.models).sort(([a],[b]) => a.localeCompare(b)).map(([model,count]) => <span key={model}>{model} <b>×{count}</b></span>)}</div></td>
          <td data-label="Team lead">{leads.length ? <Contacts contacts={leads} /> : <span className={styles.muted}>{loading ? 'Loading…' : error || contactsError ? 'Contacts unavailable' : 'No TL mapped in People'}</span>}</td>
          <td data-label="Station location">{map ? <a href={map} target="_blank" rel="noopener noreferrer"><MapPin size={14} />{station!.latitude}, {station!.longitude}</a> : <span className={styles.muted}>{loading ? 'Loading…' : 'Coordinates not recorded'}</span>}<small className={styles.address}>{station?.address || (loading ? '' : 'Address not recorded')}</small></td>
          <td><button type="button" className={styles.expand} aria-expanded={open} aria-controls={`station-team-${row.code}`} onClick={() => toggle(row.code)}><Users size={15} />{open ? 'Hide' : 'View'} team {team.length ? `(${team.length})` : ''}<ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : undefined }} /></button></td>
        </tr>{open ? <tr id={`station-team-${row.code}`}><td colSpan={6} className={styles.detail}><strong>{row.code} · Station team</strong><p>{station?.address || 'Address not recorded'}</p>{team.length ? <Contacts contacts={team} /> : <p>{loading ? 'Loading contacts…' : error || contactsError ? 'Contacts are temporarily unavailable. Use Retry above.' : 'No active team members mapped to this station in People.'}</p>}</td></tr> : null}</Fragment>;
      })}
    </tbody></table></div>
    {!visible.length ? <div className={styles.empty}>No owned-vehicle stations match this selection.</div> : null}
  </section>;
}
