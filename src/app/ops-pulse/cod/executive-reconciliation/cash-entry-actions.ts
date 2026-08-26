"use server";

import type { CashEntryActionResult } from "./actions";

/**
 * Thin server-action entry for client forms.
 * Keeps associate-entry-builder from statically binding the full actions module graph.
 */
export async function saveExecutiveReconciliation(formData: FormData): Promise<CashEntryActionResult | void> {
  const actions = await import("./actions");
  return actions.saveExecutiveReconciliation(formData);
}

export async function deleteExecutiveReconciliation(formData: FormData): Promise<CashEntryActionResult | void> {
  const actions = await import("./actions");
  return actions.deleteExecutiveReconciliation(formData);
}

export async function confirmDriverReconForDeposit(formData: FormData): Promise<CashEntryActionResult | void> {
  const actions = await import("./actions");
  return actions.confirmDriverReconForDeposit(formData);
}

export async function requestCashEntryException(formData: FormData): Promise<CashEntryActionResult | void> {
  const actions = await import("./actions");
  return actions.requestCashEntryException(formData);
}
