import { documentMatchesWorkspace } from "@/lib/business-document-workspace";
import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { NextResponse, type NextRequest } from "next/server";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type BulkMode = "zip" | "single";

type BusinessDocumentDownloadRow = {
  id: string;
  document_type_id: string;
  scope_type: string;
  scope_id: string | null;
  scope_label: string | null;
  additional_scope_ids: string[] | null;
  file_name: string | null;
  content_type: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  document_types?: { name: string | null; doc_access_mode: string | null } | { name: string | null; doc_access_mode: string | null }[] | null;
  access_role_ids?: string[];
};

type DownloadableDocument = BusinessDocumentDownloadRow & {
  bytes: Uint8Array;
};

export async function POST(request: NextRequest) {
  try {
    const authorization = await requirePagePermission("business_documents", "access");
    const companyId = requireCompanyId(authorization);
    if (!supabaseAdmin) return NextResponse.json({ error: "Supabase service role key is not configured." }, { status: 500 });

    const body = await request.json().catch(() => null) as { ids?: unknown; mode?: unknown } | null;
    const ids = Array.from(new Set(Array.isArray(body?.ids) ? body.ids.map((id) => String(id)).filter(Boolean) : []));
    const mode: BulkMode = body?.mode === "single" ? "single" : "zip";
    if (!ids.length) return NextResponse.json({ error: "Select at least one document." }, { status: 400 });
    if (ids.length > 250) return NextResponse.json({ error: "Select 250 documents or fewer at a time." }, { status: 400 });

    const { data, error } = await supabaseAdmin
      .from("business_document_records")
      .select("id, document_type_id, scope_type, scope_id, scope_label, additional_scope_ids, file_name, content_type, storage_bucket, storage_path, document_types (name, doc_access_mode)")
      .eq("company_id", companyId)
      .eq("is_active", true)
      .in("id", ids);
    if (error) throw new Error(error.message);

    const documents = (data ?? []) as BusinessDocumentDownloadRow[];
    if (!documents.length) return NextResponse.json({ error: "No downloadable documents found." }, { status: 404 });

    const roleAccessResult = await supabaseAdmin
      .from("document_type_role_access")
      .select("document_type_id, role_id")
      .eq("company_id", companyId);
    if (roleAccessResult.error && !isMissingRoleAccessTable(roleAccessResult.error)) throw new Error(roleAccessResult.error.message);
    const roleAccessByType = new Map<string, string[]>();
    (roleAccessResult.error ? [] : roleAccessResult.data ?? []).forEach((row) => {
      const documentTypeId = String(row.document_type_id ?? "");
      const roleId = String(row.role_id ?? "");
      if (!documentTypeId || !roleId) return;
      roleAccessByType.set(documentTypeId, [...roleAccessByType.get(documentTypeId) ?? [], roleId]);
    });

    const downloadable: DownloadableDocument[] = [];
    for (const document of documents) {
      document.access_role_ids = roleAccessByType.get(document.document_type_id) ?? [];
      if (!document.storage_bucket || !document.storage_path) continue;
      const allowed = await canDownloadDocument(
        document,
        authorization.locationScopeIds,
        authorization.hasAllLocationAccess || authorization.isMasterOwner,
        companyId,
        authorization.roleId
      );
      if (!allowed || !(await documentMatchesWorkspace(authorization, document))) continue;
      const file = await supabaseAdmin.storage.from(document.storage_bucket).download(document.storage_path);
      if (file.error) throw new Error(file.error.message);
      downloadable.push({ ...document, bytes: new Uint8Array(await file.data.arrayBuffer()) });
    }

    if (!downloadable.length) return NextResponse.json({ error: "No selected files are available for download." }, { status: 404 });

    if (mode === "single") {
      const pdf = await buildSinglePdf(downloadable);
      return new NextResponse(new Blob([asArrayBuffer(pdf)], { type: "application/pdf" }), {
        headers: {
          "Content-Disposition": `attachment; filename="business-documents.pdf"`,
          "Content-Type": "application/pdf",
          "Cache-Control": "private, max-age=0, no-store"
        }
      });
    }

    const zip = new JSZip();
    const usedNames = new Set<string>();
    downloadable.forEach((document, index) => {
      zip.file(uniqueFilename(usedNames, document.file_name ?? `${documentName(document)}-${index + 1}`), document.bytes);
    });
    const zipped = await zip.generateAsync({ type: "uint8array" });
    return new NextResponse(new Blob([asArrayBuffer(zipped)], { type: "application/zip" }), {
      headers: {
        "Content-Disposition": `attachment; filename="business-documents.zip"`,
        "Content-Type": "application/zip",
        "Cache-Control": "private, max-age=0, no-store"
      }
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to download documents." }, { status: 500 });
  }
}

async function buildSinglePdf(documents: DownloadableDocument[]) {
  const output = await PDFDocument.create();
  const font = await output.embedFont(StandardFonts.Helvetica);
  const boldFont = await output.embedFont(StandardFonts.HelveticaBold);
  const unsupported: string[] = [];

  for (const document of documents) {
    const contentType = String(document.content_type ?? "").toLowerCase();
    const filename = document.file_name ?? documentName(document);
    try {
      if (contentType.includes("pdf") || filename.toLowerCase().endsWith(".pdf")) {
        const source = await PDFDocument.load(document.bytes, { ignoreEncryption: true });
        const pages = await output.copyPages(source, source.getPageIndices());
        pages.forEach((page) => output.addPage(page));
      } else if (contentType.includes("png") || filename.toLowerCase().endsWith(".png")) {
        const image = await output.embedPng(document.bytes);
        addImagePage(output, image, filename, boldFont);
      } else if (contentType.includes("jpeg") || contentType.includes("jpg") || /\.(jpe?g)$/i.test(filename)) {
        const image = await output.embedJpg(document.bytes);
        addImagePage(output, image, filename, boldFont);
      } else {
        unsupported.push(filename);
      }
    } catch {
      unsupported.push(filename);
    }
  }

  if (!output.getPageCount() || unsupported.length) {
    const page = output.addPage([595, 842]);
    page.drawText("Business documents", { x: 48, y: 790, size: 18, font: boldFont, color: rgb(0.1, 0.1, 0.1) });
    const lines = unsupported.length
      ? ["The following files could not be merged into the single PDF:", ...unsupported.map((name) => `- ${name}`)]
      : ["No PDF or image files were available to merge."];
    lines.slice(0, 38).forEach((line, index) => {
      page.drawText(line, { x: 48, y: 750 - index * 18, size: 11, font, color: rgb(0.25, 0.25, 0.25) });
    });
  }

  return await output.save();
}

function addImagePage(pdf: PDFDocument, image: { width: number; height: number; scale: (factor: number) => { width: number; height: number } }, filename: string, font: Awaited<ReturnType<PDFDocument["embedFont"]>>) {
  const page = pdf.addPage([595, 842]);
  page.drawText(filename.slice(0, 90), { x: 36, y: 806, size: 11, font, color: rgb(0.2, 0.2, 0.2) });
  const maxWidth = 523;
  const maxHeight = 740;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  const size = image.scale(scale);
  page.drawImage(image as never, {
    x: (595 - size.width) / 2,
    y: 36 + (maxHeight - size.height) / 2,
    width: size.width,
    height: size.height
  });
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

function documentName(document: BusinessDocumentDownloadRow) {
  const relation = Array.isArray(document.document_types) ? document.document_types[0] : document.document_types;
  return relation?.name || document.scope_label || "business-document";
}

function uniqueFilename(used: Set<string>, value: string) {
  const clean = sanitizeFilename(value);
  const dot = clean.lastIndexOf(".");
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  let candidate = clean;
  let count = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}-${count}${ext}`;
    count += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function sanitizeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|\r\n]/g, "-").trim() || "business-document";
}

function asArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
