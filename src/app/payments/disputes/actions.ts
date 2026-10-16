"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { performPayoutReview } from "@/lib/payout-review-actions";

export async function reviewPayout(form: FormData) {
  const query = new URLSearchParams();
  try {
    const step = await performPayoutReview(form);
    query.set("notice", step === "propose" ? "Decision proposed. Another reviewer approves it before the associate sees it." : step === "approve" ? "Decision approved and shared with the associate." : "Sent back for review.");
    revalidatePath("/payments/disputes");
  } catch (error) {
    query.set("error", error instanceof Error ? error.message : "Unable to save payout review.");
  }
  redirect(`/payments/disputes?${query.toString()}`);
}
