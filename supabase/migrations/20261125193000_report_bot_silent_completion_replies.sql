-- Dark-store completion OCR must classify and stop reminders on pass,
-- but must never post "Needs correction" analysis checklists to WhatsApp.
-- Re-apply for every company (an earlier migration only covered one tenant),
-- and cancel any still-pending analysis feedback already queued.

update public.report_bot_report_types
set auto_reply_policy = 'silent',
    updated_at = now()
where name in (
  'DG fuel level',
  'Stowing pendency',
  'Cycle count, SBC & SRC completion',
  'Expiry removed'
)
  and auto_reply_policy is distinct from 'silent';

update public.report_bot_outbox
set status = 'cancelled',
    status_reason = 'Cancelled: completion OCR analysis replies are silent.',
    updated_at = now()
where status = 'pending'
  and kind = 'feedback'
  and (
    body ilike '%Needs correction%'
    or body ilike '%Cycle count, SBC%'
    or body ilike '%Stowing pendency%'
    or body ilike '%Expiry removed%'
    or body ilike '%Pass only when all three quantities%'
  );
