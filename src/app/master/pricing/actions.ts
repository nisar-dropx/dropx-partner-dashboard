"use server";
import { revalidatePath } from "next/cache";
import { financeContext, canWritePricing } from "@/lib/finance/data";
import { validatePricing } from "@/lib/finance/pricing";
export async function savePricing(input: unknown) {
  try {
    const context = await financeContext("finance_pricing");
    if (!Array.isArray(input) || input.length < 1 || input.length > 500)
      throw new Error("Choose between 1 and 500 rate cards.");
    const items = input.map(validatePricing);
    const allowedCodes = new Set(context.locations.map((l) => l.station_code));
    const keys = new Set<string>();
    for (const item of items) {
      if (!canWritePricing(context.authorization, item.expected_revision))
        throw new Error("Your Finance role cannot make this change.");
      if (
        !context.authorization.hasAllLocationAccess &&
        !allowedCodes.has(item.station_code)
      )
        throw new Error("This station is outside your permitted locations.");
      const key = `${item.provider}/${item.station_code}/${item.effective_month}`;
      if (keys.has(key))
        throw new Error(`Duplicate rate card: ${item.station_code}.`);
      keys.add(key);
    }
    const { data, error } = await context.db.rpc("finance_save_pricing", {
      p_company: context.companyId,
      p_actor: context.authorization.userId,
      p_items: items,
    });
    if (error) {
      if (error.message.includes("Pricing changed or already exists"))
        throw new Error(
          "A rate card already exists or was edited by someone else. Refresh, open its latest revision and review before saving.",
        );
      throw new Error(
        "Unable to save pricing. No changes were applied. Please retry.",
      );
    }
    revalidatePath("/master/pricing");
    revalidatePath("/finance/business");
    return { ok: true as const, count: Number(data) };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Unable to save pricing.",
    };
  }
}
