'use client';
import {useEffect,useRef,useState} from 'react';
import {Check,Download,Eye,FileText,LoaderCircle,RefreshCw,Share2,X} from 'lucide-react';
import styles from './beta-report-download.module.css';

type Language='en'|'ml'|'ta'|'te'|'kn'|'hi'|'or';
const copy:Record<Language,{title:string;fetch:string;fetching:string;ready:string;download:string;preview:string;retry:string;cancel:string;refresh:string;share:string;help:string}>={
 en:{title:'Your IDfy report',fetch:'Fetch report',fetching:'Preparing your PDF',ready:'Report ready',download:'Download PDF',preview:'View PDF',retry:'Try again',cancel:'Cancel',refresh:'Fetch latest copy',share:'Save / share',help:'Fetch once, then view or save your report.'},
 ml:{title:'നിങ്ങളുടെ IDfy റിപ്പോർട്ട്',fetch:'റിപ്പോർട്ട് ലഭ്യമാക്കുക',fetching:'PDF തയ്യാറാക്കുന്നു',ready:'റിപ്പോർട്ട് തയ്യാറാണ്',download:'PDF ഡൗൺലോഡ്',preview:'PDF കാണുക',retry:'വീണ്ടും ശ്രമിക്കുക',cancel:'റദ്ദാക്കുക',refresh:'പുതിയ പകർപ്പ് ലഭ്യമാക്കുക',share:'സേവ് / ഷെയർ',help:'ആദ്യം റിപ്പോർട്ട് ലഭ്യമാക്കൂ. തുടർന്ന് കാണുകയോ സേവ് ചെയ്യുകയോ ചെയ്യാം.'},
 ta:{title:'உங்கள் IDfy அறிக்கை',fetch:'அறிக்கையைப் பெறுங்கள்',fetching:'PDF தயாராகிறது',ready:'அறிக்கை தயார்',download:'PDF பதிவிறக்கம்',preview:'PDF பார்க்க',retry:'மீண்டும் முயல்க',cancel:'ரத்து',refresh:'புதிய நகல் பெற',share:'சேமி / பகிர்',help:'அறிக்கையைப் பெற்ற பின் பார்க்கலாம் அல்லது சேமிக்கலாம்.'},
 te:{title:'మీ IDfy నివేదిక',fetch:'నివేదిక పొందండి',fetching:'PDF సిద్ధమవుతోంది',ready:'నివేదిక సిద్ధం',download:'PDF డౌన్‌లోడ్',preview:'PDF చూడండి',retry:'మళ్లీ ప్రయత్నించండి',cancel:'రద్దు',refresh:'తాజా కాపీ పొందండి',share:'సేవ్ / షేర్',help:'ముందు నివేదిక పొందండి. తర్వాత చూడండి లేదా సేవ్ చేయండి.'},
 kn:{title:'ನಿಮ್ಮ IDfy ವರದಿ',fetch:'ವರದಿ ಪಡೆಯಿರಿ',fetching:'PDF ಸಿದ್ಧವಾಗುತ್ತಿದೆ',ready:'ವರದಿ ಸಿದ್ಧವಾಗಿದೆ',download:'PDF ಡೌನ್‌ಲೋಡ್',preview:'PDF ನೋಡಿ',retry:'ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ',cancel:'ರದ್ದು',refresh:'ಹೊಸ ಪ್ರತಿ ಪಡೆಯಿರಿ',share:'ಉಳಿಸಿ / ಹಂಚಿ',help:'ಮೊದಲು ವರದಿ ಪಡೆಯಿರಿ. ನಂತರ ನೋಡಿ ಅಥವಾ ಉಳಿಸಿ.'},
 hi:{title:'आपकी IDfy रिपोर्ट',fetch:'रिपोर्ट प्राप्त करें',fetching:'PDF तैयार हो रही है',ready:'रिपोर्ट तैयार है',download:'PDF डाउनलोड करें',preview:'PDF देखें',retry:'फिर कोशिश करें',cancel:'रद्द करें',refresh:'नई प्रति प्राप्त करें',share:'सेव / शेयर',help:'पहले रिपोर्ट प्राप्त करें, फिर देखें या सेव करें।'},
 or:{title:'ଆପଣଙ୍କ IDfy ରିପୋର୍ଟ',fetch:'ରିପୋର୍ଟ ପାଆନ୍ତୁ',fetching:'PDF ପ୍ରସ୍ତୁତ ହେଉଛି',ready:'ରିପୋର୍ଟ ପ୍ରସ୍ତୁତ',download:'PDF ଡାଉନଲୋଡ୍',preview:'PDF ଦେଖନ୍ତୁ',retry:'ପୁଣି ଚେଷ୍ଟା କରନ୍ତୁ',cancel:'ବାତିଲ',refresh:'ନୂଆ କପି ପାଆନ୍ତୁ',share:'ସେଭ୍ / ସେୟାର',help:'ପ୍ରଥମେ ରିପୋର୍ଟ ପାଆନ୍ତୁ। ତାପରେ ଦେଖନ୍ତୁ କିମ୍ବା ସେଭ୍ କରନ୍ତୁ।'},
};
type Prepared={url:string;blob:Blob;filename:string;at:string;cached:boolean};
/** Private PDF stays in this mounted component; never localStorage or a public link. */
export function BetaReportDownload({endpoint,language='en'}:{endpoint:string;language?:Language}) {
 const t=copy[language]??copy.en;
 const ml=language==='ml';
 const [state,setState]=useState<'idle'|'fetching'|'ready'|'error'>('idle');
 const [file,setFile]=useState<Prepared|null>(null),[elapsed,setElapsed]=useState(0),[error,setError]=useState(''),[reference,setReference]=useState(''),[cooldown,setCooldown]=useState(0),[shareable,setShareable]=useState(false);
 const active=useRef<AbortController|null>(null),objectUrl=useRef(''),dialog=useRef<HTMLDialogElement>(null),started=useRef(0);
 useEffect(()=>{if(state!=='fetching')return;const timer=setInterval(()=>setElapsed(Math.floor((Date.now()-started.current)/1000)),1000);return()=>clearInterval(timer);},[state]);
 useEffect(()=>{if(cooldown<=0)return;const timer=setTimeout(()=>setCooldown(cooldown-1),1000);return()=>clearTimeout(timer);},[cooldown]);
 useEffect(()=>()=>{active.current?.abort();if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);},[]);
 // Changing account selectors must destroy the old report, even during a request.
 useEffect(()=>{active.current?.abort();active.current=null;if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current='';setFile(null);setState('idle');setError('');setReference('');setShareable(false);setCooldown(0);dialog.current?.close();},[endpoint]);
 const prepare=async(fresh=false)=>{
  if(active.current)return;
  const controller=new AbortController();active.current=controller;started.current=Date.now();setElapsed(0);setState('fetching');setError('');setReference('');
  const deadline=setTimeout(()=>controller.abort('timeout'),115000);
  try {
   const url=new URL(endpoint,window.location.origin);if(fresh)url.searchParams.set('fresh','1');
   const response=await fetch(url,{cache:'no-store',signal:controller.signal});
   if(!response.ok){const data=await response.json().catch(()=>({}));if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');setReference(typeof data.requestId==='string'?data.requestId:'');throw new Error(data.error||'The report could not be prepared. Please retry.');}
   if(!response.headers.get('content-type')?.startsWith('application/pdf'))throw new Error('A PDF was not received. Please retry.');
   const blob=await response.blob();
   if(blob.size>20*1024*1024||!blob.size||(await blob.slice(0,5).text())!=='%PDF-')throw new Error('The PDF was incomplete. Please retry.');
   if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');
   if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);
   const link=URL.createObjectURL(blob);objectUrl.current=link;
   const filename=response.headers.get('content-disposition')?.match(/filename="(IDfy-verification-\d+\.pdf)"/)?.[1]??'IDfy-verification.pdf';
   const at=response.headers.get('X-Report-Prepared-At')||new Date().toISOString();
   setFile({url:link,blob,filename,at,cached:response.headers.get('X-Report-Cache')==='hit'});setState('ready');setCooldown(30);
   const shareFile=new File([blob],filename,{type:'application/pdf'});setShareable(Boolean(navigator.canShare?.({files:[shareFile]})));
  }catch(e){if(controller.signal.aborted&&controller.signal.reason!=='timeout')return;setError(controller.signal.reason==='timeout'?'This request took too long. Try again shortly.':e instanceof Error?e.message:'Please retry.');setState('error');setCooldown(15);}
  finally {clearTimeout(deadline);if(active.current===controller)active.current=null;}
 };
 const cancel=()=>{active.current?.abort();active.current=null;setState(file?'ready':'idle');setError('');};
 const download=()=>{if(!file)return;const a=document.createElement('a');a.href=file.url;a.download=file.filename;document.body.appendChild(a);a.click();a.remove();};
 const share=async()=>{if(!file)return;try{await navigator.share({files:[new File([file.blob],file.filename,{type:'application/pdf'})]});}catch(e){if(!(e instanceof DOMException&&e.name==='AbortError'))setError('Sharing is unavailable. Use Download PDF instead.');}};
 return <section className={styles.panel} aria-label={t.title} data-state={state}>
  <header><i>{state==='fetching'?<LoaderCircle className={styles.spin}/>:file?<Check/>:<FileText/>}</i><div><h4>{t.title}</h4><p>{state==='fetching'?t.fetching:file?t.ready:t.help}</p></div>{state==='fetching'?<span className={styles.timer} aria-label={`Elapsed ${elapsed} seconds`}>{Math.floor(elapsed/60)}:{String(elapsed%60).padStart(2,'0')}</span>:null}</header>
  <ol className={styles.steps} aria-label="Report progress"><li data-active={state==='fetching'||Boolean(file)}>1 · {ml?'ലഭ്യമാക്കുക':'Fetch'}</li><li data-active={Boolean(file)}>2 · {ml?'PDF തയ്യാർ':'PDF ready'}</li><li>3 · {ml?'കാണുക / സേവ്':'View or save'}</li></ol>
  {state==='fetching'?<><div className={styles.activity} role="progressbar" aria-label="Preparing report"/><p className={styles.note} role="status">{ml?(elapsed<30?'IDfy-യിൽ നിന്ന് റിപ്പോർട്ട് ലഭ്യമാക്കുന്നു…':elapsed<70?'PDF തയ്യാറാകുന്നു. ഈ സ്ക്രീൻ തുറന്നുവെക്കൂ.':'സാധാരണയേക്കാൾ സമയമെടുക്കുന്നു. റദ്ദാക്കി വീണ്ടും ശ്രമിക്കാം.'):(elapsed<30?'Connecting to IDfy and preparing your report…':elapsed<70?'IDfy is still preparing the PDF. Keep this screen open.':'This is taking longer than usual. You can cancel and retry.')}</p></>:null}
  {file?<p className={styles.meta}>PDF · {Math.ceil(file.blob.size/1024)} KB · {file.cached?'Recent copy':'Fetched'} {new Date(file.at).toLocaleString('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})}</p>:null}
  {error?<div className={styles.error} role="alert"><p>{error}</p>{reference?<small>Support reference: {reference}</small>:null}{file?<small>Your previous prepared copy is still available below.</small>:null}</div>:null}
  <div className={styles.actions}>
   {state==='fetching'?<button type="button" onClick={cancel}>{t.cancel}</button>:!file?<button type="button" className={styles.primary} disabled={cooldown>0} onClick={()=>prepare()}>{state==='error'?<RefreshCw size={17}/>:<Download size={17}/>} {state==='error'?t.retry:t.fetch}{cooldown>0?` (${cooldown}s)`:''}</button>:<>
    <button type="button" className={styles.primary} onClick={download}><Download size={17}/>{t.download}</button>
    <button type="button" onClick={()=>dialog.current?.showModal()}><Eye size={17}/>{t.preview}</button>
    {shareable?<button type="button" onClick={share}><Share2 size={17}/>{t.share}</button>:null}
    <button type="button" className={styles.quiet} disabled={cooldown>0} onClick={()=>prepare(true)}><RefreshCw size={15}/>{state==='error'?t.retry:t.refresh}{cooldown>0?` (${cooldown}s)`:''}</button>
   </>}
  </div>
  <dialog ref={dialog} className={styles.preview}><header><strong>{t.title}</strong><button type="button" aria-label="Close PDF preview" onClick={()=>dialog.current?.close()}><X size={20}/></button></header>{file?<><iframe src={file.url} title="IDfy verification report"/><footer><span>If preview is unavailable, save the PDF to open it.</span><button type="button" className={styles.primary} onClick={download}><Download size={16}/>{t.download}</button></footer></>:null}</dialog>
 </section>;
}
