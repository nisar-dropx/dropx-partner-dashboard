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
      result = await supabaseAdmin
        .from("nl_loss_sources")
        .update({
          recoverable_statuses: statuses,
          history_months: b.history_months,
          allow_equal_split: b.allow_equal_split,
          allow_custom_split: b.allow_custom_split,
          include_inactive_people: b.include_inactive_people,
          ...stamp,
        })
        .eq("company_id", company)
        .eq("updated_at", b.updated_at)
        .select("account_key");
    } else {
      if (
        !/^[a-z][a-z0-9_]{1,49}$/.test(b.code) ||
        typeof b.label !== "string" ||
        b.label.trim().length < 2 ||
        b.label.length > 80 ||
        typeof b.allocation_required !== "boolean" ||
        typeof b.remarks_required !== "boolean" ||
        typeof b.is_active !== "boolean" ||
        !Number.isInteger(b.sort_order)
      )
        return reply(
          { error: "Enter a valid code, label and option settings." },
          400,
        );
      const value = {
        label: b.label.trim(),
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
