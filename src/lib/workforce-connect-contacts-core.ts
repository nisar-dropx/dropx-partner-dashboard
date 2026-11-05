export type WorkforceConnectContactPerson = {
  name: string;
  role: string | null;
  phone: string | null;
  email: string | null;
};

export type WorkforceConnectContactContext = {
  associate: WorkforceConnectContactPerson;
  clusterName: string | null;
  teamLeads: WorkforceConnectContactPerson[];
  clusterManagers: WorkforceConnectContactPerson[];
};

export type ContactSource = {
  mobile_country_code?: string | null;
  mobile?: string | null;
  email?: string | null;
};

export function workforceContactPhone(source: ContactSource | null | undefined) {
  const mobile = String(source?.mobile ?? "").replace(/\D/g, "");
  if (!mobile) return null;
  const country = String(source?.mobile_country_code ?? "91").replace(/\D/g, "") || "91";
  const local = mobile.startsWith(country) && mobile.length > 10 ? mobile.slice(country.length) : mobile;
  const readable = local.length === 10 ? `${local.slice(0, 5)} ${local.slice(5)}` : local;
  return `+${country} ${readable}`;
}

export function workforceContactEmail(source: ContactSource | null | undefined) {
  const email = String(source?.email ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function workforceContactValues(
  name: string,
  role: string | null,
  primary?: ContactSource | null,
  fallback?: ContactSource | null,
): WorkforceConnectContactPerson {
  return {
    name,
    role,
    phone: workforceContactPhone(primary) ?? workforceContactPhone(fallback),
    email: workforceContactEmail(primary) ?? workforceContactEmail(fallback),
  };
}
