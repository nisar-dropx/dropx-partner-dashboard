/** Read-only tracking presentation. Never treats approval or a bank file as payment. */
export type PaymentTrackingProgress = {
  next: string;
  tone: 'done' | 'current' | 'issue';
  milestones: { label: string; state: 'done' | 'current' | 'upcoming' | 'issue' | 'stopped' }[];
};

export function paymentTrackingProgress(input: {
  status: string; detailsSubmitted: boolean; owner?: string; step?: number | null; totalSteps?: number | null;
}): PaymentTrackingProgress {
  const { status, detailsSubmitted, owner } = input;
  const paid = status === 'Paid';
  const processing = ['Processing', 'Processed', 'Resubmitted - Payment Processing'].includes(status);
  const approved = status === 'Final Approved';
  const returned = status === 'Returned';
  const stopped = ['Rejected', 'Cancelled'].includes(status);
  const approvalStage = input.step && input.totalSteps ? ` · step ${input.step} of ${input.totalSteps}` : '';
  const milestones: PaymentTrackingProgress['milestones'] = [
    { label: 'Requested', state: 'done' },
    { label: `Approvals${!paid && !processing && !approved ? approvalStage : ''}`, state: paid || processing || approved ? 'done' : 'current' },
    { label: 'Payment details', state: detailsSubmitted || paid || processing ? 'done' : approved ? 'current' : 'upcoming' },
    { label: 'Finance processing', state: paid ? 'done' : processing || (approved && detailsSubmitted) ? 'current' : 'upcoming' },
    { label: 'Payment confirmed', state: paid ? 'done' : 'upcoming' },
  ];
  if (returned || stopped) {
    // History supplies completed approvals; a returned/rejected cycle must not look approved.
    milestones[1].state = 'issue';
    milestones[1].label = status;
    if (!detailsSubmitted) milestones[2].state = 'upcoming';
    milestones[3].state = 'upcoming';
    if (stopped) for (const milestone of milestones.slice(2)) milestone.state = 'stopped';
    return { next: returned ? 'Requester to correct and resubmit' : `${status} · no further steps`, tone: 'issue', milestones };
  }
  return {
    next: paid ? 'Payment confirmed' : processing ? 'Awaiting payment confirmation' : approved
      ? detailsSubmitted ? 'Finance to process payment' : 'Requester to submit payment details'
      : `${owner || 'Assigned approver'} to review${approvalStage}`,
    tone: paid ? 'done' : 'current', milestones,
  };
}

export function paymentTrackingEventTone(action: string): 'done' | 'issue' | 'current' | 'neutral' {
  const key = action.trim().toLowerCase().replaceAll('_', ' ');
  if (/return|reject|cancel|fail/.test(key)) return 'issue';
  if (['requested', 'created', 'approved', 'submitted', 'resubmitted', 'paid', 'processed'].includes(key)) return 'done';
  if (key === 'processing') return 'current';
  return 'neutral';
}
