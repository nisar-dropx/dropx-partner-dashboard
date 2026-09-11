"use server";
import { revalidateTag } from "next/cache";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { cpsScope } from "@/lib/ops-pulse/cps-data";
import { isoDate, validateCostInput } from "@/lib/ops-pulse/cps";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function saveCpsCost(form: FormData) {
  try {
    const auth = await getAuthorization();
    const id = String(form.get("id") || "");
    if (!auth || !hasPermission(auth, "cps_inputs", id ? "edit" : "add"))
      throw Error("CPS Inputs permission is required.");
    if (!supabaseAdmin) throw Error("Database unavailable. Please retry.");
    const scope = await cpsScope(auth, {});
    const codes = scope.all.map((l) => l.station_code);
    const raw = Object.fromEntries(form);
    const input = validateCostInput(
      { ...raw, is_active: form.get("is_active") !== "false" },
      codes,
    );
    let query;
    if (id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw Error("Invalid cost record.");
      const previous = await supabaseAdmin
        .from("ops_cps_cost_inputs")
        .select("station_codes,updated_at")
        .eq("company_id", scope.companyId)
        .eq("id", id)
        .maybeSingle();
      if (
        previous.error ||
        !previous.data ||
        !previous.data.station_codes.every((c: string) => codes.includes(c))
      )
        throw Error("This cost is not available within your access.");
      if (previous.data.updated_at !== form.get("updated_at"))
        throw Error("This cost changed. Refresh before saving again.");
      query = supabaseAdmin
        .from("ops_cps_cost_inputs")
        .update({ ...input, updated_by: auth.userId })
        .eq("company_id", scope.companyId)
        .eq("id", id)
        .eq("updated_at", previous.data.updated_at)
        .select("id");
    } else {
      query = supabaseAdmin
        .from("ops_cps_cost_inputs")
        .insert({
          ...input,
          company_id: scope.companyId,
          created_by: auth.userId,
          updated_by: auth.userId,
        })
        .select("id");
    }
    const result = await query;
    if (result.error || !result.data?.length)
      throw Error("The cost could not be saved. Refresh and retry.");
    revalidateTag("ops-cps");
    return { ok: true, message: "Cost saved. CPS has been recalculated." };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Cost could not be saved.",
    };
  }
}
export async function saveCpsTarget(form: FormData) {
  try {
    const auth = await getAuthorization();
    if (!auth || !hasPermission(auth, "cps_inputs", "add"))
      throw Error("CPS Inputs add permission is required.");
    if (!supabaseAdmin) throw Error("Database unavailable. Please retry.");
    const scope = await cpsScope(auth, {});
    const station = String(form.get("station_code") || "");
    const target = String(form.get("target_cps") || "");
    const effective = String(form.get("effective_from") || "");
    if (
      !scope.all.some((l) => l.station_code === station) ||
      !isoDate(effective) ||
      !/^\d{1,5}(\.\d{1,4})?$/.test(target) ||
      Number(target) <= 0
    )
      throw Error(
        "Choose a permitted location, positive target and effective date.",
      );
    const result = await supabaseAdmin
      .from("cps_station_targets")
      .insert({
        company_id: scope.companyId,
        station_code: station,
        target_cps: Number(target),
        effective_from: effective,
        is_active: true,
        created_by: auth.userId,
      });
    if (result.error?.code === "23505")
      throw Error(
        "A target already exists for this effective date. Add the revision on a new effective date to preserve history.",
      );
    if (result.error) throw Error("Target could not be saved.");
    revalidateTag("ops-cps");
    return {
      ok: true,
      message: "Target saved. CPS comparisons have been updated.",
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Target could not be saved.",
    };
  }
}
