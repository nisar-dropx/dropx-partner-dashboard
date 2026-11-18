-- Add 'silent' as a valid auto_reply_policy so report types can be
-- classified by the bot but never trigger any reply or draft in the queue.

alter table report_bot_report_types
  drop constraint if exists report_bot_report_types_auto_reply_policy_check;

alter table report_bot_report_types
  add constraint report_bot_report_types_auto_reply_policy_check
    check (auto_reply_policy in ('normal', 'never', 'silent'));

-- Set all dark store scheduled report types to silent — bot classifies
-- submissions and stops reminders on pass, but never sends any reply
-- to the group (no feedback message, no draft in the portal queue).
update report_bot_report_types
set auto_reply_policy = 'silent'
where name in (
  'DG fuel level',
  'Stowing pendency',
  'Cycle count, SBC & SRC completion',
  'Expiry removed'
)
  and company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997';
