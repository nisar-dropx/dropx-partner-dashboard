begin;

-- Report Bot no longer stores images: the worker fetches them from WhatsApp on demand
-- and only the extracted text (summary, key values, checks) is kept in ai_result.
alter table public.report_bot_submissions drop column if exists storage_bucket;
alter table public.report_bot_submissions drop column if exists storage_path;

commit;
