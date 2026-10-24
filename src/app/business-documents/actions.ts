"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePagePermission } from "@/lib/authorization";
import { documentMatchesWorkspace } from "@/lib/business-document-workspace";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

const bucketName = "business-documents";
const scopeTypes = new Set(["company", "state", "location", "provider"]);

function clean(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text.length ? text : null;
}

function required(value: FormDataEntryValue | null, field: string) {
  const text = clean(value);
  if (!text) throw new Error(`${field} is required.`);
  return text;
}

function flash(params: { error?: string; notice?: string }) {
  cookies().set("dropx_business_documents_flash", JSON.stringify(params), {
    httpOnly: true,
    maxAge: 20,
    path: "/business-documents",
    sameSite: "lax"
  });
  redirect("/business-documents");
}

function isNextRedirectError(error: unknown) {
  return typeof (error as { digest?: unknown })?.digest === "string" &&
    String((error as { digest: string }).digest).startsWith("NEXT_REDIRECT");
}

async function ensureBucket() {
  if (!supabaseAdmin) return;
  const { data } = await supabaseAdmin.storage.getBucket(bucketName);
  if (data) return;
  await supabaseAdmin.storage.createBucket(bucketName, {
    public: false,
    fileSizeLimit: 20 * 1024 * 1024
  });
}

function isMissingBucketError(error: { message?: string; statusCode?: string | number } | null) {
  const message = String(error?.message ?? "").toLowerCase();
  const statusCode = String(error?.statusCode ?? "");
  return statusCode === "404" || message.includes("bucket not found") || message.includes("not found");
}

async function uploadBusinessFile(companyId: string, documentCode: string, fileValue: FormDataEntryValue | null) {
  if (!(fileValue instanceof File) || !fileValue.size || !supabaseAdmin) return null;
  const safeName = fileValue.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const storagePath = `${companyId}/${documentCode}/${Date.now()}-${safeName}`;
  const bytes = Buffer.from(await fileValue.arrayBuffer());
  let uploadResult = await supabaseAdmin.storage
    .from(bucketName)
    .upload(storagePath, bytes, {
      contentType: fileValue.type || "application/octet-stream",
      upsert: false
    });
  if (isMissingBucketError(uploadResult.error)) {
    await ensureBucket();
    uploadResult = await supabaseAdmin.storage
      .from(bucketName)
      .upload(storagePath, bytes, {
        contentType: fileValue.type || "application/octet-stream",
        upsert: false
      });
  }
  const { error } = uploadResult;
  if (error) throw new Error(error.message);
  return {
    file_name: fileValue.name,
    content_type: fileValue.type || null,
    file_size: fileValue.size,
    storage_bucket: bucketName,
    storage_path: storagePath,
    status: "active"
  };
}

async function loadDocumentType(companyId: string, id: string) {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const { data, error } = await supabaseAdmin
    .from("document_types")
    .select("id, code, name, requires_expiry, business_scope_mode, enable_scope_access")
    .eq("company_id", companyId)
    .eq("id", id)
    .eq("document_module", "business")
    .eq("is_active", true)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

function parseAdditionalScopeIds(formData: FormData, configuredScope: string | null, enabled: boolean) {
  if (!enabled || !configuredScope || configuredScope === "company") return [];
  return Array.from(new Set(formData.getAll("additional_scope_ids").map((value) => clean(value)).filter(Boolean) as string[]))
    .map((value) => configuredScope === "state" ? value.toUpperCase() : value);
}

function parseScope(formData: FormData, configuredScope: string | null) {
  const rawType = configuredScope ?? clean(formData.get("scope_type")) ?? "";
  const scopeType = scopeTypes.has(rawType) ? rawType : "company";
  const scopeId = clean(formData.get("scope_id"));
  const scopeLabel = clean(formData.get(`scope_label_${scopeId ?? ""}`));
  const customLabel = clean(formData.get("scope_label"));

  if (!configuredScope) throw new Error("Set Scope type for this document in Document Master.");
  if (scopeType === "state") {
    if (!scopeId) throw new Error("State is required for this document.");
    return { scope_type: scopeType, scope_id: scopeId.toUpperCase(), scope_label: scopeLabel ?? scopeId };
  }
  if (scopeType === "location") {
    if (!scopeId) throw new Error("Location is required for this document.");
    return { scope_type: scopeType, scope_id: scopeId, scope_label: scopeLabel ?? scopeId };
  }
  if (scopeType === "provider") {
    if (!scopeId) throw new Error("Provider is required for this document.");
    return { scope_type: scopeType, scope_id: scopeId, scope_label: scopeLabel ?? scopeId };
  }
  return { scope_type: "company", scope_id: null, scope_label: customLabel ?? "Company" };
}

function parseDates(formData: FormData, defaultRequiresExpiry: boolean) {
  const trackExpiryRaw = clean(formData.get("track_expiry"));
  const trackExpiry = trackExpiryRaw ? trackExpiryRaw === "on" : defaultRequiresExpiry;
  const expiryDate = clean(formData.get("expiry_date"));
  if (trackExpiry && !expiryDate) throw new Error("Expiry date is required when expiry tracking is enabled.");
  return {
    reference_no: clean(formData.get("reference_no")),
    issue_date: clean(formData.get("issue_date")),
    expiry_date: trackExpiry ? expiryDate : null,
    track_expiry: trackExpiry
  };
}

export async function createBusinessDocument(formData: FormData) {
  const authorization = await requirePagePermission("business_documents", "add");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const documentType = await loadDocumentType(companyId, required(formData.get("document_type_id"), "Document type"));
    const proposedScope = parseScope(formData, documentType.business_scope_mode);
    const additional = parseAdditionalScopeIds(formData, documentType.business_scope_mode, Boolean(documentType.enable_scope_access));
    for (const scopeId of [proposedScope.scope_id, ...additional]) {
      if (!(await documentMatchesWorkspace(authorization, { ...proposedScope, scope_id: scopeId, additional_scope_ids: [] }))) throw new Error("Choose a document scope within the selected workspace.");
    }
    const filePayload = await uploadBusinessFile(companyId, String(documentType.code).toUpperCase(), formData.get("file"));
    const payload = {
      company_id: companyId,
      document_type_id: documentType.id,
      document_type_code: String(documentType.code).toUpperCase(),
      ...parseScope(formData, documentType.business_scope_mode),
      additional_scope_ids: parseAdditionalScopeIds(formData, documentType.business_scope_mode, Boolean(documentType.enable_scope_access)),
      ...parseDates(formData, Boolean(documentType.requires_expiry)),
      ...(filePayload ?? { status: "pending" })
    };

    const { error } = await (supabaseAdmin.from("business_document_records") as any).insert(payload);
    if (error) throw new Error(error.message);
    revalidatePath("/business-documents");
    flash({ notice: "Business document saved." });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    flash({ error: error instanceof Error ? error.message : "Unable to save business document." });
  }
}

export async function updateBusinessDocument(formData: FormData) {
  const authorization = await requirePagePermission("business_documents", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const id = required(formData.get("id"), "Business document");
    const current = await supabaseAdmin.from("business_document_records").select("scope_type,scope_id,additional_scope_ids").eq("company_id", companyId).eq("id", id).eq("is_active", true).maybeSingle();
    if (current.error || !current.data || !(await documentMatchesWorkspace(authorization, current.data))) throw new Error("Document is outside the selected workspace.");
    const documentType = await loadDocumentType(companyId, required(formData.get("document_type_id"), "Document type"));
    const proposedScope = parseScope(formData, documentType.business_scope_mode);
    const additional = parseAdditionalScopeIds(formData, documentType.business_scope_mode, Boolean(documentType.enable_scope_access));
    for (const scopeId of [proposedScope.scope_id, ...additional]) {
      if (!(await documentMatchesWorkspace(authorization, { ...proposedScope, scope_id: scopeId, additional_scope_ids: [] }))) throw new Error("Choose a document scope within the selected workspace.");
    }
    const filePayload = await uploadBusinessFile(companyId, String(documentType.code).toUpperCase(), formData.get("file"));
    if (filePayload) await keepOldBusinessFileInTrash(companyId, id);
    const payload = {
      document_type_id: documentType.id,
      document_type_code: String(documentType.code).toUpperCase(),
      ...parseScope(formData, documentType.business_scope_mode),
      additional_scope_ids: parseAdditionalScopeIds(formData, documentType.business_scope_mode, Boolean(documentType.enable_scope_access)),
      ...parseDates(formData, Boolean(documentType.requires_expiry)),
      ...(filePayload ?? {}),
      updated_at: new Date().toISOString()
    };

    const { error } = await (supabaseAdmin.from("business_document_records") as any)
      .update(payload)
      .eq("company_id", companyId)
      .eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/business-documents");
    flash({ notice: "Business document updated." });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    flash({ error: error instanceof Error ? error.message : "Unable to update business document." });
  }
}

export async function deleteBusinessDocument(formData: FormData) {
  const authorization = await requirePagePermission("business_documents", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const id = required(formData.get("id"), "Business document");
    const current = await supabaseAdmin.from("business_document_records").select("scope_type,scope_id,additional_scope_ids").eq("company_id", companyId).eq("id", id).eq("is_active", true).maybeSingle();
    if (current.error || !current.data || !(await documentMatchesWorkspace(authorization, current.data))) throw new Error("Document is outside the selected workspace.");

    const documentResult = await supabaseAdmin
      .from("business_document_records")
      .select("id, storage_bucket, storage_path")
      .eq("company_id", companyId)
      .eq("id", id)
      .maybeSingle();
    if (documentResult.error) throw new Error(documentResult.error.message);
    if (!documentResult.data) throw new Error("Business document not found.");

    const now = new Date();
    const deleteAfter = new Date(now.getTime() + 30 * 86_400_000).toISOString();
    const { error } = await supabaseAdmin
      .from("business_document_records")
      .update({
        is_active: false,
        status: "replaced",
        replaced_at: null,
        delete_after: deleteAfter,
        updated_at: now.toISOString()
      })
      .eq("company_id", companyId)
      .eq("id", id);
    if (error) throw new Error(error.message);
    revalidatePath("/business-documents");
    revalidatePath("/trash");
    flash({ notice: "Business document moved to Trash for 30 days." });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    flash({ error: error instanceof Error ? error.message : "Unable to remove business document." });
  }
}

async function keepOldBusinessFileInTrash(companyId: string, id: string) {
  if (!supabaseAdmin) return;
  const { data, error } = await supabaseAdmin
    .from("business_document_records")
    .select("*")
    .eq("company_id", companyId)
    .eq("id", id)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.storage_path) return;

  const now = new Date();
  const deleteAfter = new Date(now.getTime() + 30 * 86_400_000).toISOString();
  const oldRecord = {
    ...data,
    id: undefined,
    is_active: false,
    status: "replaced",
    replaced_at: now.toISOString(),
    delete_after: deleteAfter,
    created_at: data.created_at ?? now.toISOString(),
    updated_at: now.toISOString()
  };
  const { error: insertError } = await (supabaseAdmin.from("business_document_records") as any).insert(oldRecord);
  if (insertError) throw new Error(insertError.message);
}

export async function updateBusinessDocumentSettings(formData: FormData) {
  const authorization = await requirePagePermission("business_documents", "edit");
  const companyId = requireCompanyId(authorization);
  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const complianceManagerUserId = clean(formData.get("compliance_manager_user_id"));

    if (complianceManagerUserId) {
      const userResult = await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("company_id", companyId)
        .eq("id", complianceManagerUserId)
        .eq("is_active", true)
        .maybeSingle();
      if (userResult.error) throw new Error(userResult.error.message);
      if (!userResult.data) throw new Error("Select an active user as compliance manager.");
    }

    const { error } = await (supabaseAdmin.from("business_document_settings") as any).upsert({
      id: true,
      company_id: companyId,
      compliance_manager_user_id: complianceManagerUserId,
      updated_at: new Date().toISOString()
    }, { onConflict: "company_id,id" });
    if (error) throw new Error(error.message);

    revalidatePath("/business-documents");
    flash({ notice: "Compliance manager updated." });
  } catch (error) {
    if (isNextRedirectError(error)) throw error;
    flash({ error: error instanceof Error ? error.message : "Unable to update compliance manager." });
  }
}
