"use server";
import {revalidatePath} from "next/cache";
import {requirePagePermission} from "@/lib/authorization";
import {requireCompanyId} from "@/lib/company-scope";
import {supabaseAdmin} from "@/lib/supabase-admin";
import {buildTemplatePayload, type TemplateDraft} from "@/lib/whatsapp-template-builder";
import {templateGraphRequest} from "@/lib/whatsapp-template-meta";
import {syncWhatsAppTemplateCache} from "@/lib/whatsapp-template-sync";

export type TemplateRow = {template_id:string;whatsapp_profile_id:string|null;name:string;language:string;category:string|null;status:string;components:Array<{type?:string;text?:string;format?:string;buttons?:Array<{text?:string;url?:string}>}>;synced_at?:string;rejected_reason?:string};
export type SenderRow = {id:string;profile_name:string;is_default:boolean};
export async function loadTemplateLibrary() {
  const auth=await requirePagePermission("app_settings","access");
  const companyId=requireCompanyId(auth);
  if (!supabaseAdmin) throw new Error("WhatsApp storage is unavailable.");
  const [profiles,templates]=await Promise.all([
    supabaseAdmin.from("whatsapp_profiles").select("id,profile_name,is_default").eq("company_id",companyId).eq("is_active",true).order("profile_name"),
    supabaseAdmin.from("whatsapp_template_cache").select("template_id,whatsapp_profile_id,name,language,category,status,components,synced_at").eq("company_id",companyId).order("name")
  ]);
  if (profiles.error || templates.error) throw new Error("Could not load the template library. Please retry.");
  return {profiles:profiles.data as SenderRow[],templates:templates.data as TemplateRow[],canEdit:!!auth.permissions.app_settings?.canEdit && !auth.readOnly};
}
async function sender(profileId:string) {
  const auth=await requirePagePermission("app_settings","edit");
  const companyId=requireCompanyId(auth);
  if (!supabaseAdmin) throw new Error("WhatsApp storage is unavailable.");
  const profile=await supabaseAdmin.from("whatsapp_profiles").select("id,business_account_id,graph_api_version,is_active").eq("company_id",companyId).eq("id",profileId).maybeSingle();
  if (profile.error || !profile.data?.is_active) throw new Error("Select an active sender in your company.");
  if (!profile.data.business_account_id) throw new Error("The sender is missing its WhatsApp Business Account ID.");
  const secret=await supabaseAdmin.rpc("get_whatsapp_profile_access_token",{profile_id:profileId});
  if (secret.error || !secret.data) throw new Error("The sender's WhatsApp access token is not configured.");
  return {companyId,profile:profile.data,token:String(secret.data)};
}
function invalidate() {
  revalidatePath("/notifications/whatsapp/templates");
  revalidatePath("/notifications/whatsapp");
  revalidatePath("/settings/meta");
}
export async function refreshTemplateLibrary(profileId:string):Promise<{templates?:TemplateRow[];error?:string;notice?:string}> {
  const auth=await requirePagePermission("app_settings","edit");
  const companyId=requireCompanyId(auth);
  try {
    const templates=await syncWhatsAppTemplateCache(companyId,profileId);
    invalidate();
    return {templates:templates as TemplateRow[],notice:`Checked with Meta · ${templates.length} templates`};
  } catch(error) {return {error:error instanceof Error?error.message:"Template refresh failed."};}
}
export async function submitWhatsAppTemplate(profileId:string,draft:TemplateDraft):Promise<{template?:TemplateRow;error?:string;notice?:string}> {
  const context=await sender(profileId);
  try {
    const payload=buildTemplatePayload(draft);
    const {companyId,profile,token}=context;
    const existing=await supabaseAdmin!.from("whatsapp_template_cache").select("template_id").eq("company_id",companyId).eq("whatsapp_profile_id",profileId).eq("name",payload.name).eq("language",payload.language).neq("status","DELETED").limit(1);
    if(existing.error) throw new Error("Could not check existing templates. Please retry.");
    if(existing.data?.length) throw new Error("This template name and language already exist. Use a new name for the revised version.");
    const result=await templateGraphRequest(profile.graph_api_version||"v25.0",profile.business_account_id,token,{payload});
    if(!result.id) throw new Error("Meta did not return a template ID. Refresh status before submitting again.");
    const template={template_id:String(result.id),whatsapp_profile_id:profileId,name:payload.name,language:payload.language,category:result.category||payload.category,status:result.status||"PENDING",components:payload.components,synced_at:new Date().toISOString()} as TemplateRow;
    const saved=await supabaseAdmin!.from("whatsapp_template_cache").upsert({...template,company_id:companyId},{onConflict:"company_id,template_id"});
    invalidate();
    return {template,notice:saved.error?"Submitted to Meta, but the local cache was not updated. Use Refresh status; do not submit again.":"Submitted to Meta. Only approved templates can be sent."};
  } catch(error) {return {error:error instanceof Error?error.message:"Submission failed. Refresh status before retrying."};}
}

