begin;

create index if not exists ops_performance_review_settings_updated_by_idx
  on public.ops_performance_review_settings(updated_by)
  where updated_by is not null;

create index if not exists ops_performance_reviews_station_idx
  on public.ops_performance_reviews(station_id, source_date desc);

create index if not exists ops_performance_reviews_source_batch_idx
  on public.ops_performance_reviews(source_batch_id)
  where source_batch_id is not null;

create index if not exists ops_performance_reviews_started_by_idx
  on public.ops_performance_reviews(started_by)
  where started_by is not null;

create index if not exists ops_performance_reviews_closed_by_idx
  on public.ops_performance_reviews(closed_by)
  where closed_by is not null;

create index if not exists ops_performance_reviews_updated_by_idx
  on public.ops_performance_reviews(updated_by)
  where updated_by is not null;

create index if not exists ops_performance_review_steps_reviewer_idx
  on public.ops_performance_review_steps(reviewer_user_id, status)
  where reviewer_user_id is not null;

create index if not exists ops_performance_review_steps_completed_by_idx
  on public.ops_performance_review_steps(completed_by)
  where completed_by is not null;

create index if not exists ops_performance_review_items_owner_idx
  on public.ops_performance_review_items(action_owner_user_id, status)
  where action_owner_user_id is not null;

create index if not exists ops_performance_review_items_carried_from_idx
  on public.ops_performance_review_items(carried_from_item_id)
  where carried_from_item_id is not null;

create index if not exists ops_performance_review_items_created_by_idx
  on public.ops_performance_review_items(created_by)
  where created_by is not null;

create index if not exists ops_performance_review_items_closed_by_idx
  on public.ops_performance_review_items(closed_by)
  where closed_by is not null;

create index if not exists ops_performance_review_items_updated_by_idx
  on public.ops_performance_review_items(updated_by)
  where updated_by is not null;

create index if not exists ops_performance_review_updates_company_idx
  on public.ops_performance_review_updates(company_id, created_at desc);

create index if not exists ops_performance_review_updates_item_idx
  on public.ops_performance_review_updates(review_item_id, created_at desc)
  where review_item_id is not null;

create index if not exists ops_performance_review_updates_created_by_idx
  on public.ops_performance_review_updates(created_by)
  where created_by is not null;

commit;
