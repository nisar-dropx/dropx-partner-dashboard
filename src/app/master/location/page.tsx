import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { LocationProviderModelFields } from "@/components/location-provider-model-fields";
import { MasterDataLists } from "@/components/master-data-lists";
import { PageHead } from "@/components/page-head";
import { SearchableSelect } from "@/components/searchable-select";
import { SubmitButton } from "@/components/submit-button";
import { isSupabaseAdminConfigured, supabaseAdmin } from "@/lib/supabase-admin";
import { requirePagePermission } from "@/lib/authorization";
import { requireCompanyId } from "@/lib/company-scope";
import { indiaStateCode, indiaStateOptions } from "@/lib/india-states";
import { loadPeopleOperationalHierarchy } from "@/lib/people-operational-hierarchy";
import {
  createLocation,
  deleteLocation,
  updateLocation
} from "../../settings/actions";

type ProviderRow = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
};

type ModelRow = {
  id: string;
  provider_id: string | null;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  providers?: { code: string; name: string } | null;
};

type LocationRow = {
  id: string;
  provider_id: string | null;
  location_model_id: string | null;
  station_code: string;
  station_name: string | null;
  address: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  region: string | null;
  aom: string | null;
  cluster_manager: string | null;
  cluster: string | null;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_m?: number | null;
  station_email: string | null;
  station_manager_email: string | null;
  parent_station_id: string | null;
  hide_from_location_list: boolean;
  is_active: boolean;
  providers?: { code: string; name: string } | null;
  location_models?: { code: string; name: string } | null;
};

type UserRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string;
  role_id: string | null;
  reports_to_user_id: string | null;
  is_active: boolean;
};

type UserRoleRow = {
  id: string;
  code: string;
  name: string;
  location_access_mode: string | null;
};

type RawLocationRow = Omit<LocationRow, "providers" | "location_models"> & {
  providers?: { code: string; name: string } | { code: string; name: string }[] | null;
  location_models?: { code: string; name: string } | { code: string; name: string }[] | null;
};

type RawModelRow = Omit<ModelRow, "providers"> & {
  providers?: { code: string; name: string } | { code: string; name: string }[] | null;
};

function firstRelation<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function normalizeEmail(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function isMissingColumnError(error: unknown) {
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("column") && (message.includes("does not exist") || message.includes("schema cache"));
}

function descendantUserEmails(users: UserRow[], managerId: string) {
  const descendants = new Set<string>();
  let added = true;

  while (added) {
    added = false;
    users.forEach((user) => {
      if (user.reports_to_user_id === managerId || (user.reports_to_user_id && descendants.has(user.reports_to_user_id))) {
        if (!descendants.has(user.id)) {
          descendants.add(user.id);
          added = true;
        }
      }
    });
  }

  return users
    .filter((user) => user.id === managerId || descendants.has(user.id))
    .map((user) => normalizeEmail(user.email))
    .filter(Boolean);
}

function locationsForAuthorization(locations: LocationRow[], authorization: Awaited<ReturnType<typeof requirePagePermission>>) {
  if (authorization.hasAllLocationAccess) return locations;

  const allowedLocationIds = new Set(authorization.locationScopeIds);
  const signedInEmail = normalizeEmail(authorization.email);

  return locations.filter((location) => {
    if (location.hide_from_location_list) return false;
    if (allowedLocationIds.has(location.id)) return true;
    if (signedInEmail && normalizeEmail(location.station_email) === signedInEmail) return true;
    if (signedInEmail && normalizeEmail(location.station_manager_email) === signedInEmail) return true;
    return false;
  });
}

async function loadMasterData(companyId: string) {
  if (!supabaseAdmin) {
    return {
      providers: [] as ProviderRow[],
      models: [] as ModelRow[],
      users: [] as UserRow[],
      userRoles: [] as UserRoleRow[],
      locations: [] as LocationRow[],
      error: "Supabase service role key is not configured."
    };
  }

  const locationSelect = `
    id,
    provider_id,
    location_model_id,
    station_code,
    station_name,
    address,
    address_line1,
    address_line2,
    city,
    state,
    region,
    aom,
    cluster_manager,
    cluster,
    postal_code,
    latitude,
    longitude,
    geofence_radius_m,
    station_email,
    station_manager_email,
    parent_station_id,
    hide_from_location_list,
    is_active,
    providers (code, name),
    location_models (code, name)
  `;
  const legacyLocationSelect = `
    id,
    provider_id,
    location_model_id,
    station_code,
    station_name,
    address,
    address_line1,
    address_line2,
    city,
    state,
    postal_code,
    latitude,
    longitude,
    geofence_radius_m,
    station_email,
    station_manager_email,
    is_active,
    providers (code, name),
    location_models (code, name)
  `;

  const [providersResult, modelsResult, usersResult, userRolesResult, initialLocationsResult] = await Promise.all([
    supabaseAdmin
      .from("providers")
      .select("id, code, name, is_active")
      .eq("company_id", companyId)
      .order("code"),
    supabaseAdmin
      .from("location_models")
      .select(`
        id,
        provider_id,
        code,
        name,
        description,
        is_active,
        providers (code, name)
      `)
      .eq("company_id", companyId)
      .order("code"),
    supabaseAdmin
      .from("profiles")
      .select("id, full_name, email, role, role_id, reports_to_user_id, is_active")
      .eq("is_active", true)
      .eq("company_id", companyId)
      .order("full_name"),
    supabaseAdmin
      .from("user_roles")
      .select("id, code, name, location_access_mode")
      .eq("is_active", true)
      .eq("company_id", companyId)
      .order("name"),
    supabaseAdmin
      .from("stations")
      .select(locationSelect)
      .eq("company_id", companyId)
      .order("station_code")
  ]);
  let locationsResult: { data: unknown[] | null; error: { message?: string } | null } = initialLocationsResult;
  if (isMissingColumnError(locationsResult.error)) {
    locationsResult = await supabaseAdmin
      .from("stations")
      .select(legacyLocationSelect)
      .eq("company_id", companyId)
      .order("station_code");
  }

  const error =
    providersResult.error?.message ||
    modelsResult.error?.message ||
    usersResult.error?.message ||
    userRolesResult.error?.message ||
    locationsResult.error?.message ||
    null;

  const rawLocations = (locationsResult.data ?? []) as unknown as RawLocationRow[];
  const rawModels = (modelsResult.data ?? []) as unknown as RawModelRow[];
  const hierarchy = await loadPeopleOperationalHierarchy(companyId, rawLocations.map((row) => row.id));

  return {
    providers: (providersResult.data ?? []) as ProviderRow[],
    models: rawModels.map((row) => ({
      ...row,
      providers: firstRelation(row.providers)
    })) as ModelRow[],
    users: (usersResult.data ?? []) as UserRow[],
    userRoles: (userRolesResult.data ?? []) as UserRoleRow[],
    locations: rawLocations.map((row) => {
      const resolved = hierarchy.byLocation.get(row.id);
      const clusterManager = resolved?.clusterManagers[0]?.name ?? null;
      return {
        ...row,
        aom: resolved?.areaOperationsManagers[0]?.name ?? null,
        cluster_manager: clusterManager,
        cluster: clusterManager,
        hide_from_location_list: Boolean(row.hide_from_location_list),
        providers: firstRelation(row.providers),
        location_models: firstRelation(row.location_models)
      };
    }) as LocationRow[],
    error: error || hierarchy.error
  };
}

export const dynamic = "force-dynamic";

type SettingsPageProps = {
  searchParams?: {
    add?: string;
    edit?: string;
    locationError?: string;
    locationNotice?: string;
  };
};

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const authorization = await requirePagePermission("master_locations", "access");
  const companyId = requireCompanyId(authorization);
  const pagePermission = authorization.permissions.master_locations;
  const { providers, models, users, userRoles, locations, error } = await loadMasterData(companyId);
  const visibleLocations = locationsForAuthorization(locations, authorization);
  const addType = pagePermission.canAdd ? searchParams?.add : null;
  const [editType, editId] = (searchParams?.edit ?? "").split(":");
  const editLocation = pagePermission.canEdit && editType === "location" ? visibleLocations.find((row) => row.id === editId) : null;
  const flashError = searchParams?.locationError ?? null;
  const flashNotice = searchParams?.locationNotice ?? null;
  const providerOptions = providers.map((provider) => ({
    value: provider.id,
    label: provider.name,
    helper: provider.code
  }));
  const modelOptions = models.map((model) => ({
    value: model.id,
    label: model.code,
    helper: model.providers?.name ?? undefined,
    providerId: model.provider_id
  }));
  const eligibleManagerUsers = users
    .filter((user) => {
      const role = userRoles.find((item) => item.id === user.role_id);
      return user.email &&
        String(role?.code ?? "").trim().toUpperCase() !== "LOCATION" &&
        String(user.role ?? "").trim().toUpperCase() !== "LOCATION";
    });
  const managerOptions = eligibleManagerUsers
    .map((user) => {
      const role = userRoles.find((item) => item.id === user.role_id)?.name || user.role;
      const scopeEmails = descendantUserEmails(users, user.id);
      return {
        value: user.email ?? "",
        label: user.full_name || user.email || "Unnamed user",
        helper: [role, user.email].filter(Boolean).join(" - "),
        scopeValues: scopeEmails.length ? scopeEmails : [normalizeEmail(user.email)]
      };
    });
  const hierarchyUserOptions = eligibleManagerUsers
    .map((user) => ({
      value: user.email ?? "",
      label: user.full_name || user.email || "Unnamed user",
      helper: [userRoles.find((item) => item.id === user.role_id)?.name || user.role, user.email].filter(Boolean).join(" - ")
    }));
  const parentStationOptions = locations
    .filter((location) => location.id !== editLocation?.id && location.is_active && location.location_models?.code !== "XPT")
    .map((location) => ({
      value: location.id,
      label: `${location.station_code} · ${location.station_name || location.city || "Station"}`,
      helper: location.location_models?.code || undefined
    }));

  return (
    <AppShell active="Locations" pageCode="master_locations">
      <PageHead
        eyebrow="Setup"
        title="Locations"
        subtitle="No demo rows are shown here. These records read from and write to Supabase."
        action={<span className={`status-pill ${isSupabaseAdminConfigured ? "good" : "warn"}`}>{isSupabaseAdminConfigured ? "Database connected" : "Database key missing"}</span>}
      />

      {error ? (
        <section className="panel">
          <div className="panel-body">
            <strong>Database setup needed</strong>
            <p className="subtle" style={{ marginTop: 6 }}>
              {error} Run the master-data SQL migration and add `SUPABASE_SERVICE_ROLE_KEY` in Vercel.
            </p>
          </div>
        </section>
      ) : null}

      {!error && (flashError || flashNotice) ? (
        <section className={`panel message-panel ${flashError ? "error" : "success"}`}>
          <div className="panel-body">
            <strong>{flashError ? "Action required" : "Completed"}</strong>
            <p className="subtle" style={{ marginTop: 6 }}>{flashError ?? flashNotice}</p>
          </div>
        </section>
      ) : null}

      {pagePermission.canView || pagePermission.canEdit
        ? <MasterDataLists canAdd={pagePermission.canAdd} canEdit={pagePermission.canEdit} providers={providers} models={models} locations={visibleLocations} managerOptions={managerOptions} sections={["locations"]} />
        : null}

      {addType === "location" ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide" aria-label="Add location">
            <div className="panel-head">
              <div><h2>Add location</h2><p className="subtle">Create a station, hub, store, branch, or delivery center.</p></div>
              <Link className="icon-button" href="/master/location" scroll={false} aria-label="Close add location">x</Link>
            </div>
            <form action={createLocation} className="form-grid three">
              <label>Location code<input className="field" name="station_code" placeholder="Enter location code" required /></label>
              <label>Location name<input className="field" name="station_name" placeholder="Enter location name" required /></label>
              <LocationProviderModelFields modelOptions={modelOptions} providerOptions={providerOptions} />
              <label>Address line 1<input className="field" name="address_line1" placeholder="Enter address line 1" required /></label>
              <label>Address line 2<input className="field" name="address_line2" placeholder="Enter address line 2" /></label>
              <label>City<input className="field" name="city" placeholder="Enter city" /></label>
              <label>State<SearchableSelect name="state" options={[...indiaStateOptions]} placeholder="Select state" required /></label>
              <label>Manager<SearchableSelect name="station_manager_email" options={hierarchyUserOptions} placeholder="Select manager" required /></label>
              <label>Postal code<input className="field" name="postal_code" placeholder="Enter postal code" /></label>
              <label>Latitude<input className="field" name="latitude" placeholder="Enter latitude" step="any" type="number" min="-90" max="90" /></label>
              <label>Longitude<input className="field" name="longitude" placeholder="Enter longitude" step="any" type="number" min="-180" max="180" /></label>
              <label>Attendance geofence radius (m)
                <input className="field" name="geofence_radius_m" placeholder="e.g. 50, 100, 200" step="1" type="number" min="10" max="5000" defaultValue={50} required />
                <span className="subtle" style={{ marginTop: 4, textTransform: "none", fontSize: 11 }}>Used by DropX One GPS punch. Editable per location — not hardcoded in the app.</span>
              </label>
              <label>Location email<input className="field" name="station_email" placeholder="Enter location email" /></label>
              <label>Parent Location<SearchableSelect name="parent_station_id" options={parentStationOptions} placeholder="Select parent location" /></label>
              <label className="check-row span-3">
                <input name="hide_from_location_list" type="checkbox" />
                <span>Hide from location list</span>
              </label>
              <div className="form-actions span-3 modal-actions">
                <Link className="button secondary" href="/master/location" scroll={false}>Cancel</Link>
                <SubmitButton>Add location</SubmitButton>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {editLocation ? (
        <div className="modal-backdrop">
          <section className="modal-panel wide" aria-label="Edit location">
            <div className="panel-head">
              <div>
                <h2>Edit location</h2>
                <p className="subtle">Operational code can change without changing the hidden location ID.</p>
              </div>
              <Link className="icon-button" href="/master/location" scroll={false} aria-label="Close edit location">x</Link>
            </div>
            <form action={updateLocation} className="form-grid three">
              <input type="hidden" name="id" value={editLocation.id} />
              <label>Location code<input className="field" name="station_code" defaultValue={editLocation.station_code} required /></label>
              <label>Location name<input className="field" name="station_name" defaultValue={editLocation.station_name ?? ""} required /></label>
              <LocationProviderModelFields initialModelId={editLocation.location_model_id} initialProviderId={editLocation.provider_id} modelOptions={modelOptions} providerOptions={providerOptions} />
              <label>Address line 1<input className="field" name="address_line1" defaultValue={editLocation.address_line1 || editLocation.address || ""} required /></label>
              <label>Address line 2<input className="field" name="address_line2" defaultValue={editLocation.address_line2 ?? ""} /></label>
              <label>City<input className="field" name="city" defaultValue={editLocation.city ?? ""} /></label>
              <label>State<SearchableSelect name="state" options={[...indiaStateOptions]} defaultValue={indiaStateCode(editLocation.state)} placeholder="Select state" required /></label>
              <label>Manager<SearchableSelect name="station_manager_email" options={hierarchyUserOptions} defaultValue={editLocation.station_manager_email ?? ""} placeholder="Select manager" required /></label>
              <label>Postal code<input className="field" name="postal_code" defaultValue={editLocation.postal_code ?? ""} /></label>
              <label>Latitude<input className="field" name="latitude" defaultValue={editLocation.latitude ?? ""} step="any" type="number" min="-90" max="90" /></label>
              <label>Longitude<input className="field" name="longitude" defaultValue={editLocation.longitude ?? ""} step="any" type="number" min="-180" max="180" /></label>
              <label>Attendance geofence radius (m)
                <input className="field" name="geofence_radius_m" defaultValue={editLocation.geofence_radius_m ?? 50} step="1" type="number" min="10" max="5000" required />
                <span className="subtle" style={{ marginTop: 4, textTransform: "none", fontSize: 11 }}>Used by DropX One GPS punch. Change anytime from this screen.</span>
              </label>
              <label>Location email<input className="field" name="station_email" defaultValue={editLocation.station_email ?? ""} /></label>
              <label>Parent Location<SearchableSelect name="parent_station_id" options={parentStationOptions} defaultValue={editLocation.parent_station_id ?? ""} placeholder="Select parent location" /></label>
              <label>Status
                <select className="select" name="is_active" defaultValue={editLocation.is_active ? "active" : "inactive"}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </label>
              <label className="check-row span-3">
                <input defaultChecked={editLocation.hide_from_location_list} name="hide_from_location_list" type="checkbox" />
                <span>Hide from location list</span>
              </label>
              <div className="form-actions span-3">
                <SubmitButton>Save changes</SubmitButton>
                <Link className="button secondary" href="/master/location" scroll={false}>Cancel</Link>
              </div>
            </form>
            <div style={{ borderTop: "1px solid var(--border)", display: "flex", justifyContent: "flex-end", padding: "16px 18px" }}>
              <form action={deleteLocation}>
                <input type="hidden" name="id" value={editLocation.id} />
                <SubmitButton
                  className="button danger location-delete-button"
                  pendingText="Deleting"
                  confirmTitle="Delete location"
                  confirmDescription="Please confirm before deleting this location."
                  confirmMessage={`Delete ${editLocation.station_code}? This cannot be undone.`}
                  confirmSubmitText="Delete location"
                >
                  Delete location
                </SubmitButton>
              </form>
            </div>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}
