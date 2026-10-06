import {switchOperatingContext} from '@/app/ops-pulse/actions';
import type {OperatingMode} from '@/lib/ops-pulse/operating-context';
export function OpsWorkspaceSwitcher({modes,mode}:{modes:{code:OperatingMode;label:string}[];mode:OperatingMode}){
 const lm=modes.find(m=>m.code===mode&&m.code!=='amazon_now')||modes.find(m=>m.code!=='amazon_now'),ds=modes.find(m=>m.code==='amazon_now');
 return <div style={{display:'flex',gap:6,padding:'8px 4px 14px'}} aria-label="Business workspace">{[[lm,'LM','Last Mile'],[ds,'DS','Dark Store']].map(([entry,short,label])=>{const m=entry as typeof lm;if(!m)return null;const active=(mode==='amazon_now')===(m.code==='amazon_now');return <form key={String(short)} action={switchOperatingContext} style={{flex:1}}><input type="hidden" name="mode" value={m.code}/><button aria-pressed={active} title={String(label)} style={{width:'100%',minHeight:46,borderRadius:10,background:active?'#202b43':'#f3f6fa',color:active?'white':'#30415f',border:'1px solid #dfe5ee'}}><b>{String(short)}</b><small style={{display:'block',fontSize:10}}>{String(label)}</small></button></form>})}</div>;
}
