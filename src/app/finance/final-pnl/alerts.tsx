'use client';
import {useId,useRef} from 'react';

export function PnlAlerts({issues,label='P&L'}:{issues:string[];label?:string}){
 const dialog=useRef<HTMLDialogElement>(null),button=useRef<HTMLButtonElement>(null),id=useId();
 const unique=[...new Set(issues.filter(Boolean))];
 if(!unique.length)return <span className="fp-alert-clear">No alerts</span>;
 return <><button ref={button} type="button" className="fp-alert-button" aria-label={`${label}: ${unique.length} alerts`} aria-haspopup="dialog" onClick={()=>dialog.current?.showModal()}><span aria-hidden="true">⚠</span> {unique.length} alert{unique.length===1?'':'s'}</button>
 <dialog ref={dialog} className="fp-alert-dialog" aria-labelledby={id} onClose={()=>button.current?.focus()}><div className="fp-section-head"><h2 id={id}>{label} · alerts</h2><button type="button" autoFocus onClick={()=>dialog.current?.close()}>Close alerts</button></div><p>The current P&L includes all recorded amounts and allocated HO. These items may change it when resolved.</p><ul>{unique.map(issue=><li key={issue}>{issue}</li>)}</ul></dialog></>;
}
