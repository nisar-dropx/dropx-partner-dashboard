import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const profileDocumentBucket = "employee-profile-documents";

type ProfileDocumentOwnerType = "employee" | "field_executive";

type ProfileDocumentTrashPayload = {
  companyId: string;
  ownerId: string;
  ownerType: ProfileDocumentOwnerType;
  documentLabel: string;
  fileName?: string | null;
  contentType?: string | null;
  fileSize?: number | null;
  storagePath?: string | null;
  replacedBy: string;
};

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_") || "profile-document";
}

function isEmptyFile(value: FormDataEntryValue | null): value is File {
  return value instanceof File && value.size > 0;
}

export async function uploadProfileDocument({
  companyId,
  documentKey,
  fileValue,
  ownerId,
  ownerType
}: {
  companyId: string;
  documentKey: string;
  fileValue: FormDataEntryValue | null;
  ownerId: string;
  ownerType: ProfileDocumentOwnerType;
}) {
  if (!supabaseAdmin || !isEmptyFile(fileValue)) return null;

  const storagePath = `${companyId}/${ownerType}/${ownerId}/${documentKey}/${Date.now()}-${randomUUID()}-${safeFileName(fileValue.name)}`;
  const bytes = Buffer.from(await fileValue.arrayBuffer());
  const { error } = await supabaseAdmin.storage
    .from(profileDocumentBucket)
    .upload(storagePath, bytes, {
      contentType: fileValue.type || "application/octet-stream",
      upsert: false
    });
  if (error) throw new Error(error.message);

  return {
    fileName: fileValue.name,
    contentType: fileValue.type || null,
    fileSize: fileValue.size,
    storagePath
  };
}

export async function moveProfileDocumentToTrash({
  companyId,
  contentType,
  documentLabel,
  fileName,
  fileSize,
  ownerId,
  ownerType,
  replacedBy,
  storagePath
}: ProfileDocumentTrashPayload) {
  if (!supabaseAdmin || !storagePath) return;

  const now = new Date();
  const deleteAfter = new Date(now.getTime() + 30 * 86_400_000).toISOString();
  const { error } = await (supabaseAdmin.from("profile_document_trash") as any).insert({
    company_id: companyId,
    owner_type: ownerType,
    owner_id: ownerId,
    document_label: documentLabel,
    file_name: fileName,
    content_type: contentType,
    file_size: fileSize,
    storage_bucket: profileDocumentBucket,
    storage_path: storagePath,
    replaced_by: replacedBy,
    replaced_at: now.toISOString(),
    delete_after: deleteAfter
  });

  if (!error) return;
  const message = error.message.toLowerCase();
  if (message.includes("profile_document_trash") || message.includes("does not exist") || message.includes("schema cache")) {
    const removeResult = await supabaseAdmin.storage.from(profileDocumentBucket).remove([storagePath]);
    if (removeResult.error) throw new Error(removeResult.error.message);
    return;
  }
  throw new Error(error.message);
}

