// Applies only to the separate Amazon email pilot candidate, never a canonical profile.
export function betaJourney(input: {
  continuationStatus?: string | null;
  registrationStatus?: string | null;
  invitationAvailable?: boolean;
  bgcAction?: boolean;
}) {
  const registered = ["submitted", "confirmed"].includes(input.registrationStatus ?? "");
  const stopped = input.continuationStatus === "not_continuing";
  // Preserve registrations already submitted under the earlier beta sequence.
  const ready = !stopped && (input.continuationStatus === "continuing" || registered);
  const stage = stopped ? "not_continuing" : !ready ? "buddy_training"
    : !registered ? "dropx_registration_pending" : input.bgcAction ? "bgc_action"
    : input.invitationAvailable ? "registration_pending" : "invitation_pending";
  return {
    registered, ready, stopped, stage,
    invitationUnlocked: ready && registered,
    label: stopped ? "Workforce follow-up" : !ready ? "Get started with your station buddy"
      : !registered ? "Complete DropX registration" : input.bgcAction ? "IDfy action required"
      : input.invitationAvailable ? "Complete Amazon registration" : "Waiting for Amazon invitation",
    instruction: stopped ? "Your station team will follow up on your request."
      : !ready ? "Enrol your biometric ID, punch IN and OUT daily, and learn the role with your station buddy for up to 2 days. When ready, continue to DropX registration."
      : !registered ? "Confirm your details and submit DropX registration. Your Amazon invitation is kept ready for the next step."
      : input.bgcAction ? "Open the verification request and complete the details requested."
      : input.invitationAvailable ? "Copy your Amazon sign-in email and invitation link. Sign out of any other Amazon account or paste the link into a private/incognito window."
      : "Your Amazon invitation has been requested. The link will appear here when it arrives."
  };
}
