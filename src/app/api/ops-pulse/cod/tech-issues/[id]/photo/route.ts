import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const canView =
      hasPermission(authorization, "cod_executive_reconciliation", "access") ||
      hasPermission(authorization, "cod_reports", "access");
    if (!canView) {
      return NextResponse.json({ error: "COD access denied." }, { status: 403 });
    }
    if (!supabaseAdmin) {
      return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
    }

    const companyId = requireCompanyId(authorization);
    const id = String(params.id ?? "").trim();
    if (!id) return NextResponse.json({ error: "Tech issue id is required." }, { status: 400 });

    const { data, error } = await supabaseAdmin
      .from("cod_tech_issues")
      .select("id, location_id, photo_storage_bucket, photo_storage_path")
      .eq("company_id", companyId)
      .eq("id", id)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Tech issue not found." }, { status: 404 });

    if (!authorization.hasAllLocationAccess && !authorization.locationScopeIds.includes(data.location_id)) {
      return NextResponse.json({ error: "Station access denied." }, { status: 403 });
    }
    if (!data.photo_storage_bucket || !data.photo_storage_path) {
      return NextResponse.json({ error: "No photo is attached (or it was removed once the issue was resolved)." }, { status: 404 });
    }

    const file = await supabaseAdmin.storage.from(data.photo_storage_bucket).download(data.photo_storage_path);
    if (file.error || !file.data) {
      return NextResponse.json({ error: file.error?.message || "Unable to download photo." }, { status: 500 });
    }

    const bytes = await file.data.arrayBuffer();
    const { searchParams } = new URL(request.url);
    const disposition = searchParams.get("download") === "1" ? "attachment" : "inline";
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": file.data.type || "image/jpeg",
        "Content-Disposition": `${disposition}; filename="tech-issue-${id}.jpg"`,
        "Cache-Control": "private, no-store"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load tech issue photo.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
