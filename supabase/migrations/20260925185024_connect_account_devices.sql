-- One-device-per-account binding for DropX One. A worker logging in with the same
-- mobile+PIN from a different Android device is blocked outright until HR/ops clears the
-- existing binding (dropx-hrms gets a reset panel reading/writing this table directly --
-- both repos share this Supabase project). Device identity is the native app's ANDROID_ID
-- (or an app-generated UUID fallback), never IMEI -- Play Store policy blocks apps from
-- reading IMEI/hardware serial for anything outside a narrow telephony/MDM allowlist, and a
-- stable per-install ID achieves the same binding goal without that risk. Web sessions have
-- no comparably durable device fingerprint (cleared cookies/storage defeat it trivially), so
-- binding applies only to platform='app' rows for now -- web access will get its own,
-- separate designation-based restriction later, not device binding.
create table if not exists connect_account_devices (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  profile_type text not null,
  device_id text not null,
  platform text not null default 'app' check (platform in ('app', 'web')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  reset_at timestamptz,
  reset_by text,
  reset_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One ACTIVE binding per account+platform: a prior binding is cleared by setting reset_at,
-- not by deleting the row, so device-change history survives for HR to review. The partial
-- unique index (reset_at is null) is what actually enforces "one device at a time" --
-- inserting a new active binding after a reset is a fresh row, not an update, keeping every
-- device this account has ever used on record.
create unique index if not exists connect_account_devices_active_binding
  on connect_account_devices (account_id, profile_type, platform)
  where reset_at is null;

create index if not exists connect_account_devices_account_idx
  on connect_account_devices (account_id, profile_type);

create index if not exists connect_account_devices_device_idx
  on connect_account_devices (device_id);
