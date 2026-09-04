import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { readTrendPages } from "./review-trends-data";
import { isApprovedPayment } from "./performance-review";
import { buildReviewFuel, fuelFromDate } from "./review-fuel";

export async function loadReviewFuel(
  companyId: string,
  station: string,
  date: string,
) {
  if (!supabaseAdmin) throw Error("Fuel data is unavailable.");
  const db = supabaseAdmin,
    from = fuelFromDate(date);
  // Use the station saved with the imported transaction, not the vehicle's
  // current home or the petrol pump's station_name. This preserves history.
  const [cards, latest, heads] = await Promise.all([
    readTrendPages((offset) =>
      db
        .from("cps_fuel_daily")
        .select(
          "id,provider,transaction_id,transaction_date,vehicle_no,amount,litres,product",
        )
        .eq("company_id", companyId)
        .eq("station_code", station)
        .gte("transaction_date", from)
        .lte("transaction_date", date)
        .order("transaction_date")
        .order("id")
        .range(offset, offset + 999),
    ),
    db
      .from("cps_fuel_daily")
      .select("transaction_date")
      .eq("company_id", companyId)
      .eq("station_code", station)
      .lte("transaction_date", date)
      .order("transaction_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from("payment_heads")
      .select("id")
      .eq("company_id", companyId)
      .eq("code", "VAN_FUEL"),
  ]);
  if (latest.error || heads.error)
    throw Error("Fuel sources could not be loaded.");
  // Keep historical approved requests for card eligibility; page all results
  // rather than silently losing older rows at the API's default row limit.
  const requests = heads.data?.length
    ? await readTrendPages((offset) =>
        db
          .from("payment_requests")
          .select(
            "id,request_no,work_date,amount,amount_approved,amount_requested,status,approval_status,current_approver_user_id,current_approver_role_id,details,remarks,notes",
          )
          .eq("company_id", companyId)
          .or(
            `station_code.eq.${station},and(station_code.is.null,location_code.eq.${station})`,
          )
          .in(
            "payment_head_id",
            heads.data.map((h) => h.id),
          )
          .lte("work_date", date)
          .order("work_date")
          .order("id")
          .range(offset, offset + 999),
      )
    : [];
  const approved = requests.filter((row) =>
    isApprovedPayment(row as Parameters<typeof isApprovedPayment>[0]),
  );
  return buildReviewFuel(
    station,
    date,
    cards,
    approved,
    latest.data?.transaction_date ?? null,
  );
}
