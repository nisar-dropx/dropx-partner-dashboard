begin;

update public.payment_heads
set delivery_identity_policy = 'van_execution', updated_at = now()
where code = 'VAN_ADHOC';

update public.payment_heads
set delivery_identity_policy = 'paid_associate_day', is_active = true, updated_at = now()
where code = 'ADHOC_ODCD';

update public.payment_head_questions question
set question_text = 'ODCD Contact No', updated_at = now()
from public.payment_heads head
where head.id = question.payment_head_id
  and head.company_id = question.company_id
  and head.code = 'ADHOC_ODCD'
  and question.question_text = 'DA / WM Contact No';

notify pgrst, 'reload schema';
commit;
