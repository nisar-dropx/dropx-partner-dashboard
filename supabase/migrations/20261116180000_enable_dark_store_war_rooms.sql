-- Enable all 7 dark store war room groups
UPDATE report_bot_groups
SET is_enabled = true
WHERE company_id = '43866344-b550-4e8a-9a2d-9d23f3d8a997'
  AND workspace = 'dark_store'
  AND group_name ILIKE '%war room%'
  AND location_id IS NOT NULL;
