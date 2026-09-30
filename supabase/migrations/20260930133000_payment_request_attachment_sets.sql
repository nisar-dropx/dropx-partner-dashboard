-- Payment request evidence can include up to three files for one configured question.
-- The original file columns remain populated with the first file for backward compatibility.
alter table public.payment_request_answers
  add column if not exists attachments jsonb not null default '[]'::jsonb;

comment on column public.payment_request_answers.attachments is
  'Ordered payment request evidence files: [{"path":"...","name":"...","size":123}]. Maximum three entries are enforced by the application.';
