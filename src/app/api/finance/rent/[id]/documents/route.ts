import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { canWriteRent, financeContext } from "@/lib/finance/data";
import { rentalDocumentBucket, rentalDocumentMaxBytes, validateRentalFile, verifyRentalFileBytes } from "@/lib/finance/rental-document";
import { permittedRent, privateFileHeaders, rentalDocumentFields } from "@/lib/finance/rental-document-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: privateFileHeaders });

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const context = await financeContext("finance_rent");
  try {
    const rent = await permittedRent(context, params.id);
    if (!rent) return json({ error: "Rental agreement not found or outside your access." }, 404);
    const { data, error } = await context.db.from("finance_rent_documents")
      .select(rentalDocumentFields).eq("company_id", context.companyId).eq("rent_id", rent.id)
      .order("uploaded_at", { ascending: false }).order("id").limit(50);
    if (error) throw new Error("Unable to load rental documents. Please retry.");
    return json({ documents: data, currentId: rent.agreement_document_id, updatedAt: rent.updated_at });
  } catch {
    return json({ error: "Unable to load rental documents. Please retry." }, 500);
  }
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const context = await financeContext("finance_rent");
  if (!canWriteRent(context.authorization, true)) return json({ error: "Your Finance role cannot upload or replace rental documents." }, 403);
  // Cookie-authenticated uploads must originate from this portal, not another website.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const origin = request.headers.get("origin");
  let originHost = "";
  try { originHost = origin ? new URL(origin).host : ""; } catch { /* Deny malformed origins. */ }
  if (!originHost || originHost !== host) return json({ error: "Open Rent Master to upload this document." }, 403);
  if (Number(request.headers.get("content-length") || 0) > rentalDocumentMaxBytes + 65536)
    return json({ error: "Choose a file up to 4 MB." }, 413);

  try {
    const rent = await permittedRent(context, params.id);
    if (!rent) return json({ error: "Rental agreement not found or outside your access." }, 404);
    const form = await request.formData();
    const file = form.get("file");
    const expected = String(form.get("expected_updated_at") || "");
    if (!(file instanceof File)) return json({ error: "Choose a rental agreement to upload." }, 400);
    if (!expected || Number.isNaN(Date.parse(expected))) return json({ error: "Reopen this agreement before uploading." }, 400);
    if (Date.parse(expected) !== Date.parse(rent.updated_at)) return json({ error: "This agreement changed. Reopen it before uploading." }, 409);
    let validated;
    let bytes: Buffer;
    try {
      validated = validateRentalFile(file);
      bytes = Buffer.from(await file.arrayBuffer());
      verifyRentalFileBytes(bytes, validated.type);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Invalid file." }, 400);
    }
    const id = randomUUID();
    const path = `${context.companyId}/${rent.id}/${id}.${validated.extension}`;
    const uploaded = await context.db.storage.from(rentalDocumentBucket).upload(path, bytes, {
      contentType: validated.type, upsert: false, cacheControl: "0",
    });
    if (uploaded.error) return json({ error: "The file could not be uploaded. Your previous document is unchanged." }, 502);
    const attached = await context.db.rpc("finance_attach_rent_document", {
      p_company: context.companyId, p_actor: context.authorization.userId, p_rent: rent.id,
      p_expected_updated_at: expected, p_allocation: rent.allocation_station_code,
      p_document: { id, file_name: validated.name, content_type: validated.type,
        file_size: bytes.length, storage_path: path, sha256: createHash("sha256").update(bytes).digest("hex") },
    });
    if (attached.error) {
      // A network error may arrive after a successful commit. Never delete a linked file.
      const check = await context.db.from("finance_rent_documents").select("id")
        .eq("company_id", context.companyId).eq("rent_id", rent.id).eq("id", id).maybeSingle();
      if (!check.error && !check.data) {
        await context.db.storage.from(rentalDocumentBucket).remove([path]);
        return json({ error: attached.error.message.includes("Rent changed")
          ? "This agreement changed during upload. Reopen it and try again."
          : "Unable to save the document. Your previous document is unchanged." }, 409);
      }
      if (check.error) return json({ error: "Upload confirmation was interrupted. Reopen Documents to check before retrying." }, 503);
    }
    revalidatePath("/master/rent");
    return json({ ok: true, id }, 201);
  } catch {
    return json({ error: "The connection was interrupted. Reopen Documents to check before retrying." }, 500);
  }
}
