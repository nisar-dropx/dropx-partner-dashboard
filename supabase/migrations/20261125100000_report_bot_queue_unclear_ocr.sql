-- Unclear OCR screenshots (wrong screen / unreadable quantities) auto-close by
-- default. Operators can turn queue_unclear_ocr_reviews on to keep them in
-- Waiting / Review with a draft for a person to check.

alter table public.report_bot_settings
  add column if not exists queue_unclear_ocr_reviews boolean not null default false;

comment on column public.report_bot_settings.queue_unclear_ocr_reviews is
  'When true, unclear OCR analyses wait in the review queue with a draft. When false (default), they are analysed and dismissed with no WhatsApp reply and no waiting item.';
