"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { performPayoutReview } from "@/lib/payout-review-actions";

function isRedirectError(error: unknown) {
  return String((error as { digest?: unknown })?.digest ?? "").startsWith("NEXT_REDIRECT");
}

export async function reviewPayout(form: FormData) {
  const query = new URLSearchParams();
  try {
    const result = await performPayoutReview(form);
    const notices: Record<string, string> = {
      propose_correction: "Correction proposed. A different final approver must confirm it.",
      propose_rejection: "Rejection proposed. A different final approver must confirm it.",
      approve_final: result.status === "rejected"
        ? "Rejection approved and shared with the associate."
        : "Correction approved and sent to the payout processor.",
      send_back: "Proposal sent back for initial review.",
      claim_processing: "Processing task claimed. Correct the payout source and publish a revised payout.",
      block_processing: "Processing marked as blocked.",
      complete_processing: "Processor-applied correction recorded. The revised publication and net change were system-verified."
    };
    query.set("notice", notices[result.action] || "Dispute updated.");
    revalidatePath("/payments/disputes");
  } catch (error) {
    if (isRedirectError(error)) throw error;
    query.set("error", error instanceof Error ? error.message : "Unable to save payout review.");
  }
  redirect(`/payments/disputes?${query.toString()}`);
}
