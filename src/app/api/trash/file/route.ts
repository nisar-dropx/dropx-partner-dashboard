import { NextResponse, type NextRequest } from "next/server";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

type TrashFileRow = {
  file_name: string | null;
  content_type: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const permission = await requirePagePermission("trash", "access");
    const companyId = requireCompanyId(permission);
    if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });

    const source = request.nextUrl.searchParams.get("source");
    const id = request.nextUrl.searchParams.get("id");
    const asInline = request.nextUrl.searchParams.get("disposition") === "inline";
    if ((source !== "business" && source !== "fleet" && source !== "profile") || !id) {
      return NextResponse.json({ error: "Trash file is required." }, { status: 400 });
    }

    const query = supabaseAdmin
      .from(source === "business" ? "business_document_records" : source === "fleet" ? "fleet_vehicle_documents" : "profile_document_trash")
      .select("file_name, content_type, storage_bucket, storage_path")
      .eq("company_id", companyId)
      .eq("id", id);
    const { data, error } = source === "profile"
      ? await query.maybeSingle()
      : await query.eq("is_active", false).maybeSingle();
    if (error) throw new Error(error.message);

    const row = data as TrashFileRow | null;
    if (!row?.storage_bucket || !row.storage_path) {
      return NextResponse.json({ error: "Trash file is not available." }, { status: 404 });
    }

    const file = await supabaseAdmin.storage.from(row.storage_bucket).download(row.storage_path);
    if (file.error) throw new Error(file.error.message);

    const filename = sanitizeFilename(row.file_name ?? "trash-file");
    return new NextResponse(file.data, {
      headers: {
        "Content-Disposition": `${asInline ? "inline" : "attachment"}; filename="${filename}"`,
        "Content-Type": row.content_type || file.data.type || "application/octet-stream",
        "Cache-Control": "private, max-age=0, no-store"
      }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load trash file." }, { status: 500 });
  }
}

function sanitizeFilename(value: string) {
  return value.replace(/[\r\n"]/g, "").trim() || "trash-file";
}
