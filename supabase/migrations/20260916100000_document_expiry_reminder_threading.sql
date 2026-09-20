-- Business document and fleet document expiry reminders fire up to 7+ times
-- per document (30/15/7/1 days before, on expiry, then every 7 days after)
-- but each send was a brand new, unrelated email with no threading headers -
-- every reminder landed as a separate message instead of a reply, which is
-- exactly the pattern that trains recipients to treat these as spam.
--
-- Adds message-id lineage columns to each document type's existing
-- notification log (already one row per send, in chronological order per
-- document) so the sending code can look up the prior send's message id and
-- reply to it instead of sending a fresh, unrelated email.

alter table public.business_document_notification_logs
  add column if not exists message_id text,
  add column if not exists root_message_id text;

alter table public.fleet_document_notification_logs
  add column if not exists message_id text,
  add column if not exists root_message_id text;
