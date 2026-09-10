"use server";

import { revalidatePath } from "next/cache";
import { canWriteRent, financeContext } from "@/lib/finance/data";
import { validateRent } from "@/lib/finance/rent";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function saveRent(input: unknown) {
  try {
    const context = await financeContext("finance_rent");
    const item = validateRent(input);
    if (!canWriteRent(context.authorization, Boolean(item.id)))
      throw new Error("Your Finance role cannot make this change.");
    if (
      !context.authorization.hasAllLocationAccess &&
      !context.locations.some(
        (location) => location.station_code === item.allocation_station_code,
      )
    )
      throw new Error("This cost allocation is outside your permitted locations.");

    const { data, error } = await context.db.rpc("finance_save_rent", {
      p_company: context.companyId,
      p_actor: context.authorization.userId,
      p_item: item,
    });
    if (error) {
      if (error.message.includes("Rent changed or was deleted"))
        throw new Error(
          "This rent record changed after you opened it. Refresh and review the latest values before saving.",
        );
      if (error.message.toLowerCase().includes("duplicate"))
        throw new Error(
          "An active rent record already exists for this site, payee and start date.",
        );
      throw new Error("Unable to save rent. No changes were applied. Please retry.");
    }
    revalidatePath("/master/rent");
    revalidatePath("/finance/business");
    return { ok: true as const, id: String(data) };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Unable to save rent.",
    };
  }
}

export async function deleteRent(input: unknown) {
  try {
    if (!input || typeof input !== "object") throw new Error("Invalid rent record.");
    const value = input as { id?: unknown; expected_updated_at?: unknown };
    const id = String(value.id ?? "");
    const expected = String(value.expected_updated_at ?? "");
    if (!uuid.test(id) || !expected || Number.isNaN(new Date(expected).valueOf()))
      throw new Error("Refresh this rent record before deleting it.");

    const context = await financeContext("finance_rent");
    if (!canWriteRent(context.authorization, true))
      throw new Error("Your Finance role cannot delete rent records.");

    const { error } = await context.db.rpc("finance_delete_rent", {
      p_company: context.companyId,
      p_actor: context.authorization.userId,
      p_id: id,
      p_expected_updated_at: expected,
      p_reason: "Deleted from Rent Master",
    });
    if (error) {
      if (error.message.includes("Rent changed or was deleted"))
        throw new Error(
          "This rent record changed after you opened it. Refresh and review it before deleting.",
        );
      throw new Error("Unable to delete rent. No changes were applied. Please retry.");
    }
    revalidatePath("/master/rent");
    revalidatePath("/finance/business");
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Unable to delete rent.",
    };
  }
}
