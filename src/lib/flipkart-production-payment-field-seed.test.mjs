import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL(
  "../../supabase/migrations/20261019110000_flipkart_production_payment_fields.sql",
  import.meta.url
);

const ids = {
  company: "00000000-0000-4000-8000-000000000001",
  flipkart: "00000000-0000-4000-8000-000000000002",
  amazon: "00000000-0000-4000-8000-000000000003",
  mdh: "00000000-0000-4000-8000-000000000004",
  odh: "00000000-0000-4000-8000-000000000005",
  edsp: "00000000-0000-4000-8000-000000000006",
  delivery: "00000000-0000-4000-8000-000000000007",
  customerReturn: "00000000-0000-4000-8000-000000000008",
  sellerPickup: "00000000-0000-4000-8000-000000000009",
  staleDeliveryMetric: "00000000-0000-4000-8000-000000000010",
  unrelatedMetric: "00000000-0000-4000-8000-000000000011",
  noFlipkartCompany: "00000000-0000-4000-8000-000000000012",
  otherAmazon: "00000000-0000-4000-8000-000000000013"
};

test("Flipkart production source and MDH/ODH payment-field links are seeded idempotently", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create table public.companies (
        id uuid primary key
      );

      create table public.providers (
        id uuid primary key,
        company_id uuid not null references public.companies(id),
        code text,
        name text
      );

      create table public.location_models (
        id uuid primary key,
        company_id uuid not null references public.companies(id),
        provider_id uuid not null references public.providers(id),
        code text not null,
        name text not null,
        is_active boolean not null default true
      );

      create table public.report_import_master (
        id uuid primary key default gen_random_uuid(),
        company_id uuid not null references public.companies(id),
        source_code text not null,
        name text not null,
        description text,
        file_types text[] not null default array['xlsx']::text[],
        day_offset integer not null default 0,
        upload_time time,
        frequency text not null default 'daily',
        weekday smallint,
        parser_type text not null,
        dedupe_fields text[] not null default array[]::text[],
        is_active boolean not null default true,
        requires_station boolean not null default false,
        station_scope text not null default 'none',
        requires_report_date boolean not null default false,
        report_date_label text,
        date_default_offset integer not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (company_id, source_code)
      );

      create table public.payment_fields (
        id uuid primary key,
        company_id uuid not null references public.companies(id),
        code text not null,
        field_type text not null,
        label text not null,
        is_active boolean not null default true
      );

      create table public.provider_production_metrics (
        id uuid primary key default gen_random_uuid(),
        company_id uuid not null references public.companies(id),
        provider_id uuid not null references public.providers(id),
        provider_model_id uuid references public.location_models(id),
        code text not null,
        name text not null,
        source_key text not null,
        source_keys text[] not null default '{}'::text[],
        calculation_operation text not null default 'direct',
        sort_order integer not null default 0,
        is_active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (company_id, provider_id, source_key)
      );

      create unique index provider_production_metrics_scope_code_uidx
        on public.provider_production_metrics (
          company_id,
          provider_id,
          coalesce(provider_model_id, '00000000-0000-0000-0000-000000000000'::uuid),
          code
        );

      create table public.payment_field_provider_metrics (
        id uuid primary key default gen_random_uuid(),
        company_id uuid not null references public.companies(id),
        payment_field_id uuid not null references public.payment_fields(id),
        provider_id uuid not null references public.providers(id),
        provider_model_id uuid references public.location_models(id),
        provider_metric_id uuid not null references public.provider_production_metrics(id),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create unique index payment_field_provider_metrics_model_scope_uidx
        on public.payment_field_provider_metrics (
          company_id,
          payment_field_id,
          provider_id,
          provider_model_id
        ) where provider_model_id is not null;

      insert into public.companies (id) values
        ('${ids.company}'),
        ('${ids.noFlipkartCompany}');
      insert into public.providers (id, company_id, code, name) values
        ('${ids.flipkart}', '${ids.company}', 'FLIPKART', 'Flipkart'),
        ('${ids.amazon}', '${ids.company}', 'AMAZON', 'Amazon'),
        ('${ids.otherAmazon}', '${ids.noFlipkartCompany}', 'AMAZON', 'Amazon');
      insert into public.location_models (id, company_id, provider_id, code, name) values
        ('${ids.mdh}', '${ids.company}', '${ids.flipkart}', 'MDH', 'MDH'),
        ('${ids.odh}', '${ids.company}', '${ids.flipkart}', 'ODH', 'ODH'),
        ('${ids.edsp}', '${ids.company}', '${ids.amazon}', 'EDSP', 'EDSP');
      insert into public.payment_fields (id, company_id, code, field_type, label, is_active) values
        ('${ids.delivery}', '${ids.company}', 'DELIVERY', 'production', 'Delivery', true),
        ('${ids.customerReturn}', '${ids.company}', 'CRETURN', 'production', 'Customer return', true),
        ('${ids.sellerPickup}', '${ids.company}', 'SELLER_PICKUP', 'production', 'Seller pickup', true);

      insert into public.report_import_master (
        company_id, source_code, name, parser_type, frequency,
        dedupe_fields, requires_station, station_scope, requires_report_date
      ) values (
        '${ids.company}', 'flipkart_production', 'Old Flipkart source', 'legacy_parser', 'daily',
        array['old key']::text[], true, 'legacy', true
      );

      insert into public.provider_production_metrics (
        id, company_id, provider_id, code, name, source_key, source_keys,
        calculation_operation, sort_order, is_active
      ) values
        (
          '${ids.staleDeliveryMetric}', '${ids.company}', '${ids.flipkart}',
          'OLD_DELIVERY', 'Old delivery', 'total_delivery', '{}'::text[], 'sum', 99, false
        ),
        (
          '${ids.unrelatedMetric}', '${ids.company}', '${ids.flipkart}',
          'SELLER_PICKUP', 'Seller pickup', 'seller_pickup', array['seller_pickup']::text[], 'direct', 30, true
        );

      insert into public.payment_field_provider_metrics (
        company_id, payment_field_id, provider_id, provider_model_id, provider_metric_id
      ) values (
        '${ids.company}', '${ids.delivery}', '${ids.flipkart}', '${ids.mdh}', '${ids.unrelatedMetric}'
      );
    `);

    const migration = await readFile(migrationUrl, "utf8");
    await db.exec(migration);
    await db.exec(migration);

    const source = await db.query(`
      select
        source_code,
        name,
        description,
        parser_type,
        frequency,
        file_types,
        dedupe_fields,
        requires_station,
        station_scope,
        requires_report_date,
        report_date_label
      from public.report_import_master
      where company_id = '${ids.company}'
        and source_code = 'flipkart_production'
    `);
    assert.deepEqual(source.rows, [{
      source_code: "flipkart_production",
      name: "Flipkart Production",
      description: "Two Flipkart production uploads per month: 1-15 and 16-month-end. BP_RUNSHEET completed units are deliveries and BP_PICKUPSHEET completed units are customer returns.",
      parser_type: "flipkart_production",
      frequency: "monthly",
      file_types: ["xlsx", "xls", "csv"],
      dedupe_fields: ["sheet_id"],
      requires_station: false,
      station_scope: "none",
      requires_report_date: false,
      report_date_label: null
    }]);

    const metrics = await db.query(`
      select code, name, source_key, source_keys, calculation_operation, sort_order, is_active
      from public.provider_production_metrics
      where company_id = '${ids.company}'
        and provider_id = '${ids.flipkart}'
        and source_key in ('total_delivery', 'customer_return')
      order by sort_order
    `);
    assert.deepEqual(metrics.rows, [
      {
        code: "FLIPKART_DELIVERY",
        name: "Flipkart Delivery",
        source_key: "total_delivery",
        source_keys: ["total_delivery"],
        calculation_operation: "direct",
        sort_order: 10,
        is_active: true
      },
      {
        code: "FLIPKART_CUSTOMER_RETURN",
        name: "Flipkart Customer Return",
        source_key: "customer_return",
        source_keys: ["customer_return"],
        calculation_operation: "direct",
        sort_order: 20,
        is_active: true
      }
    ]);

    const links = await db.query(`
      select field.code as field_code, model.code as model_code, metric.source_key
      from public.payment_field_provider_metrics selection
      join public.payment_fields field on field.id = selection.payment_field_id
      join public.location_models model on model.id = selection.provider_model_id
      join public.provider_production_metrics metric on metric.id = selection.provider_metric_id
      where selection.company_id = '${ids.company}'
        and selection.provider_id = '${ids.flipkart}'
      order by field.code, model.code
    `);
    assert.deepEqual(links.rows, [
      { field_code: "CRETURN", model_code: "MDH", source_key: "customer_return" },
      { field_code: "CRETURN", model_code: "ODH", source_key: "customer_return" },
      { field_code: "DELIVERY", model_code: "MDH", source_key: "total_delivery" },
      { field_code: "DELIVERY", model_code: "ODH", source_key: "total_delivery" }
    ]);

    const counts = await db.query(`
      select
        (select count(*)::int from public.report_import_master where source_code = 'flipkart_production') as sources,
        (select count(*)::int from public.provider_production_metrics where provider_id = '${ids.flipkart}' and source_key in ('total_delivery', 'customer_return')) as metrics,
        (select count(*)::int from public.payment_field_provider_metrics where provider_id = '${ids.flipkart}') as links,
        (select count(*)::int from public.provider_production_metrics where provider_id = '${ids.amazon}') as amazon_metrics
    `);
    assert.deepEqual(counts.rows, [{ sources: 1, metrics: 2, links: 4, amazon_metrics: 0 }]);
  } finally {
    await db.close();
  }
});
