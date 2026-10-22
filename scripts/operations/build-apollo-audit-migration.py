"""Emit supabase/migrations/*_apollo_audit_programme.sql from the Apollo seed."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SEED = ROOT / "supabase" / "seeds" / "amazon-now-apollo-audit.json"
OUT = ROOT / "supabase" / "migrations" / "20261023010000_apollo_audit_programme.sql"


def main() -> None:
    template = json.loads(SEED.read_text(encoding="utf-8"))
    payload = json.dumps(template, ensure_ascii=False)
    # dollar-quote that won't collide with content
    tag = "$apollo_v2$"
    if tag in payload:
        raise SystemExit("seed contains dollar-quote tag")
    sql = f"""-- Apollo CM_DS_Visit_Audit programme: full question bank, audit types, scoring & reports columns.
begin;
alter table public.ops_store_audits
  add column if not exists audit_type text not null default 'mock',
  add column if not exists score numeric(5,1),
  add column if not exists score_band text,
  add column if not exists score_snapshot jsonb,
  add column if not exists amazon_score numeric(5,1),
  add column if not exists amazon_auditor text,
  add column if not exists present_sm_name text,
  add column if not exists started_lat double precision,
  add column if not exists started_lng double precision;

do $$ begin
  alter table public.ops_store_audits
    drop constraint if exists ops_store_audits_audit_type_check;
  alter table public.ops_store_audits
    add constraint ops_store_audits_audit_type_check
    check (audit_type in ('self','mock','amazon'));
  alter table public.ops_store_audits
    drop constraint if exists ops_store_audits_score_band_check;
  alter table public.ops_store_audits
    add constraint ops_store_audits_score_band_check
    check (score_band is null or score_band in ('Good','Watch','Risk'));
end $$;

create index if not exists ops_store_audits_type_scope
  on public.ops_store_audits(company_id, location_id, audit_type, scheduled_for desc)
  where deleted_at is null;

-- Refresh the live master checklist for every company (new audits snapshot this version).
update public.ops_store_audit_master
set
  template = {tag}{payload}{tag}::jsonb,
  version = version + 1,
  updated_at = now();

notify pgrst, 'reload schema';
commit;
"""
    OUT.write_text(sql, encoding="utf-8")
    print("wrote", OUT, "bytes", OUT.stat().st_size)


if __name__ == "__main__":
    main()
