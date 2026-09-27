"use client";
import {useMemo,useState,type FormEvent} from "react";
import Link from "next/link";
import {buildTemplatePayload,bodyVariables,templateLanguages,type TemplateDraft} from "@/lib/whatsapp-template-builder";
import {refreshTemplateLibrary,submitWhatsAppTemplate,type TemplateRow,type SenderRow} from "@/app/settings/whatsapp-template-actions";
import styles from "./whatsapp-template-manager.module.css";

const blank:TemplateDraft={name:"",language:"en",category:"UTILITY",body:"",header:"",footer:"",samples:{},buttonText:"",buttonUrl:""};
export function WhatsAppTemplateManager({profiles,templates:initial,canEdit,sendPath}:{profiles:SenderRow[];templates:TemplateRow[];canEdit:boolean;sendPath:string}){
  const [templates,setTemplates]=useState(initial);
  const [profileId,setProfileId]=useState(profiles.find(p=>p.is_default)?.id||profiles[0]?.id||"");
  const [search,setSearch]=useState("");
  const [status,setStatus]=useState("");
  const [creating,setCreating]=useState(false);
  const [draft,setDraft]=useState<TemplateDraft>(blank);
  const [confirm,setConfirm]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const variables=bodyVariables(draft.body);
  const visible=useMemo(()=>templates.filter(t=>t.whatsapp_profile_id===profileId&&(!status||t.status===status)&&[t.name,t.language,t.category].join(" ").toLowerCase().includes(search.toLowerCase())),[templates,profileId,status,search]);
  const selectedSender=profiles.find(p=>p.id===profileId);
  function change<K extends keyof TemplateDraft>(key:K,value:TemplateDraft[K]){setDraft(d=>({...d,[key]:value}));setConfirm(false);}
  async function refresh(){
    setBusy(true);setError("");setNotice("");
    try{
      const result=await refreshTemplateLibrary(profileId);
      if(result.error) setError(result.error);
      if(result.templates) setTemplates(old=>[...old.filter(t=>t.whatsapp_profile_id!==profileId),...result.templates!]);
      if(result.notice)setNotice(result.notice);
    }catch{setError("Could not refresh. Check your connection and template-management access.");}
    finally{setBusy(false);}
  }
  function review(event:FormEvent){event.preventDefault();setError("");try{buildTemplatePayload(draft);setConfirm(true);}catch(e){setError(e instanceof Error?e.message:"Check the template.");}}
  async function submit(){
    setBusy(true);setError("");setNotice("");
    try{
      const result=await submitWhatsAppTemplate(profileId,draft);
      if(result.error){setError(result.error);setConfirm(false);}
      if(result.template){setTemplates(old=>[result.template!,...old.filter(t=>t.template_id!==result.template!.template_id)]);setDraft(blank);setCreating(false);setConfirm(false);}
      if(result.notice)setNotice(result.notice);
    }catch{setError("Submission could not be confirmed. Refresh status before trying again.");setConfirm(false);}
    finally{setBusy(false);}
  }
  function duplicate(row:TemplateRow){
    const body=row.components.find(c=>c.type==="BODY")?.text||"";
    const header=row.components.find(c=>c.type==="HEADER");
    const button=row.components.find(c=>c.type==="BUTTONS")?.buttons?.find(b=>b.url&&!b.url.includes("{{"));
    setDraft({...blank,name:row.name.slice(0,490)+"_copy",language:row.language,category:row.category==="MARKETING"?"MARKETING":"UTILITY",body,header:header?.format==="TEXT"?header.text||"":"",footer:row.components.find(c=>c.type==="FOOTER")?.text||"",buttonText:button?.text||"",buttonUrl:button?.url||""});
    setConfirm(false);setCreating(true);setError("");setNotice("Copied as a new text template. Add fictional examples and review before submitting. Existing templates are unchanged.");
  }
  const preview=draft.body.replace(/\{\{(\d+)\}\}/g,(match,n)=>draft.samples[n]||match);
  return <div>
    <nav className={styles.toolbar} aria-label="WhatsApp workspace">
      <Link className="button secondary" href={sendPath}>Send messages</Link>
      <span className="button secondary" aria-current="page">Templates</span>
      <Link className="button secondary" href={sendPath+"?history=1"}>History</Link>
    </nav>
    <section className={"panel "+styles.panel}>
      <div className={styles.toolbar}>
        <label>Sender<select aria-label="Template sender" className="select" disabled={busy||creating} value={profileId} onChange={e=>{setProfileId(e.target.value);setError("");setNotice("");}}>{!profiles.length?<option value="">No active sender</option>:profiles.map(p=><option key={p.id} value={p.id}>{p.profile_name}</option>)}</select></label>
        <label>Search<input className="field" placeholder="Template name or language" value={search} onChange={e=>setSearch(e.target.value)}/></label>
        <label>Status<select className="select" value={status} onChange={e=>setStatus(e.target.value)}><option value="">All statuses</option>{["APPROVED","PENDING","REJECTED","PAUSED","DISABLED","DELETED"].map(s=><option key={s}>{s}</option>)}</select></label>
        <button type="button" className="button secondary" disabled={!canEdit||!profileId||busy} onClick={refresh}>{busy?"Working…":"Refresh status"}</button>
        <button type="button" className="button" disabled={!canEdit||!profileId||busy||creating} onClick={()=>{setDraft(blank);setCreating(true);setConfirm(false);setError("");setNotice("");}}>Create template</button>
      </div>
      {!canEdit?<p className={styles.help}>Read only. Template changes require your existing settings-edit permission.</p>:null}
      {error?<div role="alert" className={styles.notice+" "+styles.error}>{error}</div>:null}
      {notice?<div role="status" className={styles.notice}>{notice}</div>:null}
      {creating?<form onSubmit={review}>
        <div className={styles.heading}><h2>New template</h2><button type="button" className="button secondary compact" disabled={busy} onClick={()=>{setCreating(false);setConfirm(false);setError("");}}>Cancel</button></div>
        <div className={styles.layout}>
          <fieldset disabled={busy||confirm} style={{border:0,padding:0,margin:0,minWidth:0}}>
            <div className={styles.fields}>
              <label>Template name<input className="field" required value={draft.name} onChange={e=>change("name",e.target.value)} placeholder="station_update" maxLength={512}/></label>
              <label>Language<select className="select" value={draft.language} onChange={e=>change("language",e.target.value)}>{templateLanguages.map(([code,label])=><option key={code} value={code}>{label}</option>)}</select></label>
              <label>Category<select className="select" value={draft.category} onChange={e=>change("category",e.target.value)}><option value="UTILITY">Utility · specific service updates</option><option value="MARKETING">Marketing · offers and announcements</option></select></label>
              <label>Header · optional<input className="field" value={draft.header} onChange={e=>change("header",e.target.value)} maxLength={60}/></label>
              <label className={styles.wide}>Message<textarea className="field" rows={5} required maxLength={1024} placeholder="Hello {{1}}, your station update is ready. Open DropX One for details." value={draft.body} onChange={e=>change("body",e.target.value)}/><span className={styles.help}>{draft.body.length}/1,024 · Use {"{{1}}"}, {"{{2}}"} for values that change per associate.</span></label>
              {variables.map(n=><label key={n}>Example for {"{{"+n+"}}"}<input className="field" required maxLength={200} placeholder={n===1?"Example Associate":"Fictional example"} value={draft.samples[String(n)]||""} onChange={e=>change("samples",{...draft.samples,[n]:e.target.value})}/></label>)}
              <label className={styles.wide}>Footer · optional<input className="field" maxLength={60} value={draft.footer} onChange={e=>change("footer",e.target.value)}/></label>
              <label>Button label · optional<input className="field" maxLength={25} value={draft.buttonText} onChange={e=>change("buttonText",e.target.value)} placeholder="Open DropX One"/></label>
              <label>Button URL<input className="field" type="url" value={draft.buttonUrl} onChange={e=>change("buttonUrl",e.target.value)} placeholder="https://one.dropxlogistics.com"/></label>
            </div>
            <p className={styles.help}>Use fictional sample values—Meta receives these for review. This builder creates text templates; existing media templates remain available in Send messages. Meta may change the category or reject a template.</p>
          </fieldset>
          <aside className={styles.preview} aria-label="Message preview">
            <p className={styles.help}>Preview · {selectedSender?.profile_name}</p>
            <div className={styles.bubble}>{draft.header?<strong>{draft.header}<br/><br/></strong>:null}{preview||"Your message preview appears here."}{draft.footer?<footer>{draft.footer}</footer>:null}{draft.buttonText?<span className={styles.previewButton}>{draft.buttonText}</span>:null}</div>
          </aside>
        </div>
        {confirm?<div className={styles.notice}>Submit <strong>{draft.name}</strong> to Meta for <strong>{selectedSender?.profile_name}</strong>? This creates a real template; it does not message anyone.</div>:null}
        <div className={styles.actions}>{confirm?<><button type="button" className="button secondary" disabled={busy} onClick={()=>setConfirm(false)}>Back to edit</button><button type="button" className="button" disabled={busy} onClick={submit}>{busy?"Submitting…":"Confirm submission"}</button></>:<button className="button" disabled={busy} type="submit">Review submission</button>}</div>
      </form>:<div className={styles.tableWrap}>
        <p className={styles.help}>{visible.length} templates · Only Approved can be sent. Refresh status to check Meta’s latest decision.</p>
        <table><thead><tr><th>Template</th><th>Language / category</th><th>Status</th><th>Actions</th></tr></thead><tbody>
          {visible.map(row=><tr key={row.template_id}><td><strong>{row.name}</strong><details><summary>View message</summary><div className={styles.body}>{row.components.map((c,i)=><p key={i}>{c.text||c.buttons?.map(b=>b.text).join(" · ")||c.format}</p>)}</div></details></td><td>{row.language}<div className={styles.meta}>{row.category}</div></td><td><span className={styles.badge+" "+(row.status==="APPROVED"?styles.approved:row.status==="REJECTED"?styles.rejected:styles.pending)}>{row.status}</span>{row.rejected_reason?<p className={styles.help}>{row.rejected_reason}</p>:null}{row.synced_at?<div className={styles.meta}>Checked {new Date(row.synced_at).toLocaleString("en-IN")}</div>:null}</td><td><div className={styles.toolbar}>{row.status==="APPROVED"?<Link className="button secondary compact" href={sendPath+"?profile="+encodeURIComponent(profileId)+"&template="+encodeURIComponent(row.template_id)}>Use template</Link>:null}{canEdit?<button type="button" className="button secondary compact" disabled={busy} onClick={()=>duplicate(row)}>Copy as new</button>:null}</div></td></tr>)}
          {!visible.length?<tr><td colSpan={4}>No matching templates. {canEdit?"Refresh status or create a template.":"Ask a settings administrator to sync templates."}</td></tr>:null}
        </tbody></table>
      </div>}
    </section>
  </div>;
}

