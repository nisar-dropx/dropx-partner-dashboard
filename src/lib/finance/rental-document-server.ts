import "server-only";
import type { FinanceContext } from "./data";
import { rentalDocumentUuid } from "./rental-document";

export async function permittedRent(context: FinanceContext, id: string) {
  if (!rentalDocumentUuid.test(id)) return null;
  let query = context.db.from("finance_rent_master")
    .select("id,allocation_station_code,agreement_document_id,updated_at")
    .eq("company_id", context.companyId).eq("id", id).is("deleted_at", null);
  if (!context.authorization.hasAllLocationAccess)
    query = query.in("allocation_station_code", context.locations.length
      ? context.locations.map((location) => location.station_code) : ["__no_access__"]);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error("Unable to load this rental agreement. Please retry.");
  return data;
}

export const rentalDocumentFields = "id,file_name,content_type,file_size,uploaded_at";
export const privateFileHeaders = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
