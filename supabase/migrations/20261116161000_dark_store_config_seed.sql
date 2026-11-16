-- Seed ds_store_config for all active dark store groups
-- warehouse_id = station_code for HDNI stores
-- region_code = eu-south-2 for DUB region stores
-- store_type = KISAN for GroceryCentral

insert into ds_store_config
  (company_id, station_id, station_code, amazon_store_id, warehouse_id, store_family, region_code, store_type)
values
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', '92f260de-603e-4a93-8d14-eaa038f67c90', 'TZC4', 'DU-AA-533', 'TZC4', 'HDNI', 'eu-south-2', 'KISAN'),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', 'afdc82eb-0e9b-44a1-96a5-a577b7ae99cb', 'TCC3', 'DU-AA-35',  'TCC3', 'HDNI', 'eu-south-2', 'KISAN'),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', 'e30d5543-eec7-4c5e-bddb-d9079e1eb832', 'TCD4', 'DU-AA-45',  'TCD4', 'HDNI', 'eu-south-2', 'KISAN'),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', '61358fbe-c333-4535-9483-154cd5a15803', 'TTA5', 'DU-AA-76',  'TTA5', 'HDNI', 'eu-south-2', 'KISAN'),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', 'd94aa34e-a163-4c35-83e9-19cdc773a39c', 'TTB3', 'DU-AA-83',  'TTB3', 'HDNI', 'eu-south-2', 'KISAN'),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', 'b579603a-a62f-46dc-b0ec-0668f9a75010', 'TTG9', 'DU-AA-485', 'TTG9', 'HDNI', 'eu-south-2', 'KISAN'),
  ('43866344-b550-4e8a-9a2d-9d23f3d8a997', 'd2a64571-c51e-405b-8461-94257bdec772', 'TFB7', 'DU-AA-247', 'TFB7', 'HDNI', 'eu-south-2', 'KISAN')
on conflict (company_id, station_code) do update set
  amazon_store_id = excluded.amazon_store_id,
  updated_at = now();
