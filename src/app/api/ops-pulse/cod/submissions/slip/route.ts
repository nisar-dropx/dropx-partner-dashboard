import { NextResponse } from "next/server";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { depositAttachmentsFor, type CodAttachment, type CodSubmissionRow } from "@/lib/ops-pulse/cod";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const canView =
      hasPermission(authorization, "cod_submission", "access") ||
      hasPermission(authorization, "cod_reports", "access") ||
      hasPermission(authorization, "cod_validation", "access");
    if (!canView) {
      return NextResponse.json({ error: "COD submission access denied." }, { status: 403 });
    }
    if (!supabaseAdmin) {
      return NextResponse.json({ error: "Database is not configured." }, { status: 503 });
    }

    const companyId = requireCompanyId(authorization);
    const { searchParams } = new URL(request.url);
    const id = String(searchParams.get("id") ?? "").trim();
    if (!id) {
      return NextResponse.json({ error: "Submission id is required." }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from("cod_submissions")
      .select("id, company_id, location_id, attachments, deposit_slip_attachments")
      .eq("company_id", companyId)
      .eq("id", id)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Submission not found." }, { status: 404 });

    const row = data as Pick<CodSubmissionRow, "id" | "location_id" | "attachments" | "deposit_slip_attachments">;
    if (
      !authorization.hasAllLocationAccess &&
      row.location_id &&
      !authorization.locationScopeIds.includes(row.location_id)
    ) {
      return NextResponse.json({ error: "Station access denied." }, { status: 403 });
    }

    const attachment = depositAttachmentsFor(row)[0] as CodAttachment | undefined;
    if (!attachment?.storage_bucket || !attachment.storage_path) {
      return NextResponse.json({ error: "Deposit slip is not available." }, { status: 404 });
    }

    const file = await supabaseAdmin.storage.from(attachment.storage_bucket).download(attachment.storage_path);
    if (file.error || !file.data) {
      return NextResponse.json({ error: file.error?.message || "Unable to download slip." }, { status: 500 });
    }

    const bytes = await file.data.arrayBuffer();
    const disposition = searchParams.get("download") === "1" ? "attachment" : "inline";
    const fileName = attachment.file_name || "deposit-slip.jpg";
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": attachment.content_type || "image/jpeg",
        "Content-Disposition": `${disposition}; filename="${fileName.replace(/"/g, "")}"`,
        "Cache-Control": "private, max-age=60"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load deposit slip.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
