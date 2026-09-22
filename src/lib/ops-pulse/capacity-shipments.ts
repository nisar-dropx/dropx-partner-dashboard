import { unstable_cache } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase-admin";

export type CapacityStationDay = {
  station_code: string;
  work_date: string;
  active_ids: number | string;
  low_volume_ids: number | string;
  delivered: number | string;
  shipment_count: number | string;
  inbound: number | string;
  detail_active_ids: number | string;
  daily_count_active_ids: number | string;
  volume_source: string;
};

export type CapacityAssociateDay = {
  station_code: string;
  work_date: string;
  associate_id: string;
  associate_name: string | null;
  delivered: number | string;
  volumetric: number | string;
  small: number | string;
  unclassified: number | string;
};

export type CapacityPincode = {
  postal_code: string;
  delivered: number | string;
  active_ids: number | string;
  active_days: number | string;
  weight_ready: number | string;
  dimension_ready: number | string;
  volumetric: number | string;
  small: number | string;
  unclassified: number | string;
  average_weight_kg: number | string | null;
  average_cubic_cm3: number | string | null;
};

export type CapacityAssociateDeliveredDay = {
  work_date: string;
  delivered: number | string;
  volumetric: number | string;
  small: number | string;
  unclassified: number | string;
};

export type CapacityAssociatePincode = {
  postal_code: string;
  delivered: number | string;
  active_days: number | string;
  volumetric: number | string;
  small: number | string;
  unclassified: number | string;
};

export type ShipmentCountAssociateDay = {
  client: string;
  station_code: string;
  work_date: string;
  provider_employee_id: string;
  provider_employee_name: string | null;
  amazon_delivery: number | string | null;
  swa_delivery: number | string | null;
  c_return: number | string | null;
  total_delivery: number | string | null;
  variable_pay: number | string | null;
  mg_pay: number | string | null;
  fuel_pay: number | string | null;
  da_total_pay: number | string | null;
  pay_type: string | null;
  mapping_status: string | null;
};

export type CapacityDeliveryBreakdown = {
  source_batch_id: string | null;
  station_code: string;
  work_date: string;
  provider_employee_id: string;
  provider_employee_name: string | null;
  shipment_type: string | null;
  assigned_count: number | string | null;
  amazon_delivery: number | string | null;
  swa_delivery: number | string | null;
  c_return: number | string | null;
  mfn: number | string | null;
  mfn_return: number | string | null;
  total_delivery: number | string | null;
  total_activity: number | string | null;
  smd_delivery: number;
  smd2_delivery: number;
  base_amazon_delivery: number;
  variable_pay: number | string | null;
  mg_pay: number | string | null;
  fuel_pay: number | string | null;
  da_total_pay: number | string | null;
  pay_type: string | null;
  mapping_status: string | null;
};

type ShipmentAuditRow = {
  batch_id: string;
  work_date: string;
  station_code: string;
  external_worker_id: string | null;
  normalized_data: Record<string, unknown> | null;
  raw_data: Record<string, unknown> | null;
  row_number: number;
};

const ASSOCIATE_PAGE_SIZE = 1000;

function associateKey(stationCode: string, workDate: string, associateId: string) {
  return `${stationCode.trim().toUpperCase()}|${workDate}|${associateId.trim().toUpperCase()}`;
}

function normalizedAssociateName(value: string | null | undefined) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase();
}

function numberValue(value: unknown) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedMetricKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/20$/, "2");
}

function exactRawMetric(raw: Record<string, unknown> | null, aliases: string[]) {
  if (!raw) return 0;
  const wanted = new Set(aliases.map(normalizedMetricKey));
  const entry = Object.entries(raw).find(([label]) => wanted.has(normalizedMetricKey(label)));
  return numberValue(entry?.[1]);
}

export function capacityWorkload(row: Pick<ShipmentCountAssociateDay, "amazon_delivery" | "swa_delivery" | "c_return" | "total_delivery">) {
  const amazon = numberValue(row.amazon_delivery);
  const swa = numberValue(row.swa_delivery);
  const returned = numberValue(row.c_return);
  return amazon || swa ? amazon + swa + returned : numberValue(row.total_delivery) + returned;
}

async function loadDetailedAssociateDays(companyId: string, stationCodes: string[], from: string, to: string) {
  if (!supabaseAdmin || !stationCodes.length) {
    return { data: [] as CapacityAssociateDay[], error: null };
  }

  const stationChunks: string[][] = [];
  for (let index = 0; index < stationCodes.length; index += 6) {
    stationChunks.push(stationCodes.slice(index, index + 6));
  }

  const chunks = await Promise.all(stationChunks.map(async (codes) => {
    const rows: CapacityAssociateDay[] = [];
    let fromRow = 0;
    for (;;) {
      const result = await supabaseAdmin!
        .rpc("capacity_associate_daily", {
          p_company_id: companyId,
          p_station_codes: codes,
          p_from: from,
          p_to: to
        })
        .order("work_date", { ascending: true })
        .order("station_code", { ascending: true })
        .order("associate_id", { ascending: true })
        .range(fromRow, fromRow + ASSOCIATE_PAGE_SIZE - 1);

      if (result.error) return { data: rows, error: result.error };
      const page = (result.data ?? []) as CapacityAssociateDay[];
      if (!page.length) break;
      rows.push(...page);
      fromRow += page.length;
    }
    return { data: rows, error: null };
  }));

  return {
    data: chunks.flatMap((chunk) => chunk.data),
    error: chunks.find((chunk) => chunk.error)?.error ?? null
  };
}

export async function loadShipmentCountAssociateDays(companyId: string, stationCodes: string[], from: string, to: string) {
  if (!supabaseAdmin || !stationCodes.length) {
    return { data: [] as ShipmentCountAssociateDay[], error: null };
  }

  const stationChunks: string[][] = [];
  for (let index = 0; index < stationCodes.length; index += 6) {
    stationChunks.push(stationCodes.slice(index, index + 6));
  }

  const chunks = await Promise.all(stationChunks.map(async (codes) => {
    const rows: ShipmentCountAssociateDay[] = [];
    let fromRow = 0;
    for (;;) {
      const result = await supabaseAdmin!
        .from("cps_shipment_daily")
        .select("client,station_code,work_date,provider_employee_id,provider_employee_name,amazon_delivery,swa_delivery,c_return,total_delivery,variable_pay,mg_pay,fuel_pay,da_total_pay,pay_type,mapping_status")
        .eq("company_id", companyId)
        .in("station_code", codes)
        .gte("work_date", from)
        .lte("work_date", to)
        .not("provider_employee_id", "is", null)
        .order("work_date", { ascending: true })
        .order("station_code", { ascending: true })
        .order("provider_employee_id", { ascending: true })
        .order("client", { ascending: true })
        .range(fromRow, fromRow + ASSOCIATE_PAGE_SIZE - 1);

      if (result.error) return { data: rows, error: result.error };
      const page = (result.data ?? []) as ShipmentCountAssociateDay[];
      if (!page.length) break;
      rows.push(...page);
      // Supabase may enforce a lower server-side maximum than the requested
      // range. Advancing by the actual page size prevents silently skipping
      // later dates when that happens.
      fromRow += page.length;
    }
    return { data: rows, error: null };
  }));

  return {
    data: chunks.flatMap((chunk) => chunk.data),
    error: chunks.find((chunk) => chunk.error)?.error ?? null
  };
}

export function mergeCapacityAssociateDays(
  detailedRows: CapacityAssociateDay[],
  shipmentCountRows: ShipmentCountAssociateDay[]
) {
  const merged = [...detailedRows];
  const detailedKeys = new Set(detailedRows.map((row) => associateKey(row.station_code, row.work_date, row.associate_id)));
  const detailedNameKeys = new Set(detailedRows.flatMap((row) => {
    const name = normalizedAssociateName(row.associate_name);
    return name ? [`${row.station_code.trim().toUpperCase()}|${row.work_date}|${name}`] : [];
  }));
  const fallbackByKey = new Map<string, CapacityAssociateDay>();

  shipmentCountRows.forEach((row) => {
    const associateId = String(row.provider_employee_id ?? "").trim();
    if (!associateId) return;
    const key = associateKey(row.station_code, row.work_date, associateId);
    if (detailedKeys.has(key)) return;
    const name = String(row.provider_employee_name ?? "").trim() || null;
    const normalizedName = normalizedAssociateName(name);
    if (normalizedName && detailedNameKeys.has(`${row.station_code.trim().toUpperCase()}|${row.work_date}|${normalizedName}`)) return;

    const delivered = capacityWorkload(row);
    const current = fallbackByKey.get(key);
    if (current) {
      current.delivered = Number(current.delivered) + (Number.isFinite(delivered) ? delivered : 0);
      current.unclassified = current.delivered;
      if (!current.associate_name && name) current.associate_name = name;
      return;
    }
    fallbackByKey.set(key, {
      station_code: row.station_code,
      work_date: row.work_date,
      associate_id: associateId,
      associate_name: name,
      delivered: Number.isFinite(delivered) ? delivered : 0,
      volumetric: 0,
      small: 0,
      unclassified: Number.isFinite(delivered) ? delivered : 0
    });
  });

  merged.push(...fallbackByKey.values());
  return merged.sort((left, right) =>
    left.work_date.localeCompare(right.work_date)
    || left.station_code.localeCompare(right.station_code)
    || left.associate_id.localeCompare(right.associate_id)
  );
}

async function loadCapacityDeliverySource(companyId: string, stationCodes: string[], from: string, to: string) {
  if (!supabaseAdmin || !stationCodes.length) return { data: [] as CapacityDeliveryBreakdown[], error: null };
  const chunks: string[][] = [];
  for (let index = 0; index < stationCodes.length; index += 6) chunks.push(stationCodes.slice(index, index + 6));
  const results = await Promise.all(chunks.map(async (codes) => {
    const rows: CapacityDeliveryBreakdown[] = [];
    let fromRow = 0;
    for (;;) {
      const result = await supabaseAdmin!
        .from("cps_shipment_daily")
        .select("source_batch_id,station_code,work_date,provider_employee_id,provider_employee_name,shipment_type,assigned_count,amazon_delivery,swa_delivery,c_return,mfn,mfn_return,total_delivery,total_activity,variable_pay,mg_pay,fuel_pay,da_total_pay,pay_type,mapping_status")
        .eq("company_id", companyId)
        .in("station_code", codes)
        .gte("work_date", from)
        .lte("work_date", to)
        .order("work_date", { ascending: true })
        .order("station_code", { ascending: true })
        .order("provider_employee_id", { ascending: true })
        .range(fromRow, fromRow + ASSOCIATE_PAGE_SIZE - 1);
      if (result.error) return { data: rows, error: result.error };
      const page = (result.data ?? []) as Omit<CapacityDeliveryBreakdown, "smd_delivery" | "smd2_delivery" | "base_amazon_delivery">[];
      if (!page.length) break;
      rows.push(...page.map((row) => ({ ...row, smd_delivery: 0, smd2_delivery: 0, base_amazon_delivery: 0 })));
      fromRow += page.length;
    }
    return { data: rows, error: null };
  }));
  return {
    data: results.flatMap((result) => result.data),
    error: results.find((result) => result.error)?.error ?? null
  };
}

async function loadSmdAuditRows(companyId: string, deliveryRows: CapacityDeliveryBreakdown[], from: string, to: string) {
  if (!supabaseAdmin || !deliveryRows.length) return { rows: [] as ShipmentAuditRow[], error: null };
  const batchIds = [...new Set(deliveryRows.map((row) => row.source_batch_id).filter((value): value is string => Boolean(value)))];
  const stationCodes = [...new Set(deliveryRows.map((row) => row.station_code))];
  if (!batchIds.length) return { rows: [] as ShipmentAuditRow[], error: null };
  const batchChunks: string[][] = [];
  for (let index = 0; index < batchIds.length; index += 20) batchChunks.push(batchIds.slice(index, index + 20));
  const results = await Promise.all(batchChunks.map(async (ids) => {
    const rows: ShipmentAuditRow[] = [];
    let fromRow = 0;
    for (;;) {
      const result = await supabaseAdmin!
        .from("report_import_rows")
        .select("batch_id,work_date,station_code,external_worker_id,normalized_data,raw_data,row_number")
        .eq("company_id", companyId)
        .eq("source_type", "amazon_shipments")
        .in("batch_id", ids)
        .in("station_code", stationCodes)
        .gte("work_date", from)
        .lte("work_date", to)
        .not("normalized_data", "is", null)
        .order("row_number", { ascending: true })
        .range(fromRow, fromRow + ASSOCIATE_PAGE_SIZE - 1);
      if (result.error) return { rows, error: result.error };
      const page = (result.data ?? []) as ShipmentAuditRow[];
      if (!page.length) break;
      rows.push(...page);
      fromRow += page.length;
    }
    return { rows, error: null };
  }));
  return {
    rows: results.flatMap((result) => result.rows),
    error: results.find((result) => result.error)?.error ?? null
  };
}

export async function loadCapacityDeliveryBreakdown(companyId: string, stationCodes: string[], from: string, to: string) {
  const source = await loadCapacityDeliverySource(companyId, stationCodes, from, to);
  if (source.error || !source.data.length) return source;
  const audit = await loadSmdAuditRows(companyId, source.data, from, to);
  const currentSourceKeys = new Set(source.data.map((row) =>
    `${row.source_batch_id ?? ""}|${row.work_date}|${row.station_code}|${row.provider_employee_id}`
  ));
  const seenAuditGrain = new Set<string>();
  const smdByAssociateDay = new Map<string, { smd: number; smd2: number }>();
  audit.rows.forEach((row) => {
    const associateId = String(row.external_worker_id ?? "").trim();
    const sourceKey = `${row.batch_id}|${row.work_date}|${row.station_code}|${associateId}`;
    if (!associateId || !currentSourceKeys.has(sourceKey)) return;
    const shipmentType = normalizedMetricKey(String(row.normalized_data?.shipment_type ?? ""));
    const grainKey = `${sourceKey}|${shipmentType}`;
    if (seenAuditGrain.has(grainKey)) return;
    seenAuditGrain.add(grainKey);
    const normalizedSmd = row.normalized_data?.smd_delivery;
    const normalizedSmd2 = row.normalized_data?.smd2_delivery;
    const smd = normalizedSmd == null
      ? exactRawMetric(row.raw_data, ["Overall Delivered SMD"])
      : numberValue(normalizedSmd);
    const smd2 = normalizedSmd2 == null
      ? exactRawMetric(row.raw_data, ["Overall Delivered SMD2", "Overall Delivered SMD 2.0", "Overall Delivered SMD2.0"])
      : numberValue(normalizedSmd2);
    const key = `${row.work_date}|${row.station_code}|${associateId}`;
    const current = smdByAssociateDay.get(key) ?? { smd: 0, smd2: 0 };
    current.smd += smd;
    current.smd2 += smd2;
    smdByAssociateDay.set(key, current);
  });
  return {
    data: source.data.map((row) => {
      const smd = smdByAssociateDay.get(`${row.work_date}|${row.station_code}|${row.provider_employee_id}`);
      const smdDelivery = smd?.smd ?? 0;
      const smd2Delivery = smd?.smd2 ?? 0;
      return {
        ...row,
        smd_delivery: smdDelivery,
        smd2_delivery: smd2Delivery,
        // The imported aggregate stores Amazon delivery with SMD/SMD2 included.
        // Expose its base separately so the UI can show the requested formula
        // without adding SMD twice.
        base_amazon_delivery: Math.max(numberValue(row.amazon_delivery) - smdDelivery - smd2Delivery, 0)
      };
    }),
    error: audit.error
  };
}

const cachedCapacityStationDays = unstable_cache(async (companyId: string, stationCodes: string[], from: string, to: string) => {
  if (!supabaseAdmin || !stationCodes.length) return { data: [] as CapacityStationDay[], error: null };
  const chunks: string[][] = [];
  for (let index = 0; index < stationCodes.length; index += 6) chunks.push(stationCodes.slice(index, index + 6));
  const [results, returnResults] = await Promise.all([
    Promise.all(chunks.map((codes) => supabaseAdmin!.rpc("capacity_station_daily", {
      p_company_id: companyId, p_station_codes: codes, p_from: from, p_to: to
    }))),
    Promise.all(chunks.map((codes) => supabaseAdmin!.from("cps_station_daily")
      .select("station_code,work_date,total_delivery,c_return")
      .eq("company_id", companyId)
      .in("station_code", codes)
      .gte("work_date", from)
      .lte("work_date", to)))
  ]);
  const workloadByStationDay = new Map<string, number>();
  returnResults.flatMap((result) => result.data ?? []).forEach((row) => {
    workloadByStationDay.set(
      `${row.station_code}|${row.work_date}`,
      numberValue(row.total_delivery) + numberValue(row.c_return)
    );
  });
  const rows = results.flatMap((result) => (result.data ?? []) as CapacityStationDay[]).map((row) => {
    const workload = workloadByStationDay.get(`${row.station_code}|${row.work_date}`) ?? numberValue(row.delivered);
    return { ...row, delivered: workload, shipment_count: workload };
  });
  return {
    data: rows,
    error: results.find((result) => result.error)?.error ?? returnResults.find((result) => result.error)?.error ?? null
  };
}, ["capacity-station-days-v3"], { revalidate: 60 });

export async function loadCapacityStationDays(companyId: string, stationCodes: string[], from: string, to: string) {
  return cachedCapacityStationDays(companyId, [...stationCodes].sort(), from, to);
}

const cachedCapacityAssociateDays = unstable_cache(async (companyId: string, stationCodes: string[], from: string, to: string) => {
  if (!supabaseAdmin || !stationCodes.length) return { data: [] as CapacityAssociateDay[], error: null };
  const [detailResult, countResult] = await Promise.all([
    loadDetailedAssociateDays(companyId, stationCodes, from, to),
    loadShipmentCountAssociateDays(companyId, stationCodes, from, to)
  ]);
  return {
    data: mergeCapacityAssociateDays(
      detailResult.data,
      countResult.data
    ),
    error: detailResult.error ?? countResult.error
  };
}, ["capacity-associate-days-v4"], { revalidate: 120 });

export async function loadCapacityAssociateDays(companyId: string, stationCodes: string[], from: string, to: string) {
  return cachedCapacityAssociateDays(companyId, [...stationCodes].sort(), from, to);
}

export async function loadCapacityPincodes(companyId: string, stationCode: string, from: string, to: string) {
  if (!supabaseAdmin || !stationCode) return { data: [] as CapacityPincode[], error: null };
  const result = await supabaseAdmin.rpc("capacity_pincode_summary", {
    p_company_id: companyId,
    p_station_code: stationCode,
    p_from: from,
    p_to: to
  });
  return { data: (result.data ?? []) as CapacityPincode[], error: result.error };
}

export async function loadCapacityAssociateDeliveredDaily(
  companyId: string,
  stationCode: string,
  associateId: string,
  associateName: string,
  from: string,
  to: string
) {
  if (!supabaseAdmin || !stationCode || !associateId) {
    return { data: [] as CapacityAssociateDeliveredDay[], error: null };
  }
  const result = await supabaseAdmin.rpc("capacity_associate_delivered_daily", {
    p_company_id: companyId,
    p_station_code: stationCode,
    p_associate_id: associateId,
    p_associate_name: associateName,
    p_from: from,
    p_to: to
  });
  return { data: (result.data ?? []) as CapacityAssociateDeliveredDay[], error: result.error };
}

export async function loadCapacityAssociatePincodes(
  companyId: string,
  stationCode: string,
  associateId: string,
  associateName: string,
  from: string,
  to: string
) {
  if (!supabaseAdmin || !stationCode || !associateId) {
    return { data: [] as CapacityAssociatePincode[], error: null };
  }
  const result = await supabaseAdmin.rpc("capacity_associate_pincode_summary", {
    p_company_id: companyId,
    p_station_code: stationCode,
    p_associate_id: associateId,
    p_associate_name: associateName,
    p_from: from,
    p_to: to
  });
  return { data: (result.data ?? []) as CapacityAssociatePincode[], error: result.error };
}
