-- Payment methods may be assigned to any eligible Workforce associate.
-- Designation-to-method rows are retained as legacy configuration data, but
-- they no longer block provider ID and payment-rate mappings.
drop trigger if exists workforce_mapping_payment_designation_guard
  on public.field_executive_provider_mappings;
