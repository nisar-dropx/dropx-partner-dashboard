import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requirePagePermission, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { isFinanceHostName } from "@/lib/finance/surface";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { PDFDocument } from "pdf-lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
const bucket = "finance-reimbursement-policies";
const privateHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: privateHeaders });
async function context() {
  if (
    !isFinanceHostName(
      headers().get("x-forwarded-host") ?? headers().get("host") ?? "",
    )
  )
    throw new Error("Open Finance to manage this policy.");
  const auth = await requirePagePermission("master_payment_heads", "view");
  if (!supabaseAdmin) throw new Error("Finance is unavailable.");
  return { auth, company: requireCompanyId(auth), db: supabaseAdmin };
}
export async function GET(request: Request) {
  const c = await context();
  const id = new URL(request.url).searchParams.get("id");
  let query = c.db
    .from("finance_reimbursement_documents")
    .select("*")
    .eq("company_id", c.company);
  query = id ? query.eq("id", id) : query.eq("is_current", true);
  const { data, error } = await query.maybeSingle();
  if (error || !data)
    return json({ error: "Policy document unavailable." }, 404);
  const download = new URL(request.url).searchParams.get("download") === "1";
  const signed = await c.db.storage
    .from(bucket)
    .createSignedUrl(
      data.storage_path,
      120,
      download ? { download: data.file_name } : undefined,
    );
  if (signed.error || !signed.data)
    return json({ error: "Unable to open policy." }, 502);
  return new Response(null, {
    status: 302,
    headers: { ...privateHeaders, Location: signed.data.signedUrl },
  });
}
export async function POST(request: Request) {
  const c = await context();
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  let origin = "";
  try {
    origin = new URL(request.headers.get("origin") ?? "").host;
  } catch {
    /* fail closed */
  }
  if (
    !origin ||
    origin !== host ||
    c.auth.readOnly ||
    c.auth.isPreview ||
    !c.auth.hasAllLocationAccess
  )
    return json({ error: "Company-wide Finance access is required." }, 403);
  if (Number(request.headers.get("content-length") || 0) > 4259840)
    return json({ error: "Choose a PDF up to 4 MB." }, 413);
  try {
    const form = await request.formData();
    const expected = String(form.get("expected_id") || "") || null;
    if (
      !hasPermission(c.auth, "master_payment_heads", expected ? "edit" : "add")
    )
      return json(
        { error: "Your Finance role cannot publish this document." },
        403,
      );
    const file = form.get("file");
    const title = String(form.get("title") || "").trim();
    const version = String(form.get("version_label") || "").trim();
    const effective = String(form.get("effective_from") || "");
    if (
      !(file instanceof File) ||
      !file.name.toLowerCase().endsWith(".pdf") ||
      file.size < 5 ||
      file.size > 4194304
    )
      return json({ error: "Choose a PDF up to 4 MB." }, 400);
    if (
      title.length < 3 ||
      title.length > 160 ||
      !version ||
      version.length > 60 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(effective)
    )
      return json({ error: "Enter a title, version and effective date." }, 400);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.subarray(0, 5).toString() !== "%PDF-")
      return json({ error: "This is not a valid PDF." }, 400);
    try {
      const pdf = await PDFDocument.load(bytes);
      if (!pdf.getPageCount() || pdf.getPageCount() > 200) throw new Error();
    } catch {
      return json(
        { error: "Upload a readable, unencrypted PDF with up to 200 pages." },
        400,
      );
    }
    const id = randomUUID();
    const path = `${c.company}/${id}.pdf`;
    const fileName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-150);
    const uploaded = await c.db.storage
      .from(bucket)
      .upload(path, bytes, {
        contentType: "application/pdf",
        upsert: false,
        cacheControl: "0",
      });
    if (uploaded.error)
      return json(
        { error: "Upload failed. The previous policy is unchanged." },
        502,
      );
    const result = await c.db.rpc("finance_publish_reimbursement_document", {
      p_company: c.company,
      p_actor: c.auth.userId,
      p_expected_id: expected,
      p_document: {
        id,
        title,
        version_label: version,
        effective_from: effective,
        file_name: fileName,
        storage_path: path,
        file_size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    if (result.error) {
      const check = await c.db
        .from("finance_reimbursement_documents")
        .select("id")
        .eq("company_id", c.company)
        .eq("id", id)
        .maybeSingle();
      if (check.error)
        return json(
          {
            error:
              "Publication confirmation interrupted. Refresh before retrying.",
          },
          503,
        );
      if (!check.data) {
        await c.db.storage.from(bucket).remove([path]);
        return json({ error: result.error.message }, 409);
      }
    }
    revalidatePath("/master/reimbursements");
    return json({ ok: true, id }, 201);
  } catch {
    return json(
      {
        error:
          "Unable to publish. Refresh the master to check before retrying.",
      },
      500,
    );
  }
}
