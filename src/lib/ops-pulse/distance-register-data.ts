import "server-only";
import { unstable_cache } from "next/cache";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readAllRows } from "@/lib/supabase-pagination";
import { loadRouteDistanceContext } from "@/lib/workforce-route-distance-data";
import {
  buildDistanceEntries,
  type DistanceStation,
} from "./distance-register";
export const loadDistanceRegister = unstable_cache(
  async (
    companyId: string,
    stations: DistanceStation[],
    from: string,
    to: string,
  ) => {
    if (!supabaseAdmin)
      throw Error("Distance data is temporarily unavailable.");
    if (!stations.length) return [];
    const ids = stations.map((s) => s.id),
      codes = stations.map((s) => s.station_code),
      db = supabaseAdmin;
    const mappings = await readAllRows(
      db
        .from("field_executive_provider_mappings")
        .select(
          "id,workforce_id,station_id,provider_member_id,payment_values,effective_from,effective_to",
        )
        .eq("company_id", companyId)
        .in("station_id", ids)
        .in("status", ["active", "closed"])
        .not("workforce_id", "is", null)
        .lte("effective_from", to)
        .or(`effective_to.is.null,effective_to.gte.${from}`)
        .order("id"),
    );
    if (mappings.error)
      throw Error("Distance records could not be loaded. Please retry.");
    const kmMappings = (mappings.data || []).filter((m) =>
      Object.entries(m.payment_values || {}).some(
        ([k, v]) => k.trim().toUpperCase() === "KM_RUN" && Number(v) > 0,
      ),
    );
    const workerIds = [
      ...new Set(kmMappings.map((m) => String(m.workforce_id))),
    ];
    if (!workerIds.length) return [];
    const people: any[] = [],
      metadata: any[] = [],
      activity: any[] = [];
    // Restrict shipment reads to the kilometre-paid IDs rather than every associate.
    const providerIds = [
      ...new Set(kmMappings.map((m) => String(m.provider_member_id))),
    ];
    for (let i = 0; i < providerIds.length; i += 100) {
      const result = await readAllRows(
        db
          .from("cps_shipment_daily")
          .select(
            "station_code,work_date,provider_employee_id,provider_employee_name,total_delivery,amazon_delivery,c_return,swa_delivery",
          )
          .eq("company_id", companyId)
          .in("station_code", codes)
          .in("provider_employee_id", providerIds.slice(i, i + 100))
          .gte("work_date", from)
          .lte("work_date", to)
          .order("id"),
      );
      if (result.error)
        throw Error("Distance activity could not be loaded. Please retry.");
      activity.push(...(result.data || []));
    }
    for (let i = 0; i < workerIds.length; i += 100) {
      const chunk = workerIds.slice(i, i + 100);
      const [workers, detail] = await Promise.all([
        readAllRows(
          db
            .from("workforce")
            .select("id,dropx_id,full_name,date_of_join,last_working_date")
            .eq("company_id", companyId)
            .in("id", chunk)
            .order("id"),
        ),
        readAllRows(
          db
            .from("workforce_route_distances")
            .select(
              "id,transporter_id,scan_count,route_method:route_geometry->>method,skipped_scans:route_geometry->>skippedScans",
            )
            .eq("company_id", companyId)
            .in("workforce_id", chunk)
            .in("station_id", ids)
            .gte("work_date", from)
            .lte("work_date", to)
            .order("id"),
        ),
      ]);
      if (workers.error || detail.error)
        throw Error("Distance identities could not be verified. Please retry.");
      people.push(...(workers.data || []));
      metadata.push(...(detail.data || []));
    }
    const context = await loadRouteDistanceContext(
      db,
      companyId,
      workerIds,
      from,
      to,
    );
    return buildDistanceEntries({
      stations,
      mappings: kmMappings,
      people,
      activity,
      metadata,
      context,
      from,
      to,
    });
  },
  ["ops-capacity-distance-v2"],
  { revalidate: 60 },
);
