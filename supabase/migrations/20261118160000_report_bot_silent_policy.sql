-- Add 'silent' as a valid auto_reply_policy so report types can be
-- classified by the bot but never trigger any reply or draft in the queue.

alter table report_bot_report_types
  drop constraint if exists report_bot_report_types_auto_reply_policy_check;

alter table report_bot_report_types
  add constraint report_bot_report_types_auto_reply_policy_check
    check (auto_reply_policy in ('normal', 'never', 'silent'));

-- Set DG fuel level to silent — bot acknowledges receipt internally but
-- sends no reply to the group, not even after manual approval.
update report_bot_report_types
set auto_reply_policy = 'silent'
where name = 'DG fuel level'
  and company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997';
