export type LscTicketDetails = {
  tt_reference: string;
  tt_url: string;
  followup_on: string;
  note: string;
};

/** Shared by individual and bulk entry; approval itself never needs a ticket. */
export function lscTicketError(details: LscTicketDetails): string | null {
  const ticket = details.tt_reference.trim();
  if (ticket.length < 3 || ticket.length > 160) return 'Enter the LSC ticket ID (3–160 characters).';
  if (details.tt_url) {
    try {
      const url = new URL(details.tt_url);
      if (url.protocol !== 'https:' || url.username || url.password || details.tt_url.length > 2000) throw Error();
    } catch { return 'Use a valid HTTPS ticket link.'; }
  }
  const date = details.followup_on;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date)
    return 'Set a valid next follow-up date.';
  if (details.note.trim().length < 10 || details.note.trim().length > 4000) return 'Add a clear update (10–4000 characters).';
  return null;
}
