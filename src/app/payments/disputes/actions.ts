"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { performPayoutReview } from "@/lib/payout-review-actions";

export async function reviewPayout(form: FormData) {
  const query = new URLSearchParams();
  try {
    await performPayoutReview(form);
    query.set("notice", "Dispute decision saved.");
    revalidatePath("/payments/disputes");
  } catch (error) {
    query.set("error", error instanceof Error ? error.message : "Unable to save payout review.");
  }
  redirect(`/payments/disputes?${query.toString()}`);
}
