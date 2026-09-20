import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "./supabase-admin";
import { timeOffAttachmentMaxBytes, validateTimeOffAttachment } from "./time-off-attachment-validation";

export type TimeOffKind = "wfh" | "business-trip";
export type TimeOffAttachmentFields = {
  attachment_path: string; attachment_file_name: string; attachment_mime_type: string; attachment_size: number;
};
const bucket = "time-off-attachments";
const table = (kind: TimeOffKind) => kind==="wfh" ? "hr_wfh_requests" : "hr_business_trip_requests";
function db(){ if(!supabaseAdmin) throw new Error("Database unavailable."); return supabaseAdmin; }

export async function readTimeOffRequest(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origin && new URL(origin).host !== host) throw new Error("Open this request in One and try again.");
  if (Number(request.headers.get("content-length") || 0) > timeOffAttachmentMaxBytes+65536) throw new Error("Choose an attachment up to 4 MB.");
  if (request.headers.get("content-type")?.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("attachment");
    if (form.getAll("attachment").length > 1) throw new Error("Attach one file per request.");
    return { body: Object.fromEntries([...form].filter(([key])=>key!=="attachment")) as Record<string,unknown>, file: file instanceof File && file.name ? file : null };
  }
  return { body: await request.json() as Record<string,unknown>, file: null };
}

export async function withTimeOffAttachment<T>(
  companyId: string, kind: TimeOffKind, file: File | null,
  create: (requestId: string, attachment: TimeOffAttachmentFields | undefined) => Promise<T>
) {
  const requestId = randomUUID();
  let attachment: TimeOffAttachmentFields | undefined;
  if (file) {
    if (file.size > timeOffAttachmentMaxBytes) throw new Error("Choose an attachment up to 4 MB.");
    const bytes = Buffer.from(await file.arrayBuffer());
    const valid = validateTimeOffAttachment(file.name, file.size, bytes);
    const path = `${companyId}/${kind}/${requestId}/${randomUUID()}.${valid.extension}`;
    const upload = await db().storage.from(bucket).upload(path,bytes,{ contentType:valid.mimeType,upsert:false,cacheControl:"0" });
    if (upload.error) throw new Error("Attachment upload failed. Your request was not submitted; please try again.");
    attachment={ attachment_path:path,attachment_file_name:valid.fileName,attachment_mime_type:valid.mimeType,attachment_size:file.size };
  }
  try {
    return await create(requestId,attachment);
  } catch(error) {
    // Never delete a file that may already be linked to a saved request.
    if (attachment) {
      const saved = await db().from(table(kind)).select("id").eq("company_id",companyId).eq("id",requestId).maybeSingle();
      if (saved.error || saved.data) throw new Error("Submission confirmation was interrupted. Check My requests before retrying.");
      await db().storage.from(bucket).remove([attachment.attachment_path]);
    }
    throw error;
  }
}

// Call only with IDs that the caller has already authorized for this user.
export async function loadTimeOffAttachments(companyId: string, kind: TimeOffKind, authorizedIds: string[]) {
  const attachments = new Map<string,{fileName:string;mimeType:string;size:number;url:string|null}>();
  if(!authorizedIds.length) return attachments;
  const ids = [...new Set(authorizedIds)];
  for(let offset=0;offset<ids.length;offset+=200) {
    const result=await db().from(table(kind)).select("id,attachment_path,attachment_file_name,attachment_mime_type,attachment_size")
      .eq("company_id",companyId).in("id",ids.slice(offset,offset+200)).not("attachment_path","is",null);
    if(result.error) throw new Error("Unable to load request attachments.");
    await Promise.all((result.data??[]).map(async row=>{
      if(!row.attachment_path.startsWith(`${companyId}/${kind}/${row.id}/`)) throw new Error("Request attachment is invalid.");
      const signed=await db().storage.from(bucket).createSignedUrl(row.attachment_path,900);
      attachments.set(row.id,{fileName:row.attachment_file_name,mimeType:row.attachment_mime_type,size:row.attachment_size,url:signed.data?.signedUrl??null});
    }));
  }
  return attachments;
}
