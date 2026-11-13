"use client";
import { useState } from 'react';
import { lscTicketError, type LscTicketDetails } from '@/lib/ops-pulse/loss-lsc-ticket';
import styles from './nl-loss.module.css';
import editor from './loss-case-response.module.css';

export function LossLscTicketBatch({count, busy, onSave, onCancel}: {
  count: number; busy: boolean;
  onSave: (details: LscTicketDetails) => void;
  onCancel: () => void;
}) {
  const [details, setDetails] = useState<LscTicketDetails>({tt_reference:'',tt_url:'',followup_on:'',note:''});
  const error = lscTicketError(details);
  return <form className={editor.editor} onSubmit={event=>{event.preventDefault();if(!busy&&!error)onSave(details);}}>
    <strong>Record one LSC ticket for {count} selected shipments</strong>
    <fieldset disabled={busy} style={{border:0,padding:0,margin:0}}>
      <div className={editor.grid}>
        <label>LSC ticket ID<input required minLength={3} maxLength={160} value={details.tt_reference} onChange={e=>setDetails(d=>({...d,tt_reference:e.target.value}))}/></label>
        <label>Ticket link (optional)<input type="url" maxLength={2000} value={details.tt_url} onChange={e=>setDetails(d=>({...d,tt_url:e.target.value}))}/></label>
        <label>Next follow-up<input type="date" required value={details.followup_on} onChange={e=>setDetails(d=>({...d,followup_on:e.target.value}))}/></label>
        <label>Update note<input required minLength={10} maxLength={4000} value={details.note} onChange={e=>setDetails(d=>({...d,note:e.target.value}))}/></label>
      </div>
    </fieldset>
    {error && Object.values(details).some(value=>value.trim()) ? <small role="status">{error}</small> : null}
    <div className={styles.toolbar}>
      <button className={styles.primary} disabled={busy||!!error}>{busy?'Saving…':'Save ticket for selected TIDs'}</button>
      <button type="button" className={styles.button} disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}
