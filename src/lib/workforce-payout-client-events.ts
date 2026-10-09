export const WORKFORCE_PAYOUT_INPUTS_CHANGED_EVENT = "workforce-payouts:inputs-changed";

export function announceWorkforcePayoutInputsChanged(message: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(WORKFORCE_PAYOUT_INPUTS_CHANGED_EVENT, {
    detail: { message }
  }));
}
