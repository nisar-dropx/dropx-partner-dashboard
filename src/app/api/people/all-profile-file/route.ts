import { NextResponse, type NextRequest } from "next/server";
import { getAuthorization, hasPermission, isCompanyOwner } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { canAccessDesignationPortal } from "@/lib/designation-portal-access";
import { dynamicWorkforceTable, isCustomWorkforceCategoryCode, normalizeWorkforceCategoryCode } from "@/lib/dynamic-workforce";
import { profileDocumentBucket } from "@/lib/profile-document-storage";
import { supabaseAdmin } from "@/lib/supabase-admin";

const attachmentFields: Record<string, string> = {
  aadhaarFrontFile: "aadhaar_front_path",
  aadhaarBackFile: "aadhaar_back_path",
  panFile: "pan_upload_path",
  drivingLicenseFrontFile: "dl_front_path",
  drivingLicenseBackFile: "dl_back_path",
  profilePhotoFile: "profile_photo_path"
};

type ProfileSource = {
  table: string;
  designationField: "designation_id" | "designation";
};

const fixedSources: Record<string, ProfileSource> = {
  employees: { table: "employees", designationField: "designation_id" },
  contractors: { table: "contractors", designationField: "designation" },
  vendors: { table: "vendors", designationField: "designation" },
  workers: { table: "helpers", designationField: "designation" },
  workforce: { table: "workforce", designationField: "designation_id" }
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sourceFor(category: string) {
  const fixed = fixedSources[category];
  if (fixed) return fixed;
  if (!isCustomWorkforceCategoryCode(category)) return null;
  return { table: dynamicWorkforceTable(category), designationField: "designation" } satisfies ProfileSource;
}

function safeFilename(path: string) {
  const filename = path.split("/").pop() ?? "profile-attachment";
  return filename.replace(/[\r\n"]/g, "").trim() || "profile-attachment";
}

function previewContentType(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x42, 0x4d)) return "image/bmp";
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return "image/tiff";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return "";
}

export async function GET(request: NextRequest) {
  try {
    const authorization = await getAuthorization();
    if (!authorization) return NextResponse.json({ error: "Login is required." }, { status: 401 });
    if (!hasPermission(authorization, "people_all", "access")) {
      return NextResponse.json({ error: "You do not have access to All People." }, { status: 403 });
    }
    if (!supabaseAdmin) return NextResponse.json({ error: "Profile storage is not configured." }, { status: 500 });

    const companyId = requireCompanyId(authorization);
    const category = normalizeWorkforceCategoryCode(request.nextUrl.searchParams.get("category"));
    const id = String(request.nextUrl.searchParams.get("id") ?? "").trim();
    const column = attachmentFields[String(request.nextUrl.searchParams.get("field") ?? "")];
    const source = sourceFor(category);
    if (!source || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !column) {
      return NextResponse.json({ error: "Choose a valid profile attachment." }, { status: 400 });
    }

    const categoryResult = await supabaseAdmin.from("workforce_categories")
      .select("code")
      .eq("company_id", companyId)
      .eq("code", category)
      .eq("is_active", true)
      .maybeSingle();
    if (categoryResult.error) throw new Error(categoryResult.error.message);
    if (!categoryResult.data) return NextResponse.json({ error: "People category was not found." }, { status: 404 });

    const result = await supabaseAdmin.from(source.table)
      .select(`location_id, ${column}, ${source.designationField}`)
      .eq("company_id", companyId)
      .eq("id", id)
      .maybeSingle();
    if (result.error) throw new Error(result.error.message);
    const row = result.data as unknown as Record<string, unknown> | null;
    if (!row) return NextResponse.json({ error: "Profile was not found." }, { status: 404 });

    const ownerAccess = isCompanyOwner(authorization);
    const locationId = String(row.location_id ?? "").trim();
    if (!ownerAccess && !authorization.hasAllLocationAccess &&
        (!locationId || !authorization.locationScopeIds.includes(locationId))) {
      return NextResponse.json({ error: "Attachment access denied." }, { status: 403 });
    }

    const designationResult = await supabaseAdmin.from("designations")
      .select("id, name, portal_permissions")
      .eq("company_id", companyId)
      .eq("is_active", true);
    if (designationResult.error) throw new Error(designationResult.error.message);
    const designationValue = String(row[source.designationField] ?? "").trim();
    const designation = (designationResult.data ?? []).find((item) => source.designationField === "designation_id"
      ? String(item.id ?? "") === designationValue
      : String(item.name ?? "").trim().toLowerCase() === designationValue.toLowerCase());
    if (!canAccessDesignationPortal(designation, "dashboard", "view", { isOwner: ownerAccess })) {
      return NextResponse.json({ error: "Attachment access denied." }, { status: 403 });
    }

    const storagePath = String(row[column] ?? "").trim();
    if (!storagePath) return NextResponse.json({ error: "Attachment is not available." }, { status: 404 });
    const file = await supabaseAdmin.storage.from(profileDocumentBucket).download(storagePath);
    if (file.error) throw new Error(file.error.message);
    const body = await file.data.arrayBuffer();
    const contentType = previewContentType(body);
    if (!contentType) {
      return NextResponse.json({ error: "This file type cannot be shown in the view-only preview." }, { status: 415 });
    }

    return new NextResponse(body, {
      headers: {
        "Content-Disposition": `inline; filename="${safeFilename(storagePath)}"`,
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'",
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=0, no-store",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unable to load profile attachment."
    }, { status: 500 });
  }
}
