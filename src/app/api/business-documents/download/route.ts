import { documentMatchesWorkspace } from "@/lib/business-document-workspace";
import { NextResponse, type NextRequest } from "next/server";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

type BusinessDocumentDownloadRow = {
  id: string;
  document_type_id: string;
  scope_type: string;
  scope_id: string | null;
  additional_scope_ids: string[] | null;
  file_name: string | null;
  content_type: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  document_types?: { doc_access_mode: string | null } | { doc_access_mode: string | null }[] | null;
  access_role_ids?: string[];
};

export async function GET(request: NextRequest) {
  try {
    const authorization = await requirePagePermission("business_documents", "access");
    const companyId = requireCompanyId(authorization);
    const id = request.nextUrl.searchParams.get("id");
    const asInline = request.nextUrl.searchParams.get("disposition") === "inline";
    if (!id) return NextResponse.json({ error: "Document is required." }, { status: 400 });
    if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });

    const { data, error } = await supabaseAdmin
      .from("business_document_records")
      .select("id, document_type_id, scope_type, scope_id, additional_scope_ids, file_name, content_type, storage_bucket, storage_path, document_types (doc_access_mode)")
      .eq("company_id", companyId)
      .eq("id", id)
      .eq("is_active", true)
      .maybeSingle();

    if (error) throw new Error(error.message);
    const document = data as BusinessDocumentDownloadRow | null;
    if (!document?.storage_bucket || !document.storage_path) {
      return NextResponse.json({ error: "Document file is not available." }, { status: 404 });
    }
    if (!(await documentMatchesWorkspace(authorization, document))) return NextResponse.json({ error: "Document is outside the selected workspace." }, { status: 403 });
    const roleAccessResult = await supabaseAdmin
      .from("document_type_role_access")
      .select("role_id")
      .eq("company_id", companyId)
      .eq("document_type_id", document.document_type_id);
    if (roleAccessResult.error && !isMissingRoleAccessTable(roleAccessResult.error)) throw new Error(roleAccessResult.error.message);
    document.access_role_ids = (roleAccessResult.error ? [] : roleAccessResult.data ?? []).map((row) => row.role_id);
    if (!(await canDownloadDocument(document, authorization.locationScopeIds, authorization.hasAllLocationAccess || authorization.isMasterOwner, companyId, authorization.roleId))) {
      return NextResponse.json({ error: "Document access denied." }, { status: 403 });
    }

    if (asInline) {
      const signed = await supabaseAdmin.storage.from(document.storage_bucket).createSignedUrl(document.storage_path, 120);
      if (signed.error || !signed.data?.signedUrl) throw new Error("Unable to open document.");
      return NextResponse.redirect(signed.data.signedUrl, { headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
    }
    const file = await supabaseAdmin.storage.from(document.storage_bucket).download(document.storage_path);
    if (file.error) throw new Error(file.error.message);

    const filename = sanitizeFilename(document.file_name ?? "business-document");
    return new NextResponse(file.data, {
      headers: {
        "Content-Disposition": `${asInline ? "inline" : "attachment"}; filename="${filename}"`,
        "Content-Type": document.content_type || file.data.type || "application/octet-stream",
        "Cache-Control": "private, max-age=0, no-store"
      }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to download document." }, { status: 500 });
  }
}

function isMissingRoleAccessTable(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("document_type_role_access") &&
    (message.includes("does not exist") || message.includes("schema cache") || message.includes("could not find"));
}

async function canDownloadDocument(
  document: BusinessDocumentDownloadRow,
  locationScopeIds: string[],
  canSeeAllScopedDocs: boolean,
  companyId: string,
  roleId: string | null
) {
  const relation = Array.isArray(document.document_types) ? document.document_types[0] : document.document_types;
  if (canSeeAllScopedDocs) return true;
  if (relation?.doc_access_mode === "role_based") {
    const allowedRoleIds = document.access_role_ids ?? [];
    if (allowedRoleIds.length && (!roleId || !allowedRoleIds.includes(roleId))) return false;
  }

  const allowedLocationIds = new Set(locationScopeIds);
  if (document.scope_type === "location") {
    return Boolean(
      (document.scope_id && allowedLocationIds.has(document.scope_id)) ||
      (document.additional_scope_ids ?? []).some((id) => allowedLocationIds.has(id))
    );
  }
  if (document.scope_type === "state" && document.scope_id && supabaseAdmin) {
    const { data, error } = await supabaseAdmin
      .from("stations")
      .select("state")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .in("id", locationScopeIds);
    if (error) throw new Error(error.message);
    const allowedStates = new Set((data ?? []).map((location) => String(location.state ?? "").trim().toUpperCase()).filter(Boolean));
    return allowedStates.has(document.scope_id.toUpperCase()) ||
      (document.additional_scope_ids ?? []).some((id) => allowedStates.has(String(id).trim().toUpperCase()));
  }
  return document.scope_type === "company";
}

function sanitizeFilename(value: string) {
  return value.replace(/[\r\n"]/g, "").trim() || "business-document";
}
