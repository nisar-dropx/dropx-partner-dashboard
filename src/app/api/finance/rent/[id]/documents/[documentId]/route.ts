import { financeContext } from "@/lib/finance/data";
import { rentalDocumentBucket, rentalDocumentUuid } from "@/lib/finance/rental-document";
import { permittedRent, privateFileHeaders } from "@/lib/finance/rental-document-server";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { id: string; documentId: string } }) {
  const context = await financeContext("finance_rent");
  const unavailable = () => Response.json({ error: "Document not found or outside your access." }, { status: 404, headers: privateFileHeaders });
  try {
    if (!rentalDocumentUuid.test(params.documentId)) return unavailable();
    const rent = await permittedRent(context, params.id);
    if (!rent) return unavailable();
    const { data, error } = await context.db.from("finance_rent_documents")
      .select("storage_path,file_name").eq("company_id", context.companyId)
      .eq("rent_id", rent.id).eq("id", params.documentId).maybeSingle();
    if (error || !data || !data.storage_path.startsWith(`${context.companyId}/${rent.id}/${params.documentId}.`)) return unavailable();
    const download = new URL(request.url).searchParams.get("download") === "1";
    const signed = await context.db.storage.from(rentalDocumentBucket)
      .createSignedUrl(data.storage_path, 120, download ? { download: data.file_name } : undefined);
    if (signed.error || !signed.data?.signedUrl) throw new Error("File unavailable");
    return new Response(null, { status: 302, headers: { ...privateFileHeaders, Location: signed.data.signedUrl, "Referrer-Policy": "no-referrer" } });
  } catch {
    return Response.json({ error: "Unable to open the document. Please retry." }, { status: 503, headers: privateFileHeaders });
  }
}
