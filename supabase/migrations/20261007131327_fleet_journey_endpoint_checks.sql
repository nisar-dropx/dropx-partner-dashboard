-- Optional GPS evidence only; existing policies, payments and records remain unchanged.
ALTER TABLE public.fleet_daily_km ADD COLUMN IF NOT EXISTS journey_location_check jsonb;
COMMENT ON COLUMN public.fleet_daily_km.journey_location_check IS 'Versioned GPS departure/final-stop checks with assigned geofence snapshot; null means not evaluated.';
