"use server";

import { cookies } from "next/headers";
import { revalidatePath, revalidateTag } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthorization, hasPermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { canEditProviderMappings, currentProviderMappingPageCode } from "@/lib/provider-mapping-access";
import { supabaseAdmin } from "@/lib/supabase-admin";
import {
  normalizeDirectPaymentValues,
  type DirectPaymentComponent
} from "@/lib/workforce-payment-allocation";

function text(value: FormDataEntryValue | null) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function required(formData: FormData, key: string, label: string) {
  const value = text(formData.get(key));
  if (!value) throw new Error(`${label} is required.`);
  return value;
}

function dateValue(formData: FormData, key: string, label: string, optional = false) {
  const value = text(formData.get(key));
  if (!value && optional) return null;
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} is invalid.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function directAllocationRedirect(
  params: { error?: string; notice?: string },
  audience: "workforce" | "helpers" = "workforce",
  permissionScope: "provider_mapping" | "payment_settings" = "provider_mapping"
) {
  cookies().set("dropx_direct_payment_allocation_flash", JSON.stringify(params), {
    httpOnly: true,
    maxAge: 15,
    path: "/provider-mapping/direct-pay",
    sameSite: "lax"
  });
  redirect(audience === "helpers"
    ? `/provider-mapping/direct-pay?audience=helpers${permissionScope === "payment_settings" ? "&source=payment-settings" : ""}`
    : "/provider-mapping/direct-pay");
}

export async function saveDirectPaymentAllocation(formData: FormData) {
  const authorization = await getAuthorization();
  if (!authorization) redirect("/login");
  const companyId = requireCompanyId(authorization);
  const audience = text(formData.get("subject_type")) === "helpers" ? "helpers" : "workforce";
  const permissionScope = text(formData.get("permission_scope")) === "payment_settings"
    ? "payment_settings"
    : "provider_mapping";
  if (permissionScope === "payment_settings") {
    if (audience !== "helpers" || !hasPermission(authorization, "payment_settings", "edit")) {
      redirect("/unauthorized?page=payment_settings&action=edit");
    }
  } else if (!canEditProviderMappings(authorization)) {
    redirect(`/unauthorized?page=${currentProviderMappingPageCode()}&action=edit`);
  }

  try {
    if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
    const personId = required(formData, audience === "helpers" ? "helper_id" : "workforce_id", audience === "helpers" ? "Helper" : "Workforce member");
    const paymentMethodId = required(formData, "payment_method_id", "Payment method");
    const effectiveFrom = dateValue(formData, "effective_from", "Effective from")!;
    const effectiveTo = dateValue(formData, "effective_to", "Effective to", true);
    if (effectiveTo && effectiveTo < effectiveFrom) {
      throw new Error("Effective to cannot be before effective from.");
    }

    let person: { id: string; full_name: string; location_id: string | null; designation_id?: string | null; designation?: string | null } | null = null;
    if (audience === "helpers") {
      const helperResult = await supabaseAdmin
        .from("helpers")
        .select("id, full_name, location_id, designation, is_active, onboarding_status")
        .eq("id", personId)
        .eq("company_id", companyId)
        .eq("is_active", true)
        .eq("onboarding_status", "active")
        .maybeSingle();
      if (helperResult.error) throw new Error(helperResult.error.message);
      if (!helperResult.data) throw new Error("The Helper is no longer active.");
      person = helperResult.data;
    } else {
      const workerResult = await supabaseAdmin
        .from("workforce")
        .select("id, full_name, location_id, designation_id, designation, is_active")
        .eq("id", personId)
        .eq("company_id", companyId)
        .eq("is_active", true)
        .is("deleted_at", null)
        .maybeSingle();
      if (workerResult.error) throw new Error(workerResult.error.message);
      if (!workerResult.data) throw new Error("The workforce member is no longer active.");
      person = workerResult.data;

      const designationResult = await supabaseAdmin
        .from("designations")
        .select("id, code, name, is_active, is_field_operations, provider_mapping_required")
        .eq("company_id", companyId)
        .eq("is_active", true)
        .eq("is_field_operations", true)
        .eq("provider_mapping_required", false);
      if (designationResult.error) throw new Error(designationResult.error.message);
      const designationText = String(person.designation ?? "").trim().toLowerCase();
      const designation = (designationResult.data ?? []).find((row) => row.id === person?.designation_id
        || [row.name, row.code].some((value) => String(value ?? "").trim().toLowerCase() === designationText));
      if (!designation) throw new Error("This designation is not enabled for direct workforce payment allocation.");
    }

    if (!person.location_id) {
      throw new Error(`Assign an active location to this ${audience === "helpers" ? "Helper" : "workforce member"} before allocating direct payment.`);
    }
    const stationResult = await supabaseAdmin
      .from("stations")
      .select("id")
      .eq("id", person.location_id)
      .eq("company_id", companyId)
      .eq("is_active", true)
      .maybeSingle();
    if (stationResult.error) throw new Error(stationResult.error.message);
    if (!stationResult.data) {
      throw new Error(`The ${audience === "helpers" ? "Helper's" : "workforce member's"} location is not active for this company.`);
    }

    const allLocationAccess = authorization.hasAllLocationAccess || authorization.isMasterOwner || authorization.roleCode === "OWNER";
    if (!allLocationAccess && !authorization.locationScopeIds.includes(person.location_id)) {
      throw new Error(`This ${audience === "helpers" ? "Helper's" : "workforce member's"} location is not allocated to your account.`);
    }

    const methodResult = await supabaseAdmin
      .from("payment_methods")
      .select("id, code, name, is_active, payment_method_components(component_code, component_type, label, pay_schedule, sort_order, is_active)")
      .eq("id", paymentMethodId)
      .eq("company_id", companyId)
      .eq("is_active", true)
      .maybeSingle();
    if (methodResult.error) throw new Error(methodResult.error.message);
    if (!methodResult.data) throw new Error("The selected payment method is unavailable.");

    const components: DirectPaymentComponent[] = (methodResult.data.payment_method_components ?? [])
      .map((component) => ({
        code: String(component.component_code),
        label: String(component.label),
        type: component.component_type as "amount" | "production",
        schedule: component.pay_schedule as DirectPaymentComponent["schedule"],
        active: Boolean(component.is_active),
        sortOrder: Number(component.sort_order ?? 0)
      }))
      .sort((first, second) => (first.sortOrder ?? 0) - (second.sortOrder ?? 0));

    let rawValues: unknown;
    try {
      rawValues = JSON.parse(required(formData, "payment_values_json", "Payment values"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Payment values are invalid. Refresh the page and try again.");
      throw error;
    }
    const paymentValues = normalizeDirectPaymentValues(components, rawValues);

    const saveResult = audience === "helpers"
      ? await supabaseAdmin.rpc("save_helper_payment_allocation", {
        p_company_id: companyId,
        p_helper_id: personId,
        p_payment_method_id: paymentMethodId,
        p_payment_values: paymentValues,
        p_effective_from: effectiveFrom,
        p_effective_to: effectiveTo,
        p_change_reason: text(formData.get("change_reason")),
        p_actor_user_id: authorization.userId
      })
      : await supabaseAdmin.rpc("save_workforce_payment_allocation_v2", {
        p_company_id: companyId,
        p_workforce_id: personId,
        p_payment_method_id: paymentMethodId,
        p_payment_values: paymentValues,
        p_effective_from: effectiveFrom,
        p_effective_to: effectiveTo,
        p_change_reason: text(formData.get("change_reason")),
        p_actor_user_id: authorization.userId
      });
    if (saveResult.error) throw new Error(saveResult.error.message);

    revalidateTag("ops-cps");
    revalidatePath("/provider-mapping/direct-pay");
    revalidatePath("/provider-id-mapping");
    revalidatePath("/payments/workforce-payouts");
  } catch (error) {
    directAllocationRedirect({
      error: error instanceof Error ? error.message : "Unable to save the direct payment allocation."
    }, audience, permissionScope);
  }

  directAllocationRedirect({ notice: `${audience === "helpers" ? "Helper" : "Workforce"} payment allocation saved with effective-dated history.` }, audience, permissionScope);
}
