import { getAuthorization, hasPermission } from "@/lib/authorization";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireCompanyId } from "@/lib/company-scope";
const reply = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
export async function POST(request: Request) {
  try {
    const auth = await getAuthorization();
    if (
      !auth ||
      auth.readOnly ||
      !hasPermission(auth, "ops_loss_master", "edit")
    )
      return reply(
        { error: "Loss Recovery Master edit access required." },
        403,
      );
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== new URL(request.url).origin
    )
      return reply({ error: "Invalid request origin." }, 403);
    if (!supabaseAdmin) throw Error("Database unavailable.");
    const company = requireCompanyId(auth),
      b = await request.json();
    let result;
    const stamp = {
      updated_by: auth.userId,
      updated_at: new Date().toISOString(),
    };
    if (b.kind === "settings") {
      const statuses = Array.isArray(b.recoverable_statuses)
        ? [
            ...new Set<string>(
              b.recoverable_statuses
                .map((s: unknown) => String(s).trim())
                .filter(Boolean),
            ),
          ]
        : [];
      if (
        !Number.isInteger(b.history_months) ||
        b.history_months < 1 ||
        b.history_months > 36 ||
        !statuses.length ||
        statuses.length > 20 ||
        statuses.some((s) => s.length > 120) ||
        typeof b.allow_equal_split !== "boolean" ||
        typeof b.allow_custom_split !== "boolean" ||
        typeof b.include_inactive_people !== "boolean" ||
        (!b.allow_equal_split && !b.allow_custom_split)
      )
        return reply(
          {
            error:
              "Add exact final recoverable source statuses and enable at least one split method.",
          },
          400,
        );
      const policy = b.recovery_policy;
      if (
        !policy ||
        [
          "active_only",
          "previous_month_active_only",
          "salary_cap_enabled",
          "reserve_other_recoveries",
          "cctv_public_confirmation",
        ].some((k) => typeof policy[k] !== "boolean") ||
        !Number.isInteger(policy.salary_month_offset) ||
        policy.salary_month_offset < 1 ||
        policy.salary_month_offset > 12 ||
        !Number.isFinite(policy.salary_cap_percent) ||
        policy.salary_cap_percent <= 0 ||
        policy.salary_cap_percent > 100 ||
        !Number.isInteger(policy.attachment_max_count) ||
        policy.attachment_max_count < 1 ||
        policy.attachment_max_count > 10 ||
        !Number.isInteger(policy.attachment_max_mb) ||
        policy.attachment_max_mb < 1 ||
        policy.attachment_max_mb > 20 ||
        [
          "people_run_statuses",
          "people_calculation_statuses",
          "workforce_payout_statuses",
          "eligible_designations",
          "attachment_types",
        ].some(
          (k) =>
            !Array.isArray(policy[k]) ||
            policy[k].length > 100 ||
            policy[k].some(
              (v: unknown) =>
                typeof v !== "string" || !v.trim() || v.length > 120,
            ),
        ) ||
        policy.attachment_types.some(
          (v: string) =>
            ![
              "image/jpeg",
              "image/png",
              "image/webp",
              "application/pdf",
            ].includes(v),
        )
      )
        return reply(
          { error: "Enter valid employee, salary cap and evidence rules." },
          400,
        );
      result = await supabaseAdmin
        .from("nl_loss_sources")
        .update({
          recoverable_statuses: statuses,
          history_months: b.history_months,
          allow_equal_split: b.allow_equal_split,
          allow_custom_split: b.allow_custom_split,
          include_inactive_people: !policy.active_only,
          recovery_policy: policy,
          ...stamp,
        })
        .eq("company_id", company)
        .eq("updated_at", b.updated_at)
        .select("account_key");
    } else {
      const timing =
        b.deduction_timing ??
        (b.allocation_required ? "current_month" : "none");
      if (
        !["none", "current_month", "next_month"].includes(timing) ||
        b.allocation_required !== (timing !== "none") ||
        (timing === "next_month" && !b.remarks_required)
      )
        return reply(
          {
            error:
              "A deduction requires full employee allocation. Next-month exceptions also require a reason.",
          },
          400,
        );
      if (
        !/^[a-z][a-z0-9_]{1,49}$/.test(b.code) ||
        typeof b.label !== "string" ||
        b.label.trim().length < 2 ||
        b.label.length > 80 ||
        typeof b.allocation_required !== "boolean" ||
        typeof b.remarks_required !== "boolean" ||
        [
          "dispute_fields_enabled",
          "reason_required",
          "details_required",
          "attachments_enabled",
          "cctv_enabled",
        ].some((k) => typeof b[k] !== "boolean") ||
        typeof b.is_active !== "boolean" ||
        !Number.isInteger(b.sort_order)
      )
        return reply(
          { error: "Enter a valid code, label and option settings." },
          400,
        );
      const value = {
        label: b.label.trim(),
        deduction_timing: timing,
        dispute_fields_enabled: b.dispute_fields_enabled,
        reason_required: b.reason_required,
        details_required: b.details_required,
        attachments_enabled: b.attachments_enabled,
        cctv_enabled: b.cctv_enabled,
        allocation_required: b.allocation_required,
        remarks_required: b.remarks_required,
        is_active: b.is_active,
        sort_order: b.sort_order,
        ...stamp,
      };
      result = b.updated_at
        ? await supabaseAdmin
            .from("nl_recovery_outcomes")
            .update(value)
            .eq("company_id", company)
            .eq("code", b.code)
            .eq("updated_at", b.updated_at)
            .select("code")
        : await supabaseAdmin
            .from("nl_recovery_outcomes")
            .insert({ ...value, company_id: company, code: b.code })
            .select("code");
    }
    if (result.error || !result.data?.length)
      return reply(
        {
          error:
            "Settings changed or this code already exists. Refresh before saving.",
        },
        409,
      );
    return reply({ ok: true });
  } catch {
    return reply({ error: "Settings could not be saved." }, 500);
  }
}
