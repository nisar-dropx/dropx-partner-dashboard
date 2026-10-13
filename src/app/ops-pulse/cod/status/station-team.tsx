'use client';
import { useEffect, useRef, useState } from 'react';
import { Phone, Users, X } from 'lucide-react';
import type { CodStatusLocation } from '@/lib/ops-pulse/cod-status';
import type { CodStationTeam } from '@/lib/ops-pulse/cod-station-team-core';
import styles from './status.module.css';
export function StationTeam({location,onClose}:{location:CodStatusLocation;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [data,setData]=useState<CodStationTeam|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{dialog.current?.showModal();return()=>dialog.current?.close();},[]);
  useEffect(()=>{
    const controller=new AbortController();setData(null);setError('');
    fetch(`/api/ops-pulse/cod/station-team?location=${encodeURIComponent(location.id)}`,{cache:'no-store',signal:controller.signal}).then(async response=>{const json=await response.json();if(!response.ok)throw Error(json.error || 'Unable to load team.');return json;}).then(setData).catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return()=>controller.abort();
  },[location.id,retry]);
  return <dialog ref={dialog} className={styles.teamDialog} aria-labelledby="station-team-title" onCancel={onClose} onClick={e=>{if(e.target===dialog.current)onClose();}}>
    <header><div><small>PEOPLE · STATION TEAM</small><h2 id="station-team-title">{location.code} <span>{location.name}</span></h2></div><button autoFocus type="button" aria-label="Close station team" onClick={onClose}><X size={20}/></button></header>
    <div className={styles.teamBody}>{error?<div role="alert"><p>{error}</p><button type="button" onClick={()=>setRetry(n=>n+1)}>Retry team details</button></div>:!data?<p role="status">Loading People contacts and shifts…</p>:<>
      <div className={styles.teamIntro}><Users size={17}/><span>{data.people.length} active team members · Shifts for {data.asOf} · IST</span></div>
      <div className={styles.teamList}>{data.people.map(person=><article key={person.personId}><div><span className={person.manager?styles.managerBadge:styles.roleBadge}>{person.role}</span><strong>{person.name}</strong>{person.phone?<a href={`tel:${person.phone.replace(/[^+\d]/g,'')}`}><Phone size={13}/>{person.phone}</a>:<small>Contact not added in People</small>}</div><div className={styles.teamShift}><small>Today’s shift</small><span>{person.shift}</span></div></article>)}</div>
      {!data.people.length && <p>No active People team members are mapped to this station.</p>}
      <p className={styles.note}>Contacts and roles follow active People assignments. Shifts follow approved rosters for today. Missing details can be updated in People or Rostering.</p>
    </>}</div>
  </dialog>;
}
