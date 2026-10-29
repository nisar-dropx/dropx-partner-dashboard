import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { PageHead } from "@/components/page-head";
import { SubmitButton } from "@/components/submit-button";
import { VendorWorkspaceNavigation, type VendorSection } from "@/components/vendor-workspace-navigation";
import { createVendorContract, generateVendorBillingCycle, saveVendorCategory, submitVendorBillingCycle } from "@/app/vendors/actions";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { supabaseAdmin } from "@/lib/supabase-admin";

type Category = {
  id: string;
  code: string;
  name: string;
  operating_model: "fleet_attendance" | "biometric_attendance" | "fixed_contract";
  allowed_payout_months: number[];
  requires_invoice: boolean;
  payment_head_id: string | null;
  is_active: boolean;
  sort_order: number;
};

type Contract = {
  id: string;
  contract_no: string;
  category_id: string;
  vendor_id: string;
  location_id: string;
  fleet_vehicle_id: string | null;
  payout_frequency_months: number;
  rate_type: string;
  rate_amount: number;
  attendance_source: string;
  invoice_required: boolean;
  status: string;
  start_date: string;
  end_date: string | null;
  next_period_start: string;
  vendors: { full_name: string; dropx_id: string | null } | { full_name: string; dropx_id: string | null }[] | null;
  stations: { station_code: string } | { station_code: string }[] | null;
  fleet_vehicles: { vehicle_no: string } | { vehicle_no: string }[] | null;
  vendor_service_categories: { name: string; code: string } | { name: string; code: string }[] | null;
};

type Cycle = {
  id: string;
  contract_id: string;
  period_start: string;
  period_end: string;
  expected_units: number;
  present_units: number;
  absent_units: number;
  gross_amount: number;
  deduction_amount: number;
  payable_amount: number;
  status: string;
  invoice_number: string | null;
  payment_request_id: string | null;
  payment_requests: { request_no: string; status: string; approval_status: string } | { request_no: string; status: string; approval_status: string }[] | null;
};

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function money(value: number | string | null | undefined) {
  return `₹${Number(value ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function frequencyLabel(months: number) {
  return months === 1 ? "Monthly" : months === 3 ? "Every 3 months" : months === 6 ? "Every 6 months" : "Yearly";
}

function categoryForSection(section: VendorSection) {
  return section === "van" ? "VAN_VENDOR"
    : section === "security" ? "SECURITY_GUARD"
      : section === "housekeeping" ? "HOUSEKEEPING"
        : section === "pest" ? "PEST_CONTROL" : null;
}

function statusTone(status: string) {
  return ["active", "paid", "approved", "processed"].includes(status.toLowerCase()) ? "success"
    : ["returned", "rejected", "cancelled", "terminated"].includes(status.toLowerCase()) ? "danger" : "warning";
}

function VendorSummary({ categories, contracts, cycles }: { categories: Category[]; contracts: Contract[]; cycles: Cycle[] }) {
  const activeContracts = contracts.filter(contract => contract.status === "active").length;
  const pending = cycles.filter(cycle => ["ready", "approval_pending", "submitted"].includes(cycle.status));
  return (
    <section className="vendor-kpis" aria-label="Vendor lifecycle summary">
      <article><span>Service categories</span><strong>{categories.filter(row => row.is_active).length}</strong><small>Configured in master</small></article>
      <article><span>Active contracts</span><strong>{activeContracts}</strong><small>Across locations</small></article>
      <article><span>Ready invoices</span><strong>{cycles.filter(cycle => cycle.status === "ready").length}</strong><small>Awaiting upload/submission</small></article>
      <article><span>Pending payments</span><strong>{pending.length}</strong><small>{money(pending.reduce((sum, row) => sum + Number(row.payable_amount), 0))}</small></article>
    </section>
  );
}

function CategoryCards({ categories, contracts }: { categories: Category[]; contracts: Contract[] }) {
  const hrefByCode: Record<string, VendorSection> = { VAN_VENDOR: "van", SECURITY_GUARD: "security", HOUSEKEEPING: "housekeeping", PEST_CONTROL: "pest" };
  return (
    <section className="vendor-category-grid">
      {categories.map(category => {
        const count = contracts.filter(contract => contract.category_id === category.id && contract.status === "active").length;
        return <Link className="vendor-category-card" href={`/vendors?section=${hrefByCode[category.code] ?? "contracts"}`} key={category.id}>
          <div><span>{category.operating_model === "fixed_contract" ? "Contract service" : "Attendance service"}</span><h2>{category.name}</h2></div>
          <strong>{count}</strong><small>active contract{count === 1 ? "" : "s"}</small>
        </Link>;
      })}
    </section>
  );
}

function ContractForm({
  categories, contacts, defaultCategory, heads, locations, vehicles, vendors
}: {
  categories: Category[];
  contacts: { id: string; account_holder_name: string; bank_account_no: string | null }[];
  defaultCategory?: Category | null;
  heads: { id: string; code: string; name: string }[];
  locations: { id: string; station_code: string; station_name: string | null }[];
  vehicles: { id: string; vehicle_no: string; station_code: string; vendor_id: string | null }[];
  vendors: { id: string; full_name: string; dropx_id: string | null }[];
}) {
  const categoryOptions = defaultCategory ? [defaultCategory] : categories.filter(category => category.is_active);
  return (
    <section className="panel vendor-contract-form">
      <div className="panel-head"><div><h2>Activate service contract</h2><p className="subtle">Bank beneficiary must already be verified. Billing follows the selected category master.</p></div><Link className="button secondary" href="/master/contacts">Add / verify bank account</Link></div>
      <form action={createVendorContract} className="panel-body form-grid four">
        <input type="hidden" name="return_section" value={defaultCategory ? ({ VAN_VENDOR: "van", SECURITY_GUARD: "security", HOUSEKEEPING: "housekeeping", PEST_CONTROL: "pest" }[defaultCategory.code] ?? "contracts") : "contracts"} />
        <label>Service category<select className="select" name="category_id" defaultValue={defaultCategory?.id ?? ""} required>{!defaultCategory ? <option value="">Select category</option> : null}{categoryOptions.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        <label>Vendor<select className="select" name="vendor_id" required><option value="">Select vendor</option>{vendors.map(row => <option key={row.id} value={row.id}>{row.full_name} {row.dropx_id ? `· ${row.dropx_id}` : ""}</option>)}</select></label>
        <label>Location<select className="select" name="location_id" required><option value="">Select station</option>{locations.map(row => <option key={row.id} value={row.id}>{row.station_code} · {row.station_name ?? ""}</option>)}</select></label>
        <label>Contract number<input className="field" name="contract_no" placeholder="Agreement / PO number" required /></label>
        <label>Start date<input className="field" name="start_date" type="date" required /></label>
        <label>End date <span className="subtle">optional</span><input className="field" name="end_date" type="date" /></label>
        <label>Payout frequency<select className="select" name="payout_frequency_months" required>{[1,3,6,12].filter(month => !defaultCategory || defaultCategory.allowed_payout_months.includes(month)).map(month => <option key={month} value={month}>{frequencyLabel(month)}</option>)}</select></label>
        <label>Rate basis<select className="select" name="rate_type"><option value="fixed_cycle">Fixed per cycle</option><option value="daily_attendance">Per marked day</option></select></label>
        <label>Contract rate<input className="field" min="0" name="rate_amount" step="0.01" type="number" required /></label>
        <label>Verified bank beneficiary<select className="select" name="payment_contact_id" required><option value="">Select verified account</option>{contacts.map(row => <option key={row.id} value={row.id}>{row.account_holder_name} · ••••{row.bank_account_no?.slice(-4)}</option>)}</select></label>
        <label>Payment head<select className="select" name="payment_head_id" defaultValue={defaultCategory?.payment_head_id ?? ""} required><option value="">Select configured head</option>{heads.map(row => <option key={row.id} value={row.id}>{row.name} · {row.code}</option>)}</select></label>
        <label>Fleet vehicle {defaultCategory?.operating_model === "fleet_attendance" ? "" : <span className="subtle">van only</span>}<select className="select" name="fleet_vehicle_id"><option value="">Not applicable</option>{vehicles.map(row => <option key={row.id} value={row.id}>{row.vehicle_no} · {row.station_code}</option>)}</select></label>
        <div className="form-actions"><SubmitButton className="button primary" pendingText="Activating">Activate contract</SubmitButton></div>
      </form>
    </section>
  );
}

function ContractsTable({ contracts, cycles, returnSection }: { contracts: Contract[]; cycles: Cycle[]; returnSection: VendorSection }) {
  return (
    <section className="panel vendor-contract-list">
      <div className="panel-head"><div><h2>Contracts and billing</h2><p className="subtle">Generate a closed cycle, review attendance deductions, upload invoice, then submit into Payment Approvals.</p></div></div>
      <div className="vendor-contract-stack">
        {contracts.length ? contracts.map(contract => {
          const vendor = firstRelation(contract.vendors);
          const station = firstRelation(contract.stations);
          const category = firstRelation(contract.vendor_service_categories);
          const vehicle = firstRelation(contract.fleet_vehicles);
          const contractCycles = cycles.filter(cycle => cycle.contract_id === contract.id);
          return <article className="vendor-contract-row" key={contract.id}>
            <div className="vendor-contract-head">
              <div><span className="eyebrow">{category?.name ?? "Vendor service"}</span><h3>{vendor?.full_name ?? "Vendor"}</h3><p>{contract.contract_no} · {station?.station_code ?? "-"}{vehicle ? ` · ${vehicle.vehicle_no}` : ""}</p></div>
              <div className="vendor-contract-meta"><span className={`vendor-status ${statusTone(contract.status)}`}>{contract.status}</span><strong>{money(contract.rate_amount)}</strong><small>{contract.rate_type === "daily_attendance" ? "per marked day" : frequencyLabel(contract.payout_frequency_months)}</small></div>
              <form action={generateVendorBillingCycle}><input type="hidden" name="contract_id" value={contract.id}/><input type="hidden" name="return_section" value={returnSection}/><SubmitButton className="button secondary" pendingText="Calculating" confirmMessage="Create the next vendor billing cycle?" confirmTitle="Generate billing cycle" confirmDescription="Attendance and Fleet marks are snapshotted now. Missing required marks are treated as absent.">Generate next cycle</SubmitButton></form>
            </div>
            {contractCycles.length ? <div className="vendor-cycle-list">{contractCycles.map(cycle => {
              const payment = firstRelation(cycle.payment_requests);
              return <div className="vendor-cycle-row" key={cycle.id}>
                <div><strong>{cycle.period_start} → {cycle.period_end}</strong><small>{cycle.present_units}/{cycle.expected_units} marked · {cycle.absent_units} absent</small></div>
                <div><span>Gross {money(cycle.gross_amount)}</span><small>Deduction {money(cycle.deduction_amount)}</small></div>
                <div><strong>{money(cycle.payable_amount)}</strong><span className={`vendor-status ${statusTone(payment?.status ?? cycle.status)}`}>{payment ? `${payment.request_no} · ${payment.approval_status}` : cycle.status}</span></div>
                {cycle.status === "ready" ? <form action={submitVendorBillingCycle} className="vendor-invoice-form">
                  <input type="hidden" name="cycle_id" value={cycle.id}/><input type="hidden" name="return_section" value={returnSection}/>
                  <input className="field" name="invoice_number" placeholder="Invoice no." required/>
                  <input className="field" name="invoice" type="file" accept="application/pdf,image/png,image/jpeg" required={contract.invoice_required}/>
                  <input className="field" name="remarks" placeholder="Remarks" required/>
                  <SubmitButton className="button primary" pendingText="Submitting">Submit</SubmitButton>
                </form> : payment ? <Link className="button secondary" href={`/payments/requests?view=${cycle.payment_request_id}`}>Open payment</Link> : null}
              </div>;
            })}</div> : <p className="vendor-empty-inline">No billing cycle generated yet. A cycle can be generated only after its period closes.</p>}
          </article>;
        }) : <div className="empty-state"><strong>No service contracts yet.</strong><p>Add a vendor in the register, verify its bank account, then activate a contract.</p></div>}
      </div>
    </section>
  );
}

function ServiceMaster({ categories, heads }: { categories: Category[]; heads: { id: string; code: string; name: string }[] }) {
  return (
    <section className="vendor-master-grid">
      {categories.map(category => <form action={saveVendorCategory} className="panel vendor-master-card" key={category.id}>
        <input type="hidden" name="id" value={category.id}/><input type="hidden" name="return_section" value="master"/>
        <div className="panel-head"><div><p className="eyebrow">{category.code}</p><h2>{category.name}</h2></div><span className={`vendor-status ${category.is_active ? "success" : "danger"}`}>{category.is_active ? "Active" : "Disabled"}</span></div>
        <div className="panel-body form-grid two">
          <label>Name<input className="field" name="name" defaultValue={category.name} required/></label>
          <label>Code<input className="field" name="code" defaultValue={category.code} required/></label>
          <label>Operating model<select className="select" name="operating_model" defaultValue={category.operating_model}><option value="fleet_attendance">Fleet daily marks</option><option value="biometric_attendance">Biometric attendance</option><option value="fixed_contract">Fixed contract</option></select></label>
          <label>Payment head<select className="select" name="payment_head_id" defaultValue={category.payment_head_id ?? ""}><option value="">Needs configuration</option>{heads.map(row => <option key={row.id} value={row.id}>{row.name} · {row.code}</option>)}</select></label>
          <fieldset className="vendor-frequency-field"><legend>Allowed payout cycles</legend>{[1,3,6,12].map(month => <label key={month}><input defaultChecked={category.allowed_payout_months.includes(month)} name="allowed_payout_months" type="checkbox" value={month}/>{frequencyLabel(month)}</label>)}</fieldset>
          <label className="checkbox-row"><input defaultChecked={category.requires_invoice} name="requires_invoice" type="checkbox"/> Invoice required</label>
          <label>Status<select className="select" name="is_active" defaultValue={String(category.is_active)}><option value="true">Active</option><option value="false">Disabled</option></select></label>
          <input name="sort_order" type="hidden" value={category.sort_order}/>
          <div className="form-actions"><SubmitButton className="button primary">Save category</SubmitButton></div>
        </div>
      </form>)}
      <form action={saveVendorCategory} className="panel vendor-master-card">
        <input type="hidden" name="return_section" value="master"/>
        <div className="panel-head"><div><p className="eyebrow">Configurable master</p><h2>Add another service</h2></div></div>
        <div className="panel-body form-grid two">
          <label>Name<input className="field" name="name" placeholder="Service name" required/></label>
          <label>Code<input className="field" name="code" placeholder="SERVICE_CODE" required/></label>
          <label>Operating model<select className="select" name="operating_model"><option value="fixed_contract">Fixed contract</option><option value="fleet_attendance">Fleet daily marks</option><option value="biometric_attendance">Biometric attendance</option></select></label>
          <label>Payment head<select className="select" name="payment_head_id"><option value="">Configure later</option>{heads.map(row => <option key={row.id} value={row.id}>{row.name} · {row.code}</option>)}</select></label>
          <fieldset className="vendor-frequency-field"><legend>Allowed payout cycles</legend>{[1,3,6,12].map(month => <label key={month}><input defaultChecked={month === 1} name="allowed_payout_months" type="checkbox" value={month}/>{frequencyLabel(month)}</label>)}</fieldset>
          <label className="checkbox-row"><input defaultChecked name="requires_invoice" type="checkbox"/> Invoice required</label>
          <input name="is_active" type="hidden" value="true"/><input name="sort_order" type="hidden" value="100"/>
          <div className="form-actions"><SubmitButton className="button primary">Add service</SubmitButton></div>
        </div>
      </form>
    </section>
  );
}

export async function VendorLifecycleWorkspace({ section, errorMessage, notice }: { section: VendorSection; errorMessage?: string; notice?: string }) {
  const authorization = await requirePagePermission("vendors", "access");
  const companyId = requireCompanyId(authorization);
  if (!supabaseAdmin) throw new Error("Supabase service role key is not configured.");
  const [categoryResult, vendorResult, locationResult, vehicleResult, contactResult, headResult, contractResult, cycleResult] = await Promise.all([
    supabaseAdmin.from("vendor_service_categories").select("id,code,name,operating_model,allowed_payout_months,requires_invoice,payment_head_id,is_active,sort_order").eq("company_id", companyId).order("sort_order").order("name"),
    supabaseAdmin.from("vendors").select("id,full_name,dropx_id").eq("company_id", companyId).eq("is_active", true).is("deleted_at", null).order("full_name"),
    supabaseAdmin.from("stations").select("id,station_code,station_name").eq("company_id", companyId).eq("is_active", true).order("station_code"),
    supabaseAdmin.from("fleet_vehicles").select("id,vehicle_no,station_code,vendor_id").eq("company_id", companyId).eq("status", "active").order("vehicle_no"),
    supabaseAdmin.from("payment_contacts").select("id,account_holder_name,bank_account_no").eq("company_id", companyId).not("verified_at", "is", null).not("bank_account_no", "is", null).order("account_holder_name"),
    supabaseAdmin.from("payment_heads").select("id,code,name").eq("company_id", companyId).eq("is_active", true).order("name"),
    supabaseAdmin.from("vendor_service_contracts").select("id,contract_no,category_id,vendor_id,location_id,fleet_vehicle_id,payout_frequency_months,rate_type,rate_amount,attendance_source,invoice_required,status,start_date,end_date,next_period_start,vendors(full_name,dropx_id),stations(station_code),fleet_vehicles(vehicle_no),vendor_service_categories(name,code)").eq("company_id", companyId).order("created_at", { ascending: false }),
    supabaseAdmin.from("vendor_billing_cycles").select("id,contract_id,period_start,period_end,expected_units,present_units,absent_units,gross_amount,deduction_amount,payable_amount,status,invoice_number,payment_request_id,payment_requests(request_no,status,approval_status)").eq("company_id", companyId).order("period_end", { ascending: false })
  ]);
  const firstError = [categoryResult.error, vendorResult.error, locationResult.error, vehicleResult.error, contactResult.error, headResult.error, contractResult.error, cycleResult.error].find(Boolean);
  if (firstError) throw new Error(firstError.message);
  const categories = (categoryResult.data ?? []) as Category[];
  const contracts = (contractResult.data ?? []) as unknown as Contract[];
  const cycles = (cycleResult.data ?? []) as unknown as Cycle[];
  const locationScope = authorization.hasAllLocationAccess ? null : new Set(authorization.locationScopeIds);
  const locations = (locationResult.data ?? []).filter(row => !locationScope || locationScope.has(row.id));
  const scopedContracts = contracts.filter(row => !locationScope || locationScope.has(row.location_id));
  const scopedContractIds = new Set(scopedContracts.map(row => row.id));
  const scopedCycles = cycles.filter(row => scopedContractIds.has(row.contract_id));
  const categoryCode = categoryForSection(section);
  const selectedCategory = categoryCode ? categories.find(row => row.code === categoryCode) ?? null : null;
  const visibleContracts = selectedCategory ? scopedContracts.filter(row => row.category_id === selectedCategory.id) : scopedContracts;
  const visibleContractIds = new Set(visibleContracts.map(row => row.id));
  const visibleCycles = scopedCycles.filter(row => visibleContractIds.has(row.contract_id));
  const canEdit = Boolean(authorization.permissions.vendors?.canEdit && !authorization.readOnly);

  return (
    <AppShell active="Vendors" pageCode="vendors">
      <PageHead eyebrow="Vendor operations" title="Vendor lifecycle" subtitle="Register, contract, measure service, submit invoice, approve and process payment in one traceable flow." />
      <VendorWorkspaceNavigation active={section}/>
      {errorMessage || notice ? <section className={`panel message-panel ${errorMessage ? "error" : "success"}`}><div className="panel-body"><strong>{errorMessage ? "Action required" : "Completed"}</strong><p className="subtle" style={{ marginTop: 6 }}>{errorMessage ?? notice}</p></div></section> : null}
      <VendorSummary categories={categories} contracts={scopedContracts} cycles={scopedCycles}/>
      {section === "overview" ? <>
        <CategoryCards categories={categories.filter(row => row.is_active)} contracts={scopedContracts}/>
        <section className="panel"><div className="panel-head"><h2>How a vendor payment moves</h2></div><div className="panel-body vendor-flow"><span>1 · Register vendor</span><i>→</i><span>2 · Verify bank</span><i>→</i><span>3 · Activate contract</span><i>→</i><span>4 · Attendance / invoice</span><i>→</i><span>5 · Manager approvals</span><i>→</i><span>6 · Finance processing</span></div></section>
      </> : null}
      {selectedCategory ? <>
        <section className="panel vendor-service-intro"><div className="panel-body"><div><p className="eyebrow">{selectedCategory.code}</p><h2>{selectedCategory.name}</h2><p className="subtle">{selectedCategory.operating_model === "fixed_contract" ? "Fixed contract billing with flexible monthly, 3-month, 6-month or yearly cycles as enabled in master." : "Daily positive marks come from Fleet or biometric attendance. Missing marks are treated as absent before payout is calculated."}</p></div><Link className="button secondary" href="/vendors?section=master">Configure service</Link></div></section>
        {canEdit ? <ContractForm categories={categories} contacts={contactResult.data ?? []} defaultCategory={selectedCategory} heads={headResult.data ?? []} locations={locations} vehicles={vehicleResult.data ?? []} vendors={vendorResult.data ?? []}/> : null}
        <ContractsTable contracts={visibleContracts} cycles={visibleCycles} returnSection={section}/>
      </> : null}
      {section === "contracts" ? <>{canEdit ? <ContractForm categories={categories} contacts={contactResult.data ?? []} heads={headResult.data ?? []} locations={locations} vehicles={vehicleResult.data ?? []} vendors={vendorResult.data ?? []}/> : null}<ContractsTable contracts={visibleContracts} cycles={visibleCycles} returnSection="contracts"/></> : null}
      {section === "master" ? canEdit ? <ServiceMaster categories={categories} heads={headResult.data ?? []}/> : <section className="panel"><div className="panel-body">You have view-only access to the vendor service master.</div></section> : null}
    </AppShell>
  );
}
