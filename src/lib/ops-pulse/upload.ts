"use server";

import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";
import type { CodAttachment } from "@/lib/ops-pulse/cod";

const bucketName = "ops-pulse-documents";
const IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"]);

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "proof";
}

function isImageFile(file: File) {
  const type = (file.type || "").toLowerCase();
  if (IMAGE_TYPES.has(type)) return true;
  return /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
}

async function ensureBucket() {
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const existing = await supabaseAdmin.storage.getBucket(bucketName);
  if (!existing.error) return;
  const created = await supabaseAdmin.storage.createBucket(bucketName, {
    public: false,
    fileSizeLimit: 30 * 1024 * 1024
  });
  if (created.error && !created.error.message.toLowerCase().includes("already exists")) {
    throw new Error(created.error.message);
  }
}

export async function uploadOpsProof({
  companyId,
  field,
  file,
  label,
  section,
  submissionId,
  imagesOnly = false
}: {
  companyId: string;
  field: string;
  file: FormDataEntryValue | null;
  label: string;
  section: string;
  submissionId: string;
  imagesOnly?: boolean;
}): Promise<CodAttachment | null> {
  if (!(file instanceof File) || file.size === 0) return null;
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  if (imagesOnly && !isImageFile(file)) {
    throw new Error(`${label} must be a photo (JPG, PNG, or WEBP).`);
  }

  await ensureBucket();
  const storagePath = `${companyId}/${section}/${submissionId}/${field}/${Date.now()}-${randomUUID()}-${safeFileName(file.name)}`;
  const upload = await supabaseAdmin.storage.from(bucketName).upload(
    storagePath,
    Buffer.from(await file.arrayBuffer()),
    {
      contentType: file.type || "application/octet-stream",
      upsert: false
    }
  );
  if (upload.error) throw new Error(upload.error.message);

  return {
    content_type: file.type || null,
    field,
    file_name: file.name,
    file_size: file.size,
    label,
    storage_bucket: bucketName,
    storage_path: storagePath
  };
}
