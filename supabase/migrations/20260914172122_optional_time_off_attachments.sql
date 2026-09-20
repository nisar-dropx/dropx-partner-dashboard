begin;
-- Private evidence belongs to the request, not to an expiring approval step.
alter table public.hr_wfh_requests
 add column attachment_path text,
 add column attachment_file_name text,
 add column attachment_mime_type text,
 add column attachment_size integer,
 add constraint hr_wfh_attachment_check check (
   (attachment_path is null and attachment_file_name is null and attachment_mime_type is null and attachment_size is null)
   or (attachment_path is not null and attachment_file_name is not null and attachment_mime_type is not null and attachment_size is not null
     and starts_with(attachment_path,company_id::text||'/wfh/'||id::text||'/')
     and length(attachment_file_name) between 1 and 150
     and attachment_mime_type in ('application/pdf','image/jpeg','image/png')
     and attachment_size between 1 and 4194304));
alter table public.hr_business_trip_requests
 add column attachment_path text,
 add column attachment_file_name text,
 add column attachment_mime_type text,
 add column attachment_size integer,
 add constraint hr_business_trip_attachment_check check (
   (attachment_path is null and attachment_file_name is null and attachment_mime_type is null and attachment_size is null)
   or (attachment_path is not null and attachment_file_name is not null and attachment_mime_type is not null and attachment_size is not null
     and starts_with(attachment_path,company_id::text||'/business-trip/'||id::text||'/')
     and length(attachment_file_name) between 1 and 150
     and attachment_mime_type in ('application/pdf','image/jpeg','image/png')
     and attachment_size between 1 and 4194304));
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values ('time-off-attachments','time-off-attachments',false,4194304,array['application/pdf','image/jpeg','image/png']);
-- No public storage policy: uploads and signed URLs require application authorization.
commit;
