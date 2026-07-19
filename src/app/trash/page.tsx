import { revalidatePath } from "next/cache";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { TrashTable, type TrashItem } from "@/components/trash-table";
import { hasPermission, requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

type BusinessTrashRow = {
  id: string;
  document_type_code: string | null;
  scope_label: string | null;
  file_name: string | null;
  file_size: number | null;
  storage_bucket: string | null;
  storage_path: string | null;
  replaced_at: string | null;
  delete_after: string | null;
  updated_at: string | null;
  document_types?: { name: string | null } | { name: string | null }[] | null;
};

type FleetTrashRow = {
  id: string;
  vehicle_no: string | null;
  document_type: string | null;
  file_name: string | null;
  file_size: number | null;
  storage_bucket: string | null;
  storage_path: string | null;
  replaced_at: string | null;
  delete_after: string | null;
  uploaded_at: string | null;
};

type ProfileTrashRow = {
  id: string;
  owner_type: string;
  owner_id: string;
  document_label: string | null;
  file_name: string | null;
  file_size: number | null;
  replaced_at: string | null;
  delete_after: string | null;
};

export default async function TrashPage() {
  const permission = await requirePagePermission("trash", "access");
  const companyId = requireCompanyId(permission);
  const items = await loadTrashItems(companyId);

  return (
    <AppShell active="Trash" pageCode="trash">
      <PageHead
        eyebrow="FILES"
        title="Trash"
        subtitle="Deleted, removed, and replaced files stay here until their 30-day permanent deletion date."
      />
      <TrashTable action={permanentlyDeleteTrashItems} canEdit={hasPermission(permission, "trash", "edit")} items={items} />
    </AppShell>
  );
}

async function loadTrashItems(companyId: string): Promise<TrashItem[]> {
  if (!supabaseAdmin) return [];
  const [businessResult, fleetResult, profileResult] = await Promise.all([
    supabaseAdmin
      .from("business_document_records")
      .select("id, document_type_code, scope_label, file_name, file_size, storage_bucket, storage_path, replaced_at, delete_after, updated_at, document_types (name)")
      .eq("company_id", companyId)
      .eq("is_active", false)
      .not("storage_path", "is", null)
      .order("delete_after", { ascending: true }),
    supabaseAdmin
      .from("fleet_vehicle_documents")
      .select("id, vehicle_no, document_type, file_name, file_size, storage_bucket, storage_path, replaced_at, delete_after, uploaded_at")
      .eq("company_id", companyId)
      .eq("is_active", false)
      .not("storage_path", "is", null)
      .order("delete_after", { ascending: true })
    ,
    supabaseAdmin
      .from("profile_document_trash")
      .select("id, owner_type, owner_id, document_label, file_name, file_size, replaced_at, delete_after")
      .eq("company_id", companyId)
      .order("delete_after", { ascending: true })
  ]);
  if (businessResult.error) throw new Error(businessResult.error.message);
  if (fleetResult.error) throw new Error(fleetResult.error.message);
  if (profileResult.error) {
    const message = profileResult.error.message.toLowerCase();
    if (!message.includes("profile_document_trash") && !message.includes("does not exist") && !message.includes("schema cache")) {
      throw new Error(profileResult.error.message);
    }
  }

  const business = ((businessResult.data ?? []) as BusinessTrashRow[]).map((row) => {
    const relation = Array.isArray(row.document_types) ? row.document_types[0] : row.document_types;
    return {
      id: row.id,
      key: `business:${row.id}`,
      source: "business" as const,
      reason: row.replaced_at ? "Replaced" : "Removed",
      fileName: row.file_name || "Business document",
      owner: row.scope_label || "Company",
      documentName: relation?.name || row.document_type_code || "Business document",
      deletedAt: row.replaced_at || row.updated_at,
      deleteAfter: row.delete_after,
      daysRemaining: daysRemaining(row.delete_after),
      sizeLabel: formatBytes(row.file_size)
    };
  });

  const fleet = ((fleetResult.data ?? []) as FleetTrashRow[]).map((row) => ({
    id: row.id,
    key: `fleet:${row.id}`,
    source: "fleet" as const,
    reason: row.replaced_at ? "Replaced" : "Removed",
    fileName: row.file_name || "Fleet document",
    owner: row.vehicle_no || "-",
    documentName: documentLabel(row.document_type),
    deletedAt: row.replaced_at || row.uploaded_at,
    deleteAfter: row.delete_after,
    daysRemaining: daysRemaining(row.delete_after),
    sizeLabel: formatBytes(row.file_size)
  }));

  const profile = ((profileResult.data ?? []) as ProfileTrashRow[]).map((row) => ({
    id: row.id,
    key: `profile:${row.id}`,
    source: "profile" as const,
    reason: "Replaced",
    fileName: row.file_name || "Profile document",
    owner: row.owner_type === "field_executive" ? "Field executive" : "Employee",
    documentName: row.document_label || "Profile document",
    deletedAt: row.replaced_at,
    deleteAfter: row.delete_after,
    daysRemaining: daysRemaining(row.delete_after),
    sizeLabel: formatBytes(row.file_size)
  }));

  return [...business, ...fleet, ...profile].sort((a, b) => {
    const left = a.deleteAfter ? new Date(a.deleteAfter).getTime() : Number.MAX_SAFE_INTEGER;
    const right = b.deleteAfter ? new Date(b.deleteAfter).getTime() : Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

async function permanentlyDeleteTrashItems(formData: FormData) {
  "use server";

  const permission = await requirePagePermission("trash", "edit");
  const companyId = requireCompanyId(permission);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");

  const keys = Array.from(new Set(formData.getAll("trash_key").map((value) => String(value))));
  const businessIds = keys.filter((key) => key.startsWith("business:")).map((key) => key.replace("business:", ""));
  const fleetIds = keys.filter((key) => key.startsWith("fleet:")).map((key) => key.replace("fleet:", ""));
  const profileIds = keys.filter((key) => key.startsWith("profile:")).map((key) => key.replace("profile:", ""));

  await deleteTrashRows("business_document_records", businessIds, companyId);
  await deleteTrashRows("fleet_vehicle_documents", fleetIds, companyId);
  await deleteProfileTrashRows(profileIds, companyId);
  revalidatePath("/trash");
}

async function deleteTrashRows(table: "business_document_records" | "fleet_vehicle_documents", ids: string[], companyId: string) {
  if (!ids.length || !supabaseAdmin) return;
  const { data, error } = await supabaseAdmin
    .from(table)
    .select("id, storage_bucket, storage_path")
    .eq("company_id", companyId)
    .eq("is_active", false)
    .in("id", ids);
  if (error) throw new Error(error.message);

  const filesByBucket = new Map<string, string[]>();
  for (const row of data ?? []) {
    const bucket = String(row.storage_bucket ?? "").trim();
    const path = String(row.storage_path ?? "").trim();
    if (!bucket || !path) continue;
    filesByBucket.set(bucket, [...(filesByBucket.get(bucket) ?? []), path]);
  }

  for (const [bucket, paths] of filesByBucket.entries()) {
    const removeResult = await supabaseAdmin.storage.from(bucket).remove(paths);
    if (removeResult.error) throw new Error(removeResult.error.message);
  }

  const { error: deleteError } = await supabaseAdmin
    .from(table)
    .delete()
    .eq("company_id", companyId)
    .eq("is_active", false)
    .in("id", ids);
  if (deleteError) throw new Error(deleteError.message);
}

async function deleteProfileTrashRows(ids: string[], companyId: string) {
  if (!ids.length || !supabaseAdmin) return;
  const { data, error } = await supabaseAdmin
    .from("profile_document_trash")
    .select("id, storage_bucket, storage_path")
    .eq("company_id", companyId)
    .in("id", ids);
  if (error) throw new Error(error.message);

  const filesByBucket = new Map<string, string[]>();
  for (const row of data ?? []) {
    const bucket = String(row.storage_bucket ?? "").trim();
    const path = String(row.storage_path ?? "").trim();
    if (!bucket || !path) continue;
    filesByBucket.set(bucket, [...(filesByBucket.get(bucket) ?? []), path]);
  }

  for (const [bucket, paths] of filesByBucket.entries()) {
    const removeResult = await supabaseAdmin.storage.from(bucket).remove(paths);
    if (removeResult.error) throw new Error(removeResult.error.message);
  }

  const { error: deleteError } = await supabaseAdmin
    .from("profile_document_trash")
    .delete()
    .eq("company_id", companyId)
    .in("id", ids);
  if (deleteError) throw new Error(deleteError.message);
}

function daysRemaining(value: string | null) {
  if (!value) return null;
  const target = new Date(value);
  if (Number.isNaN(target.getTime())) return null;
  const today = startOfDay(new Date()).getTime();
  const deleteDay = startOfDay(target).getTime();
  return Math.max(0, Math.ceil((deleteDay - today) / 86_400_000));
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function formatBytes(value: number | null) {
  if (!value) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function documentLabel(value: string | null) {
  const text = String(value ?? "").replace(/^FLEET_/, "").replace(/_/g, " ").trim().toLowerCase();
  return text ? text.replace(/\b\w/g, (letter) => letter.toUpperCase()) : "Fleet document";
}
