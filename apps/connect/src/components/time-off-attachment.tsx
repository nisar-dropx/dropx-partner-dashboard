"use client";
import { useEffect,useRef } from "react";
import { Paperclip } from "lucide-react";
import { ConnectAttachmentViewer } from "./connect-attachment-viewer";
export type TimeOffAttachment = {fileName:string;mimeType:string;size:number;url:string|null};
export function OptionalTimeOffAttachment({value,onChange,disabled}:{value:File|null;onChange:(file:File|null)=>void;disabled?:boolean}) {
  const input=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(!value && input.current) input.current.value="";},[value]);
  return <div className="dx-time-off-attachment">
    <label>Attachment <span>(optional)</span>
      <input ref={input} type="file" accept=".pdf,.jpg,.jpeg,.png" disabled={disabled} onChange={event=>onChange(event.target.files?.[0]??null)} />
    </label>
    <small>PDF, JPG or PNG · Up to 4 MB · Visible to your approvers and authorised People users.</small>
    {value ? <div><span>{value.name}</span><button type="button" disabled={disabled} onClick={()=>onChange(null)}>Remove attachment</button></div> : null}
  </div>;
}
export function TimeOffAttachmentLink({attachment}:{attachment?:TimeOffAttachment|null}) {
  if(!attachment) return null;
  if(!attachment.url) return <p>Attachment: {attachment.fileName} · Unable to open. Refresh and retry.</p>;
  return <ConnectAttachmentViewer files={[{label:attachment.fileName,fileName:attachment.fileName,mimeType:attachment.mimeType,url:attachment.url}]} title="Request attachment" trigger={<><Paperclip />{attachment.fileName}</>} />;
}
