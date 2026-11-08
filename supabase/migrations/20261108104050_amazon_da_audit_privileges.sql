-- Supabase's existing default privileges may grant ALL to service_role.
-- Explicitly replace those defaults so operational backends cannot erase audits.
revoke all on public.amazon_da_commands,public.amazon_da_command_events from service_role;
grant select,insert,update on public.amazon_da_commands to service_role;
grant select,insert on public.amazon_da_command_events to service_role;
revoke all on sequence public.amazon_da_command_events_id_seq from service_role;
grant usage,select on sequence public.amazon_da_command_events_id_seq to service_role;
