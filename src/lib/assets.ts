import "server-only";

import type { FinanceContext } from "@/lib/finance/data";

export type AssetOwnership = "owned" | "rented" | "leased";
export type AssetCondition = "good" | "fair" | "damaged" | "unusable";

export type AssetRentalTerm = {
  id: string;
  asset_id: string;
  vendor_name: string;
  agreement_number: string | null;
  invoice_number: string | null;
  rental_rate: string | number;
  billing_frequency: string;
  security_deposit: string | number;
  starts_on: string;
  ends_on: string | null;
  notice_period_days: number;
  off_hire_date: string | null;
  status: string;
};

export type AssetRow = {
  id: string;
  asset_code: string;
  barcode_value: string;
  asset_type_id: string;
  location_id: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  purchase_order_number: string | null;
  invoice_number: string | null;
  purchase_date: string | null;
  purchase_value: string | number | null;
  gst_rate: string | number | null;
  gst_amount: string | number | null;
  total_value: string | number | null;
  warranty_expiry_date: string | null;
  vendor_name: string | null;
  ownership_type: AssetOwnership;
  status: string;
  condition: AssetCondition;
  notes: string | null;
  created_at: string;
  type_name: string;
  type_code: string;
  category_name: string;
  attachments: Array<{ id: string; attachment_type: string; file_name: string; content_type: string | null; signed_url: string | null; uploaded_at: string }>;
  history: Array<{ event_type: string; notes: string | null; created_at: string; source: "event" | "audit" }>;
  rental_term: AssetRentalTerm | null;
};

export type AssetTypeOption = {
  id: string;
  name: string;
  code: string;
  category_id: string;
  category_name: string;
  asset_code_prefix: string;
};

function normalizeText(value: unknown, max = 160) {
  return String(value ?? "").trim().slice(0, max);
}

export function assetPrefix(value: string) {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return compact.length >= 2 ? compact : "DXA";
}

export function conditionLabel(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export async function loadAssetRegister(context: FinanceContext) {
  const assets: Array<Record<string, unknown>> = [];
  for (let offset = 0; ; offset += 1000) {
    let query = context.db.from("assets")
      .select("id,asset_type_id,asset_code,barcode_value,location_id,manufacturer,model,serial_number,purchase_order_number,invoice_number,purchase_date,purchase_value,gst_rate,gst_amount,total_value,warranty_expiry_date,vendor_name,ownership_type,status,condition,notes,created_at")
      .eq("company_id", context.companyId).eq("is_active", true)
      .order("created_at", { ascending: false }).order("id").range(offset, offset + 999);
    if (!context.authorization.hasAllLocationAccess)
      query = query.in("location_id", context.locations.length ? context.locations.map((item) => item.id) : ["00000000-0000-0000-0000-000000000000"]);
    const { data, error } = await query;
    if (error) throw new Error("Unable to load the asset register.");
    assets.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const typeResult = await context.db.from("asset_types")
    .select("id,category_id,name,code,asset_code_prefix,asset_categories!asset_types_company_id_category_id_fkey(name)")
    .eq("company_id", context.companyId).eq("is_active", true).order("name");
  if (typeResult.error) throw new Error("Unable to load asset types.");
  const typeById = new Map((typeResult.data ?? []).map((type: Record<string, unknown>) => {
    const category = Array.isArray(type.asset_categories) ? type.asset_categories[0] : type.asset_categories;
    return [String(type.id), {
      id: String(type.id), name: String(type.name), code: String(type.code), category_id: String(type.category_id),
      category_name: normalizeText((category as Record<string, unknown> | null)?.name, 120) || "Uncategorized",
      asset_code_prefix: assetPrefix(String(type.asset_code_prefix || type.code)),
    } satisfies AssetTypeOption];
  }));
  const ids = assets.map((asset) => String(asset.id));
  const [attachmentResult, rentalResult, eventResult, auditItemResult] = ids.length ? await Promise.all([
    context.db.from("asset_attachments").select("id,asset_id,attachment_type,file_name,content_type,storage_bucket,storage_path,uploaded_at").eq("company_id", context.companyId).in("asset_id", ids).order("uploaded_at", { ascending: true }),
    context.db.from("asset_rental_terms").select("id,asset_id,vendor_name,agreement_number,invoice_number,rental_rate,billing_frequency,security_deposit,starts_on,ends_on,notice_period_days,off_hire_date,status").eq("company_id", context.companyId).in("asset_id", ids).in("status", ["draft", "active", "notice_given"]).order("starts_on", { ascending: false }),
    context.db.from("asset_events").select("asset_id,event_type,notes,created_at").eq("company_id", context.companyId).in("asset_id", ids).order("created_at", { ascending: false }).limit(2000),
    context.db.from("asset_audit_items").select("asset_id,observed_condition,notes,observed_at,asset_audit_sessions(audit_number,title)").eq("company_id", context.companyId).in("asset_id", ids).order("observed_at", { ascending: false }).limit(2000),
  ]) : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
  if (attachmentResult.error || rentalResult.error || eventResult.error || auditItemResult.error) throw new Error("Unable to load asset supporting records.");
  const attachmentUrlById = new Map<string, string | null>();
  for (const attachment of attachmentResult.data ?? []) {
    const item = attachment as Record<string, unknown>;
    const bucket = normalizeText(item.storage_bucket, 80);
    const path = normalizeText(item.storage_path, 400);
    if (!bucket || !path) { attachmentUrlById.set(String(item.id), null); continue; }
    const { data } = await context.db.storage.from(bucket).createSignedUrl(path, 60 * 60);
    attachmentUrlById.set(String(item.id), data?.signedUrl ?? null);
  }
  const attachmentsByAsset = new Map<string, AssetRow["attachments"]>();
  (attachmentResult.data ?? []).forEach((attachment: Record<string, unknown>) => {
    const assetId = String(attachment.asset_id);
    attachmentsByAsset.set(assetId, [...(attachmentsByAsset.get(assetId) ?? []), {
      id: String(attachment.id), attachment_type: String(attachment.attachment_type), file_name: String(attachment.file_name),
      content_type: attachment.content_type ? String(attachment.content_type) : null, signed_url: attachmentUrlById.get(String(attachment.id)) ?? null,
      uploaded_at: String(attachment.uploaded_at ?? ""),
    }]);
  });
  const termsByAsset = new Map<string, AssetRentalTerm>();
  (rentalResult.data ?? []).forEach((term: Record<string, unknown>) => {
    const assetId = String(term.asset_id);
    if (!termsByAsset.has(assetId)) termsByAsset.set(assetId, term as unknown as AssetRentalTerm);
  });
  const historyByAsset = new Map<string, AssetRow["history"]>();
  (eventResult.data ?? []).forEach((event: Record<string, unknown>) => {
    const assetId = String(event.asset_id);
    const history = historyByAsset.get(assetId) ?? [];
    history.push({ event_type: String(event.event_type), notes: event.notes ? String(event.notes) : null, created_at: String(event.created_at), source: "event" });
    historyByAsset.set(assetId, history);
  });
  (auditItemResult.data ?? []).forEach((item: Record<string, unknown>) => {
    const assetId = String(item.asset_id);
    const audit = Array.isArray(item.asset_audit_sessions) ? item.asset_audit_sessions[0] : item.asset_audit_sessions;
    const auditRecord = audit as Record<string, unknown> | null;
    const label = normalizeText(auditRecord?.audit_number, 60) || "Audit";
    const condition = conditionLabel(String(item.observed_condition || "verified"));
    const notes = [condition, normalizeText(item.notes, 1000)].filter(Boolean).join(" · ");
    historyByAsset.set(assetId, [...(historyByAsset.get(assetId) ?? []), {
      event_type: `Audit verification · ${label}`, notes, created_at: String(item.observed_at ?? ""), source: "audit",
    }]);
  });
  historyByAsset.forEach((history) => history.sort((a, b) => b.created_at.localeCompare(a.created_at)));
  return {
    assets: assets.map((asset) => {
      const type = typeById.get(String(asset.asset_type_id));
      return {
        ...asset,
        id: String(asset.id), asset_code: String(asset.asset_code), barcode_value: String(asset.barcode_value),
        asset_type_id: String(asset.asset_type_id), location_id: asset.location_id ? String(asset.location_id) : null,
        ownership_type: (asset.ownership_type === "rented" || asset.ownership_type === "leased" ? asset.ownership_type : "owned") as AssetOwnership,
        condition: (asset.condition === "fair" || asset.condition === "damaged" || asset.condition === "unusable" ? asset.condition : "good") as AssetCondition,
        status: String(asset.status || "available"), created_at: String(asset.created_at),
        type_name: type?.name ?? "Unknown type", type_code: type?.code ?? "—", category_name: type?.category_name ?? "Uncategorized",
        attachments: attachmentsByAsset.get(String(asset.id)) ?? [], history: historyByAsset.get(String(asset.id)) ?? [], rental_term: termsByAsset.get(String(asset.id)) ?? null,
      } as AssetRow;
    }),
    types: Array.from(typeById.values()),
  };
}
