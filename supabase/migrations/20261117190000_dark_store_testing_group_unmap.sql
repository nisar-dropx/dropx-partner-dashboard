-- Unmap "Dark Store Testing" from TZC4's location so the PPI cron
-- sends TZC4's report only to "TZC4: War room".
-- The testing group is used for manual testing only, not production sends.
update report_bot_groups
set location_id = null
where wa_group_id = '120363429732355530@g.us'
  and group_name  = 'Dark Store Testing';
