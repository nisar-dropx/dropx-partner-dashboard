-- Per-location attendance GPS controls (DropX One / Connect).
-- Both default OFF — enable per station from Master → Location Attendance.

alter table public.stations
  add column if not exists attendance_location_tracking_enabled boolean not null default false,
  add column if not exists attendance_integrity_flags_enabled boolean not null default false;

comment on column public.stations.attendance_location_tracking_enabled is
  'When true, Connect collects in-shift GPS heartbeats for workers assigned to this station.';

comment on column public.stations.attendance_integrity_flags_enabled is
  'When true, outside-station / mismatch integrity flags are opened for this station and punches may be held for review.';
